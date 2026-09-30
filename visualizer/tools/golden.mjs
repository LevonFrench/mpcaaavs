// Golden-image driver (plan §11 Phase 0).
//
// Serves the app, drives a real browser through it in golden mode, pulls the
// captured PNG back over the DevTools protocol, and diffs it against a
// committed baseline. The in-page half of this lives in `src/testkit.ts`; this
// file is deliberately the dumb half, because everything interesting about
// determinism happens inside the render loop and not out here.
//
//   node tools/golden.mjs                        compare against the baseline
//   node tools/golden.mjs --update               (re)write the baseline
//   node tools/golden.mjs --name kaleido --frames 240 --seed 7 --bpm 174
//
// Constraints it is written under, all of them deliberate:
//
//   * NODE BUILTINS ONLY. No puppeteer, no pngjs, no pixelmatch. Plan §4.9 says
//     no new dependencies, and a test harness that drags in a browser-automation
//     stack is a larger liability than the thing it tests. So: Chrome's native
//     DevTools pipe plus a tiny JSON-frame transport, and ~150 lines of PNG
//     codec below.
//   * REUSE `tools/serve.mjs`. It sets COOP/COEP, which is what makes
//     `crossOriginIsolated` true (README). A second, simpler server here would
//     serve the app in a subtly different environment from the one it ships in,
//     and the first thing that would break is `SharedArrayBuffer`.
//   * NEVER BUILD. If `dist/main.js` is missing this says so and stops, rather
//     than running esbuild behind your back and reporting on a bundle you did
//     not ask for.
//
// On tolerance: the comparison is per-pixel-per-channel with a small absolute
// threshold, plus a cap on how many pixels may exceed it. Two thresholds rather
// than one because the two failure modes are different shapes — a global
// brightness shift moves every pixel a little, and a broken layer moves a few
// pixels a lot. A single averaged metric hides both.
//
// On what a red run means: see the honesty section at the top of
// `src/testkit.ts`. Baselines are machine-local. A new GPU, a driver update or
// a Chrome upgrade is a legitimate reason for a diff, and the right response is
// to look at the diff image and then `--update`, not to widen the tolerance
// until it passes.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const goldenDir = join(root, 'tools', 'golden');

// ---------------------------------------------------------------- arguments

const args = parseArgs(process.argv.slice(2));
const opt = {
  name: str('name', 'default'),
  frames: int('frames', 120),
  seed: int('seed', 1),
  bpm: num('bpm', 128),
  fps: int('fps', 60),
  width: 512,
  height: 512,
  tolerance: int('tolerance', 4),        // per channel, 0..255
  maxDiff: num('max-diff', 0.002),       // fraction of pixels allowed to exceed it
  port: int('port', 4399),
  cdpPort: int('cdp-port', 9399),
  timeout: int('timeout', 90) * 1000,
  update: flag('update'),
  headful: flag('headful'),
  swiftshader: flag('swiftshader'),
  keep: flag('keep'),
  transitionTest: flag('transition-test'),
  ledStyle: str('led-style', ''),
  uiTest: flag('ui-test'),
  preset: str('preset', ''),
  source: str('source', ''),
  operator: str('operator', ''),
  capture: str('capture', ''),
  uiCapture: str('ui-capture', ''),
};
{
  const size = str('size', '512x512');
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) fail(`--size must look like 512x512, got "${size}"`);
  opt.width = Number(m[1]);
  opt.height = Number(m[2]);
}

function parseArgs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`unexpected argument "${a}"`);
    const eq = a.indexOf('=');
    if (eq > 0) { out.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out.set(a.slice(2), next); i++; }
    else out.set(a.slice(2), true);
  }
  return out;
}
function str(k, d) { const v = args.get(k); return v === undefined || v === true ? d : String(v); }
function num(k, d) { const v = args.get(k); if (v === undefined || v === true) return d; const n = Number(v); return Number.isFinite(n) ? n : d; }
function int(k, d) { return Math.round(num(k, d)); }
function flag(k) { return args.get(k) === true || args.get(k) === 'true'; }
function fail(msg) { console.error(`golden: ${msg}`); process.exit(2); }

