// Regression check for the dev server's OSC bridge handshake (tools/serve.mjs).
//
// Spawns the REAL server on ephemeral ports (PORT=0, AAAVS_OSC_PORT=0), then
// drives raw WebSocket upgrade requests at /osc with a table of `Origin`
// headers and asserts which are switched (101) and which are refused (403).
// The refusals are the point: a cross-origin tab must not be able to read the
// live OSC stream. It also checks the RFC 6455 accept value against the RFC's
// own vector, and that a UDP packet reaches an accepted client as JSON.
//
// Exits non-zero on any mismatch. Run: node tools/serve-osc-check.mjs

import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { request } from 'node:http';
import { resolve } from 'node:path';

const RFC_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const RFC_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';

let checks = 0;
function assert(condition, label) {
  checks++;
  if (!condition) throw new Error(`serve-osc-check: FAIL — ${label}`);
}

/** Start serve.mjs and resolve with the ports it printed. */
function startServer() {
  const child = spawn(process.execPath, [resolve('tools/serve.mjs')], {
    env: { ...process.env, PORT: '0', AAAVS_OSC_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolvePorts, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 10000);
    const onData = (chunk) => {
      out += chunk.toString();
      const http = /aaavs\s+→\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      const udp = /udp 127\.0\.0\.1:(\d+)/.exec(out);
      if (http && udp) {
        clearTimeout(timer);
        resolvePorts({ child, httpPort: Number(http[1]), udpPort: Number(udp[1]) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
}

/**
 * One handshake. Resolves `{ status, accept, socket }` — status 101 when the
 * server switched protocols, the HTTP status otherwise, 0 when it hung up.
 */
function handshake(port, origin, key = RFC_KEY) {
  return new Promise((resolveResult) => {
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
    };
    if (origin !== undefined) headers.Origin = origin;
    const req = request({ host: '127.0.0.1', port, path: '/osc', headers });
    req.on('upgrade', (res, socket) => {
      resolveResult({ status: res.statusCode, accept: res.headers['sec-websocket-accept'], socket });
    });
    req.on('response', (res) => {
      res.resume();
      resolveResult({ status: res.statusCode ?? 0 });
    });
    req.on('error', () => resolveResult({ status: 0 }));
    req.setTimeout(5000, () => { req.destroy(); resolveResult({ status: 0 }); });
    req.end();
  });
}

/** Read one unmasked text frame (< 126 bytes payload is all this test sends). */
function nextTextFrame(socket) {
  return new Promise((resolveText, reject) => {
    const timer = setTimeout(() => reject(new Error('no frame within 3 s')), 3000);
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      if ((chunk[0] & 0x0f) !== 0x01) { reject(new Error(`opcode ${chunk[0] & 0x0f}`)); return; }
      const length = chunk[1] & 0x7f;
      resolveText(chunk.subarray(2, 2 + length).toString('utf8'));
    });
  });
}

/** `/aaavs/test` with one int32 argument, 7. */
function oscPacket() {
  const pad = (text) => {
    const raw = Buffer.from(`${text}\0`, 'ascii');
    return Buffer.concat([raw, Buffer.alloc((4 - (raw.length % 4)) % 4)]);
  };
  const arg = Buffer.alloc(4);
  arg.writeInt32BE(7, 0);
  return Buffer.concat([pad('/aaavs/test'), pad(',i'), arg]);
}

const { child, httpPort, udpPort } = await startServer();
const open = [];
try {
  const accepted = [
    [`http://127.0.0.1:${httpPort}`, 'loopback IPv4 origin'],
    [`http://localhost:${httpPort}`, 'localhost origin'],
    [`http://[::1]:${httpPort}`, 'loopback IPv6 origin'],
    [undefined, 'missing Origin (non-browser client)'],
  ];
  const refused = [
    ['http://evil.example', 'foreign host'],
    [`http://127.0.0.1:${httpPort + 1}`, 'loopback on another port'],
    [`https://127.0.0.1:${httpPort}`, 'https scheme on the right port'],
    [`http://127.0.0.1:${httpPort}.evil.example`, 'suffix trick'],
    [`http://localhost.evil.example:${httpPort}`, 'prefix trick'],
    ['null', 'opaque origin (sandboxed frame / file://)'],
    ['', 'empty Origin header'],
  ];

  for (const [origin, label] of accepted) {
    const result = await handshake(httpPort, origin);
    assert(result.status === 101, `${label} should switch protocols, got ${result.status}`);
    assert(result.accept === RFC_ACCEPT, `${label}: Sec-WebSocket-Accept must match the RFC 6455 vector`);
    if (result.socket) open.push(result.socket);
  }
  for (const [origin, label] of refused) {
    const result = await handshake(httpPort, origin);
    // Negative assertions: each of these MUST be refused.
    assert(result.status !== 101, `${label} must NOT be upgraded`);
    assert(result.status === 403, `${label} should be refused with 403, got ${result.status}`);
  }

  // End to end: a UDP packet reaches an accepted client as `{address, args}`.
  const client = open[0];
  assert(Boolean(client), 'an accepted socket is available for the forward test');
  const framePromise = nextTextFrame(client);
  const udp = createSocket('udp4');
  await new Promise((done) => udp.send(oscPacket(), udpPort, '127.0.0.1', () => done()));
  udp.close();
  const packet = JSON.parse(await framePromise);
  assert(packet.address === '/aaavs/test', `forwarded address, got ${packet.address}`);
  assert(Array.isArray(packet.args) && packet.args[0] === 7, `forwarded int32 argument, got ${JSON.stringify(packet.args)}`);

  console.log(`serve-osc-check: PASS (${checks} assertions)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  for (const socket of open) socket.destroy();
  child.removeAllListeners('exit');
  child.kill();
}
