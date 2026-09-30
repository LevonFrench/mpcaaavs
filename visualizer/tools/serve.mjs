// Dev server.
//
// The two COOP/COEP headers are the whole reason this exists rather than
// `python -m http.server`: they are what makes `crossOriginIsolated` true and
// therefore what makes SharedArrayBuffer available (plan §4.9). GitHub Pages
// cannot set them, so the public build intentionally uses the documented
// postMessage/main-analyser fallback while local development remains isolated.
//
// It also carries the OSC bridge (see the second half of this file), because a
// browser page cannot open a UDP socket and the alternative is a second process
// and a dependency. Both are hand-written on node builtins for the same reason
// the headers are here: one command, no install step.

import { createLibraryHandler } from './standalone-library.mjs';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 4300);
const oscPort = Number(process.env.AAAVS_OSC_PORT || 9000);
const isolationHeaders = process.env.NO_ISOLATION === '1' ? {} : {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8',
  '.svg':  'image/svg+xml',
};

// Private show asset packs (docs/design/ASSET-PACK-MANIFEST.md): the directory holding `<pack-id>/pack.json` folders, read-only through the
// library server. Chosen here, never by the page: `--show-packs <dir>`, else AAAVS_SHOW_PACKS, else the conventional show-assets-private/
// beside the page when it exists. With none of these the show-pack operations are refused.
const flag = process.argv.indexOf('--show-packs');
const conventional = resolve(root, 'show-assets-private');
const showPacks = flag >= 0 ? process.argv[flag + 1] : process.env.AAAVS_SHOW_PACKS || (existsSync(conventional) ? conventional : undefined);
if (flag >= 0 && !showPacks) { console.error('usage: --show-packs <directory>'); process.exit(2); }
const handleLibrary = createLibraryHandler(root, { showPacks });
const server = createServer(async (req, res) => {
  if (await handleLibrary(req, res)) return;
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = resolve(root, `.${rel}`);

  // Path traversal guard — never serve outside the project root.
  if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    ...isolationHeaders,
  });
  createReadStream(file).pipe(res);
});

// ---------------------------------------------------------------- OSC bridge
//
// UDP 127.0.0.1:9000 -> WebSocket /osc, as JSON `{address, args}`.
//
// This is a deliberately partial WebSocket server. It only ever SENDS, and the
// only client frame it has to understand is close, so there is no unmasking
// path, no fragment reassembly and no ping/pong. That is the entire reason it
// can be sixty lines of node builtins instead of a dependency. A frame arriving
// from the browser is inspected for the close opcode and otherwise ignored;
// anything more elaborate is a sign this outgrew its brief.
//
// Loopback only, in both directions. The UDP socket binds 127.0.0.1 so nothing
// off-machine can push events into a running show.
//
// And same-ORIGIN only on the WebSocket side. Browsers apply no same-origin
// policy to a WebSocket handshake, so without a check any other page open in
// the same browser could `new WebSocket('ws://127.0.0.1:4300/osc')` and read
// every live event the bridge forwards. A browser always sends `Origin` on a
// WebSocket upgrade and a page cannot forge or omit it, so the rule is:
//
//   - an `Origin` naming this server over loopback (127.0.0.1, localhost or
//     [::1], on the port actually bound) is accepted;
//   - any other `Origin` — another port, https, a public host, `null` from a
//     sandboxed frame or file:// page — is refused with 403;
//   - NO `Origin` at all is accepted, because only a non-browser client can
//     send that (a node script, websocat, a test harness), and a non-browser
//     client on this machine could equally read the UDP port itself. The
//     threat this closes is the cross-origin browser tab, not local processes.

// RFC 6455 §1.3. Verified against the RFC's own test vector rather than by
// eye: key `dGhlIHNhbXBsZSBub25jZQ==` must accept as
// `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`. A wrong constant here still produces a
// well-formed 101 that only the BROWSER rejects, so it cannot be caught by a
// harness that computes the expected value the same way this file does.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();

/** A single unfragmented, unmasked text frame. Server->client is never masked. */
function textFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x81; // FIN + opcode 1 (text)
  return Buffer.concat([header, payload]);
}

function dropClient(socket) {
  if (!clients.delete(socket)) return;
  try { socket.end(Buffer.from([0x88, 0x00])); } // close frame, no payload
  catch { /* already gone */ }
  socket.destroy();
}