// ---------------------------------------------------------------- PNG codec
//
// Enough of the format to round-trip what Chrome's `toDataURL` produces: 8-bit,
// non-interlaced, colour type 2 (RGB) or 6 (RGBA). Anything else is rejected
// loudly rather than silently mis-decoded, because a decoder that guesses turns
// an image bug into an image-comparison bug and the two look identical from
// here.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @returns {{width:number,height:number,data:Buffer}} data is RGBA, 4 bytes per pixel. */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  let p = 8;
  let width = 0, height = 0, channels = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8], colorType = body[9], interlace = body[12];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth} (need 8)`);
      if (interlace !== 0) throw new Error('interlaced PNG is not supported');
      if (colorType === 6) channels = 4;
      else if (colorType === 2) channels = 3;
      else throw new Error(`unsupported colour type ${colorType} (need 2 or 6)`);
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  if (!width || !height) throw new Error('PNG has no IHDR');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  let q = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[q++];
    raw.copy(line, 0, q, q + stride);
    q += stride;
    unfilter(filter, line, prev, channels);
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    line.copy(prev);
  }
  return { width, height, data: out };
}

function unfilter(filter, line, prev, bpp) {
  const n = line.length;
  switch (filter) {
    case 0: return;
    case 1: for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff; return;
    case 2: for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 0xff; return;
    case 3:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pr) & 0xff;
      }
      return;
    default: throw new Error(`unknown PNG filter ${filter}`);
  }
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Encode RGBA. Filter 0 on every line — deflate does the work and the output only has to be readable, not small. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- comparison

function compare(baseline, actual, tolerance) {
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return { sizeMismatch: true, differing: -1, worst: -1, diff: null };
  }
  const { width, height } = baseline;
  const diff = Buffer.alloc(width * height * 4);
  let differing = 0, worst = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(baseline.data[o + c] - actual.data[o + c]));
    if (d > worst) worst = d;
    if (d > tolerance) {
      differing++;
      // Red on the offenders. Everything else is the baseline dimmed to a
      // quarter, so the shape of the frame stays legible around the damage —
      // a pure black-and-white difference mask tells you how much changed and
      // nothing at all about where in the picture you are.
      diff[o] = 255; diff[o + 1] = 0; diff[o + 2] = 0; diff[o + 3] = 255;
    } else {
      diff[o] = baseline.data[o] >> 2;
      diff[o + 1] = baseline.data[o + 1] >> 2;
      diff[o + 2] = baseline.data[o + 2] >> 2;
      diff[o + 3] = 255;
    }
  }
  return { sizeMismatch: false, differing, worst, diff, total: width * height, width, height };
}

// ---------------------------------------------------------------- browser

const CHROME_CANDIDATES = [
  process.env.AAAVS_CHROME,
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  fail(
    'no Chrome found. Set AAAVS_CHROME to a Chrome or Edge executable.\n' +
    '  WebGPU is required, so Firefox and Safari are not substitutes here.',
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}${lastErr ? ` (${lastErr.message})` : ''}`);
}

/**
 * Minimal CDP client. One socket, one page target, request/response by id.
 *
 * The ordering below is not optional and cost an hour to find. Attaching to a
 * freshly created tab and calling `Runtime.evaluate` straight away lands in the
 * tab's INITIAL about:blank context, not the page you asked for. That context
 * is not a secure context, so `navigator.gpu` is undefined there and the whole
 * thing reports "this machine has no WebGPU" on a machine that plainly does —
 * or, if the navigation happens to have started, "Cannot find default execution
 * context". So: open at about:blank, enable Page and Runtime, THEN navigate,
 * then wait for the load event, and only then evaluate anything.
 */
/**
 * Minimal RFC 6455 client for Chrome DevTools. Node 24's global WebSocket can
 * finish Chrome's handshake yet never deliver CDP replies on this Windows host;
 * using the underlying loopback TCP connection avoids that version-specific
 * failure without adding an automation dependency.
 */
class CdpSocket {
  constructor(socket, initial = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = initial;
    this.listeners = new Map([['message', []], ['close', []]]);
    socket.on('data', (data) => this.receive(data));
    socket.on('close', () => this.emit('close', { code: 1006, reason: '' }));
    socket.on('error', () => this.emit('close', { code: 1006, reason: '' }));
    if (initial.length) this.receive(Buffer.alloc(0));
  }

