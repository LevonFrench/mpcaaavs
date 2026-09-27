// OSC client — the browser half.
//
// A page cannot open a UDP socket, so the dev server (`tools/serve.mjs`) binds
// 127.0.0.1:9000, decodes OSC packets and forwards them as JSON text frames
// over a WebSocket at `/osc`. This module is the consumer of that feed and
// nothing else: it never parses OSC itself, because the bridge already did.
//
// The bridge is optional. If it is not running — the public build, or a
// `python -m http.server` — this must be invisible. Every failure path here
// ends in a status string and a backoff timer, never a throw and never a
// console error storm.

import { clamp01, type InputEmitter, type InputEvent } from './events.ts';

export type OscStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'disabled';

/** What the bridge sends. Anything that does not match this shape is dropped. */
interface OscBridgeMessage {
  readonly address?: unknown;
  readonly args?: unknown;
}

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;

/**
 * Normalise one OSC argument to 0..1.
 *
 * Control surfaces (TouchOSC, Lemur, Max) almost always send faders as 0..1
 * floats already, so a value inside that range is taken as-is. A larger number
 * is assumed to be a 7-bit MIDI-style value, which is the only other convention
 * common enough to guess at; anything wilder clamps rather than distorting the
 * whole range for one outlier.
 */
function normalizeOscValue(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (raw >= 0 && raw <= 1) return raw;
  return clamp01(raw / 127);
}

export class OscBridge {
  status: OscStatus = 'idle';
  message = '';
  /** Count of forwarded packets. The panel shows it as proof the feed is live. */
  received = 0;
  private socket: WebSocket | null = null;
  private retryMs = FIRST_RETRY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly bus: InputEmitter,
    private readonly url: string,
    private readonly onChange: () => void = () => {},
  ) {}

  connect(): void {
    if (this.disposed || this.socket) return;
    if (typeof WebSocket !== 'function') {
      this.setStatus('disabled', 'WebSocket unavailable');
      return;
    }
    this.setStatus('connecting', '');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      // A blocked mixed-content or CSP connection throws synchronously.
      this.setStatus('closed', error instanceof Error ? error.message : String(error));
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.retryMs = FIRST_RETRY_MS;
      this.setStatus('open', '');
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data === 'string') this.ingest(event.data);
    });
    socket.addEventListener('error', () => {
      // Deliberately silent: a missing bridge fires this on every attempt and
      // the close handler below is what actually drives the retry.
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setStatus('closed', 'bridge not running');
      this.scheduleRetry();
    });
  }

  /** Mark the bridge unreachable without attempting a connection. */
  disable(reason: string): void {
    this.setStatus('disabled', reason);
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private setStatus(status: OscStatus, message: string): void {
    this.status = status;
    this.message = message;
    this.onChange();
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer !== null) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(MAX_RETRY_MS, Math.round(this.retryMs * 1.8));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private ingest(text: string): void {
    let parsed: OscBridgeMessage;
    try { parsed = JSON.parse(text) as OscBridgeMessage; }
    catch { return; }
    const address = parsed.address;
    if (typeof address !== 'string' || !address) return;
    const args = Array.isArray(parsed.args) ? parsed.args : [];
    const numeric = args.find((arg): arg is number => typeof arg === 'number');
    const atMs = performance.now();
    const event: InputEvent = numeric === undefined
      ? { source: 'osc', kind: 'trigger', channel: 0, id: address, value: 1, atMs }
      : {
        source: 'osc',
        kind: 'cc',
        channel: 0,
        id: address,
        value: normalizeOscValue(numeric),
        raw: numeric,
        atMs,
      };
    this.received++;
    this.bus.emit(event);
  }
}

/**
 * Where to look for the bridge.
 *
 * The WebSocket is an upgrade on the dev server that already served the page,
 * so its host is the page's host — `ws://127.0.0.1:4300/osc` under `npm run
 * dev`. An explicit port is honoured for the case where the bridge was started
 * separately.
 */
export function oscBridgeUrl(port?: number): string {
  const host = port ? `127.0.0.1:${port}` : (location.host || '127.0.0.1:4300');
  return `ws://${host}/osc`;
}

/**
 * A `ws://` connection from an `https:` page is mixed content and is blocked
 * before it reaches the network. Detect that here so the panel can say why
 * instead of retrying forever against a wall.
 */
export function oscBridgeReachable(): boolean {
  return location.protocol !== 'https:';
}