/** Is this handshake from the page this server served (or from a non-browser client)? */
function oscOriginAllowed(origin) {
  if (origin === undefined) return true;
  const bound = server.address();
  const actual = typeof bound === 'object' && bound ? bound.port : port;
  return origin === `http://127.0.0.1:${actual}`
    || origin === `http://localhost:${actual}`
    || origin === `http://[::1]:${actual}`;
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/osc' || typeof key !== 'string') {
    socket.destroy();
    return;
  }
  // A repeated header arrives as an array; that is not a browser, and not ok.
  const origin = req.headers.origin;
  if (typeof origin === 'object' || !oscOriginAllowed(origin)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));
  socket.setNoDelay(true);
  clients.add(socket);

  socket.on('data', (chunk) => {
    // Opcode 8 is close. Every other client frame is of no interest here.
    if (chunk.length > 0 && (chunk[0] & 0x0f) === 0x08) dropClient(socket);
  });
  socket.on('close', () => { clients.delete(socket); });
  socket.on('error', () => { dropClient(socket); });
});

/** OSC-string: NUL-terminated, then padded with NULs to a 4-byte boundary. */
function readOscString(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  if (end < 0) return null;
  const value = buffer.toString('ascii', offset, end);
  return { value, next: offset + Math.ceil((value.length + 1) / 4) * 4 };
}

/**
 * Minimal OSC message decode: address, type tag, int32/float32 arguments.
 *
 * `s` and the argument-less `T`/`F` are handled too because they cost two lines
 * each and control surfaces send them. An unknown tag stops the walk rather
 * than guessing a width — after one wrong guess every later argument is
 * garbage, and a short argument list is a far better failure than a wrong one.
 * Bundles (`#bundle`) are not decoded; nothing that maps to a knob sends them.
 */
function decodeOscMessage(buffer) {
  const address = readOscString(buffer, 0);
  if (!address || !address.value.startsWith('/')) return null;
  const args = [];
  const tags = address.next < buffer.length ? readOscString(buffer, address.next) : null;
  if (!tags || !tags.value.startsWith(',')) return { address: address.value, args };

  let offset = tags.next;
  for (const tag of tags.value.slice(1)) {
    if (tag === 'i' || tag === 'f') {
      if (offset + 4 > buffer.length) break;
      args.push(tag === 'i' ? buffer.readInt32BE(offset) : buffer.readFloatBE(offset));
      offset += 4;
    } else if (tag === 's') {
      const text = readOscString(buffer, offset);
      if (!text) break;
      args.push(text.value);
      offset = text.next;
    } else if (tag === 'T' || tag === 'F') {
      args.push(tag === 'T' ? 1 : 0);
    } else {
      break;
    }
  }
  return { address: address.value, args };
}

const osc = createSocket({ type: 'udp4', reuseAddr: true });

osc.on('message', (message) => {
  if (!clients.size) return;
  const packet = decodeOscMessage(message);
  if (!packet) return;
  const frame = textFrame(JSON.stringify(packet));
  for (const socket of [...clients]) {
    try { socket.write(frame); }
    catch { dropClient(socket); }
  }
});

osc.on('error', (error) => {
  // A busy port is the common case (another OSC app already owns 9000). The
  // page degrades to MIDI-only, so this must never take the file server down.
  console.warn(`aaavs: OSC bridge unavailable — ${error.message}`);
  try { osc.close(); } catch { /* never bound */ }
});

// Both lines print the port actually bound, so `PORT=0` / `AAAVS_OSC_PORT=0`
// (an ephemeral port, which is what `tools/serve-osc-check.mjs` uses) still
// logs a usable address.
server.listen(port, '127.0.0.1', () => {
  const httpPort = server.address().port;
  console.log(`aaavs  →  http://127.0.0.1:${httpPort}`);
  if (showPacks) console.log(`aaavs show packs  →  ${resolve(showPacks)} (read-only, set with ?pack=<id> or localStorage mpcaaavs.showPack)`);
  osc.bind(oscPort, '127.0.0.1', () => {
    console.log(`aaavs osc  →  udp 127.0.0.1:${osc.address().port}  →  ws://127.0.0.1:${httpPort}/osc`);
  });
});