  static connect(url) {
    const endpoint = new URL(url);
    const port = Number(endpoint.port || 80);
    const key = randomBytes(16).toString('base64');
    const expected = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: endpoint.hostname, port });
      let pending = Buffer.alloc(0);
      const abort = (error) => { socket.destroy(); reject(error); };
      socket.once('error', abort);
      socket.on('connect', () => {
        socket.write([
          `GET ${endpoint.pathname}${endpoint.search} HTTP/1.1`,
          `Host: ${endpoint.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          'Origin: http://127.0.0.1',
          '', '',
        ].join('\r\n'));
      });
      socket.on('data', (data) => {
        pending = Buffer.concat([pending, data]);
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) return;
        const header = pending.subarray(0, end).toString('utf8');
        const accept = /^sec-websocket-accept:\s*(.+)$/im.exec(header)?.[1]?.trim();
        if (!header.startsWith('HTTP/1.1 101') || accept !== expected) {
          abort(new Error(`invalid CDP WebSocket handshake: ${header.split('\r\n')[0] ?? 'no response'}`));
          return;
        }
        socket.removeListener('error', abort);
        socket.removeAllListeners('data');
        resolve(new CdpSocket(socket, pending.subarray(end + 4)));
      });
    });
  }

  addEventListener(type, listener) { this.listeners.get(type)?.push(listener); }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2)); offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      const opcode = first & 0x0f;
      if (opcode === 0x1) {
        const text = payload.toString('utf8');
        if (process.env.AAAVS_CDP_DEBUG) console.error(`cdp <- ${text}`);
        this.emit('message', { data: text });
      }
      else if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        this.emit('close', { code, reason: payload.subarray(2).toString('utf8') });
        this.socket.destroy();
        return;
      } else if (opcode === 0x9) this.frame(0xA, payload);
    }
  }

  frame(opcode, payload) {
    const mask = randomBytes(4);
    const length = payload.length;
    const head = length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | length])
      : Buffer.from([0x80 | opcode, 0x80 | 126, (length >>> 8) & 0xff, length & 0xff]);
    const body = Buffer.alloc(length);
    for (let i = 0; i < length; i++) body[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([head, mask, body]));
  }

  send(text) {
    if (process.env.AAAVS_CDP_DEBUG) console.error(`cdp -> ${text}`);
    this.frame(0x1, Buffer.from(text));
  }
  close() { this.socket.destroy(); }
}

/** Chrome's --remote-debugging-pipe protocol: NUL-delimited JSON frames. */
class CdpPipe {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.buffer = Buffer.alloc(0);
    this.listeners = new Map([['message', []], ['close', []]]);
    output.on('data', (data) => this.receive(data));
    output.on('close', () => this.emit('close', { code: 1006, reason: '' }));
    output.on('error', () => this.emit('close', { code: 1006, reason: '' }));
  }

  addEventListener(type, listener) { this.listeners.get(type)?.push(listener); }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (true) {
      const end = this.buffer.indexOf(0);
      if (end < 0) return;
      const text = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      if (process.env.AAAVS_CDP_DEBUG) console.error(`cdp <- ${text}`);
      this.emit('message', { data: text });
    }
  }

  send(text) {
    if (process.env.AAAVS_CDP_DEBUG) console.error(`cdp -> ${text}`);
    const payload = Buffer.from(text);
    this.input.write(Buffer.concat([payload, Buffer.from([0])]));
  }

  close() { this.input.destroy(); this.output.destroy(); }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    /** Uncaught in-page exceptions, so a boot failure is reported rather than timing out. */
    this.exceptions = [];
    /** Console errors/warnings, including asynchronous WebGPU compilation info. */
    this.consoleMessages = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Target.receivedMessageFromTarget') {
        const nested = JSON.parse(msg.params.message);
        if (nested.id !== undefined) {
          const p = this.pending.get(`target:${nested.id}`);
          if (!p) return;
          this.pending.delete(`target:${nested.id}`);
          if (nested.error) p.reject(new Error(`${nested.error.message} (${nested.error.code})`));
          else p.resolve(nested.result);
          return;
        }
        this.events.push(nested.method);
        if (nested.method === 'Runtime.exceptionThrown') {
          const d = nested.params?.exceptionDetails;
          this.exceptions.push(d?.exception?.description ?? d?.text ?? 'unknown exception');
        }
        if (nested.method === 'Runtime.consoleAPICalled') {
          const kind = nested.params?.type ?? 'log';
          if (kind === 'error' || kind === 'warning') {
            const values = (nested.params?.args ?? []).map((a) => a.value ?? a.description ?? '').filter(Boolean);
            this.consoleMessages.push(`[${kind}] ${values.join(' ')}`);
          }
        }
        return;
      }
      if (msg.id === undefined) {
        this.events.push(msg.method);
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params?.exceptionDetails;
          this.exceptions.push(d?.exception?.description ?? d?.text ?? 'unknown exception');
        }
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
    });
    ws.addEventListener('close', (ev) => {
      const why = `CDP socket closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`;
      for (const pending of this.pending.values()) pending.reject(new Error(why));
      this.pending.clear();
    });
  }
  static async connect(url) {
    return new Cdp(await CdpSocket.connect(url));
  }
  send(method, params = {}, timeoutMs = 15_000) {
    const id = ++this.id;
    // `waitFor()` cannot enforce its deadline while its callback awaits a CDP
    // response. If Chrome's renderer wedges, a single unanswered evaluate used
    // to leave the golden runner alive forever. Put the deadline on the request
    // itself so every phase can fail with the command that stalled. Register
    // before sending: loopback CDP can answer quickly enough to otherwise lose
    // the first reply between `send()` and `pending.set()`.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(this.sessionId ? { sessionId: this.sessionId } : {}) }));
    });
  }

  /** Send a command into the page target through the stable, non-flat protocol. */
  sendTarget(method, params = {}, timeoutMs = 15_000) {
    const id = (this.targetId ?? 0) + 1;
    this.targetId = id;
    return new Promise((resolve, reject) => {
      const key = `target:${id}`;
      const timer = setTimeout(() => {
        if (this.pending.delete(key)) reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(key, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      void this.send('Target.sendMessageToTarget', {
        sessionId: this.targetSessionId,
        message: JSON.stringify({ id, method, params }),
      }).catch((error) => {
        if (this.pending.delete(key)) { clearTimeout(timer); reject(error); }
      });
    });
  }
  /** Enable the domains, navigate, and wait for the real page context to exist. */
  async open(url, timeoutMs) {
    await this.sendTarget('Page.enable');
    await this.sendTarget('Runtime.enable');
    await this.sendTarget('Page.navigate', { url });
    await waitFor('page load', async () => this.events.includes('Page.loadEventFired'), timeoutMs);
  }
  /** Evaluate and return the value. Throws on an in-page exception rather than returning undefined. */
  async eval(expr) {
    const r = await this.sendTarget('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

// ---------------------------------------------------------------- run

async function main() {
  if (!existsSync(join(root, 'dist', 'main.js'))) {
    fail('dist/main.js is missing. Run `npm run build` first — this tool will not build for you.');
  }
  mkdirSync(goldenDir, { recursive: true });

  const cleanup = [];
  // Latched, and iterating a COPY. `cleanup.reverse()` reverses in place, and
  // on Ctrl-C this ran twice — once from the signal handler, once from the
  // `exit` it triggers — so the second pass ran the list back in forward order
  // and deleted the browser profile before killing the browser holding it.
  let cleaned = false;
  const done = () => {
    if (cleaned) return;
    cleaned = true;
    for (const fn of [...cleanup].reverse()) { try { fn(); } catch { /* best effort */ } }
  };
  process.on('exit', done);
  process.on('SIGINT', () => { done(); process.exit(130); });

  // --- 1. the real dev server, with the real COOP/COEP headers -------------
  const server = spawn(process.execPath, [join(root, 'tools', 'serve.mjs')], {
    env: { ...process.env, PORT: String(opt.port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  cleanup.push(() => server.kill());
  const base = `http://127.0.0.1:${opt.port}`;
  await waitFor('dev server', async () => (await fetch(`${base}/index.html`)).ok, 15000);

  // --- 2. the browser ------------------------------------------------------
  const chrome = findChrome();
  const profile = join(tmpdir(), `aaavs-golden-${process.pid}`);
  if (!opt.keep) cleanup.push(() => rmSync(profile, { recursive: true, force: true }));

  const chromeArgs = [
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    `--window-size=${opt.width},${opt.height}`,
    // DPR 1, always. The app multiplies canvas size by devicePixelRatio, and a
    // baseline captured on a 150%-scaled display is a different picture from
    // the same code on a 100% one.
    '--force-device-scale-factor=1',
    '--enable-unsafe-webgpu',
    // The GPU child runs under a second Windows sandbox. In this desktop
    // sandbox that process is denied its graphics device and dies with
    // STATUS_ACCESS_DENIED before CDP can create a page. The golden browser is
    // already temporary, headless, loopback-only and local-content-only.
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    // Golden mode renders headless and offscreen, and rAF in a backgrounded or
    // occluded window is throttled to ~1 Hz. That does not change the pixels —
    // the timestep is fixed — but it turns a 2-second capture into a 2-minute
    // one and looks exactly like a hang.
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--hide-scrollbars',
    '--mute-audio',
    '--enable-logging=stderr',
  ];
  // SwiftShader is a SOFTWARE rasteriser. It makes a headless run possible on a
  // machine with no usable GPU, and it produces different pixels from hardware —
  // so a baseline captured under it is only comparable with other SwiftShader
  // runs. Opt in explicitly; never fall back to it silently.
  if (opt.swiftshader) {
    // `enable-unsafe-swiftshader` merely permits the software renderer; it does
    // not select it. Force ANGLE to choose SwiftShader so a broken hardware GPU
    // cannot crash Chrome before the test page has a chance to boot.
    chromeArgs.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  }
  if (!opt.headful) chromeArgs.push('--headless=new');

  const browser = spawn(chrome, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let chromeStderr = '';
  browser.stderr.on('data', (d) => { chromeStderr += d.toString(); });
  cleanup.push(() => browser.kill());

  const query = new URLSearchParams({
    golden: '1',
    frames: String(opt.frames),
    seed: String(opt.seed),
    bpm: String(opt.bpm),
    fps: String(opt.fps),
    w: String(opt.width),
    h: String(opt.height),
  });
  if (opt.transitionTest) query.set('transitionTest', '1');
  if (opt.ledStyle) query.set('ledStyleTest', opt.ledStyle);
  if (opt.uiTest) query.set('uiTest', '1');
  if (opt.preset) query.set('presetTest', opt.preset);
  if (opt.source) query.set('sourceTest', opt.source);
  if (opt.operator) query.set('operatorTest', opt.operator);
  const pageUrl = `${base}/index.html?${query}`;

  const cdp = new Cdp(new CdpPipe(browser.stdio[3], browser.stdio[4]));
  try {
    await waitFor('CDP pipe', async () => {
      try { return await cdp.send('Browser.getVersion'); } catch { return null; }
    }, 30_000);
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    await cdp.send('Target.activateTarget', { targetId: target.targetId });
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId });
    cdp.targetSessionId = attached.sessionId;
    await cdp.open(pageUrl, 30000);
    const isolated = await cdp.eval('self.crossOriginIsolated');
    const expectedIsolation = process.env.NO_ISOLATION !== '1';
    if (isolated !== expectedIsolation) {
      throw new Error(`isolation smoke failed: expected ${expectedIsolation}, got ${isolated}`);
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`could not initialise CDP: ${detail}\nChrome said:\n${chromeStderr || '(no browser diagnostics)'}`);
  }
  cleanup.push(() => cdp.close());

  // --- 3. wait for the capture --------------------------------------------
  // Poll a summary, never the image: the data URL is hundreds of kilobytes and
  // shipping it across the wire twice a second for a minute is pure waste.
  let status;
  try {
    status = await waitFor('golden capture', async () => {
      const s = await cdp.eval(`(() => {
        const g = window.__aaavsGolden;
        if (!g) return null;
        return { ready: !!g.ready, error: g.error || '', rendered: g.rendered | 0 };
      })()`);
      if (s && (s.ready || s.error)) return s;
      return null;
    }, opt.timeout);
  } catch (e) {
    // A timeout with a pending exception is almost always a boot failure —
    // report the exception, because "timed out" on its own sends you looking
    // in entirely the wrong place.
    if (cdp.exceptions.length) {
      console.error(`golden: the page threw before capturing:\n  ${cdp.exceptions.join('\n  ')}`);
    } else {
      console.error(
        `golden: ${e.message}\n` +
        `  window.__aaavsGolden never became ready. Is main.ts wired to src/testkit.ts?`,
      );
    }
    return 1;
  }

  if (status.error) {
    console.error(`golden: the page failed after ${status.rendered} frames:\n${status.error}`);
    return 1;
  }
  const gpuStderr = chromeStderr.includes('WebGPU') || chromeStderr.includes('Validation');
  if (cdp.consoleMessages.length || gpuStderr) {
    const page = cdp.consoleMessages.length
      ? `\nPage console:\n  ${cdp.consoleMessages.join('\n  ')}`
      : '';
    const browser = gpuStderr ? `\nBrowser GPU diagnostics:\n${chromeStderr}` : '';
    fail(`shader/WebGPU diagnostics are a failed capture.${page}${browser}`);
  }

  const dataUrl = await cdp.eval('window.__aaavsGolden.png');
  const b64 = String(dataUrl).split(',')[1] ?? '';
  if (!b64) fail('the page reported ready but produced no image data');
  const actualBuf = Buffer.from(b64, 'base64');

  if (opt.capture) {
    const capturePath = resolve(opt.capture);
    writeFileSync(capturePath, actualBuf);
    console.log(`golden: captured ${capturePath}`);
    return 0;
  }

  if (opt.uiTest) {
    const picker = await cdp.eval(`(() => {
      const select = document.querySelector('#aaavs-ui select.ui-preset-select');
      if (!(select instanceof HTMLSelectElement)) return null;
      const option = select.options[0];
      const style = option ? getComputedStyle(option) : null;
      return {
        names: [...select.options].map((o) => o.value),
        color: style?.color ?? '', background: style?.backgroundColor ?? '',
      };
    })()`);
    const expectedNames = [
      'cathode-orbit', 'flux-cartography', 'harmonic-specimen', 'quasicrystal-scan',
      'cathedral-drive', 'eclipse-transit', 'moire-terminal', 'signal-architecture',
      'vortex-manuscript', 'botanical-signal', 'paper-attractor', 'black-water-loom',
      'prism-overload', 'fold-engine', 'temporal-array', 'eclipse-drop',
    ];
    if (!picker || picker.names.join('|') !== expectedNames.join('|') || picker.color === '' || picker.background === '') {
      fail(`preset picker smoke failed: ${JSON.stringify(picker)}`);
    }
    if (opt.uiCapture) {
      const capturePath = resolve(opt.uiCapture);
      const page = await cdp.sendTarget('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(capturePath, Buffer.from(page.data, 'base64'));
      console.log(`golden: captured UI ${capturePath}`);
    }
    console.log(`golden: PASS preset picker smoke (${picker.names.join(', ')})`);
    return 0;
  }

  // This path deliberately changes the frame at 108 to exercise the two-chain
  // composite. It validates a real capture, but has no stable default-image
  // baseline to compare against and must never overwrite one.
  if (opt.transitionTest || opt.ledStyle) {
    const label = opt.transitionTest ? 'transition' : `LED ${opt.ledStyle}`;
    console.log(`golden: PASS ${label} smoke (${opt.frames} frames)`);
    return 0;
  }

  // --- 4. compare ----------------------------------------------------------
  const baselinePath = join(goldenDir, `${opt.name}.png`);
  const actualPath = join(goldenDir, `${opt.name}.actual.png`);
  const diffPath = join(goldenDir, `${opt.name}.diff.png`);

  if (opt.update || !existsSync(baselinePath)) {
    writeFileSync(baselinePath, actualBuf);
    const why = opt.update ? 'updated on request' : 'NO BASELINE EXISTED, so one has been written';
    console.log(
      `golden: ${why}\n` +
      `  ${baselinePath}\n` +
      `  ${opt.frames} frames @ ${opt.fps} fps, seed ${opt.seed}, ${opt.bpm} BPM, ${opt.width}x${opt.height}\n` +
      `  This run proved nothing — it only recorded what the code does today.`,
    );
    return 0;
  }

  const baseline = decodePng(readFileSync(baselinePath));
  const actual = decodePng(actualBuf);
  const r = compare(baseline, actual, opt.tolerance);

  if (r.sizeMismatch) {
    writeFileSync(actualPath, actualBuf);
    console.error(
      `golden: FAIL — size changed. baseline ${baseline.width}x${baseline.height}, ` +
      `got ${actual.width}x${actual.height}\n  wrote ${actualPath}`,
    );
    return 1;
  }

  const fraction = r.differing / r.total;
  const label =
    `${r.differing}/${r.total} px (${(fraction * 100).toFixed(4)}%) over tolerance ${opt.tolerance}, ` +
    `worst channel delta ${r.worst}`;

  if (fraction <= opt.maxDiff) {
    rmSync(diffPath, { force: true });
    rmSync(actualPath, { force: true });
    console.log(`golden: PASS  ${opt.name}  ${label}`);
    return 0;
  }

  writeFileSync(actualPath, actualBuf);
  writeFileSync(diffPath, encodePng(r.width, r.height, r.diff));
  console.error(
    `golden: FAIL  ${opt.name}  ${label}\n` +
    `  allowed ${(opt.maxDiff * 100).toFixed(4)}%\n` +
    `  baseline ${baselinePath}\n` +
    `  actual   ${actualPath}\n` +
    `  diff     ${diffPath}   (red = over tolerance)\n` +
    `  If this is a GPU, driver or browser change rather than a code change,\n` +
    `  that is expected — see src/testkit.ts — and the fix is --update, not a\n` +
    `  bigger --tolerance.`,
  );
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => { console.error(`golden: ${e.stack ?? e.message ?? e}`); process.exit(2); },
);
