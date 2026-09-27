// WebMIDI adapter.
//
// Everything here is best-effort by design. Web MIDI is absent in Safari, gated
// behind a permission prompt in Chrome, and a controller can be unplugged
// mid-set. None of those three is an error the page should die on, so every
// failure path lands in `status`/`message` for the panel to display and nothing
// ever propagates out of this module.
//
// The adapter listens to EVERY input port by default and narrows only when a
// device is explicitly pinned. A performer who plugs in one controller should
// not have to choose it from a list first, and the pinned choice is what
// survives a reload.

import { normalize7bit, type InputEmitter, type InputEvent } from './events.ts';

const DEVICE_STORAGE_KEY = 'aaavs.input.midi-device.v1';

export type MidiStatus =
  | 'idle'
  | 'unsupported'
  | 'insecure'
  | 'requesting'
  | 'denied'
  | 'ready';

export interface MidiDeviceInfo {
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string;
  readonly connected: boolean;
}

const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const CONTROL_CHANGE = 0xb0;

function readStoredDevice(): string {
  try { return localStorage.getItem(DEVICE_STORAGE_KEY) ?? ''; }
  catch { return ''; }
}

function writeStoredDevice(id: string): void {
  try {
    if (id) localStorage.setItem(DEVICE_STORAGE_KEY, id);
    else localStorage.removeItem(DEVICE_STORAGE_KEY);
  } catch {
    // Private mode or a blocked origin. The choice simply does not persist.
  }
}

export class MidiInputs {
  status: MidiStatus = 'idle';
  /** Human-readable detail for whatever `status` says. Empty when there is nothing to add. */
  message = '';
  /** Empty string means "every attached input", which is the default. */
  private device = readStoredDevice();
  private access: MIDIAccess | null = null;
  private ports: MidiDeviceInfo[] = [];
  private readonly attached = new Set<MIDIInput>();
  private disposed = false;

  /**
   * `onChange` is a redraw hint for the panel, not a data channel — it fires on
   * status transitions and device arrival/removal, never per message.
   */
  constructor(
    private readonly bus: InputEmitter,
    private readonly onChange: () => void = () => {},
  ) {}

  get devices(): readonly MidiDeviceInfo[] {
    return this.ports;
  }

  get selectedId(): string {
    return this.device;
  }

  /** Request access. Safe to call more than once; only the first request runs. */
  async start(): Promise<void> {
    if (this.disposed || this.access || this.status === 'requesting') return;
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      this.setStatus('unsupported', 'navigator.requestMIDIAccess is not available in this browser');
      return;
    }
    // Chrome resolves the promise only on a secure origin. Say so up front
    // rather than surfacing a bare SecurityError.
    if (!globalThis.isSecureContext) {
      this.setStatus('insecure', 'Web MIDI needs https or a localhost origin');
      return;
    }
    this.setStatus('requesting', '');
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      if (this.disposed) return;
      this.access = access;
      access.addEventListener('statechange', this.onStateChange);
      this.setStatus('ready', '');
      this.refresh();
    } catch (error) {
      // A denied prompt and a policy block are the same shape here: no access,
      // and no reason to retry automatically.
      this.setStatus('denied', error instanceof Error ? error.message : String(error));
    }
  }

  /** Pin one input port by id, or pass `''` to listen to all of them. */
  select(id: string): void {
    if (id === this.device) return;
    this.device = id;
    writeStoredDevice(id);
    this.onChange();
  }

  dispose(): void {
    this.disposed = true;
    for (const port of this.attached) port.removeEventListener('midimessage', this.onMessage);
    this.attached.clear();
    this.access?.removeEventListener('statechange', this.onStateChange);
    this.access = null;
  }

  private setStatus(status: MidiStatus, message: string): void {
    this.status = status;
    this.message = message;
    this.onChange();
  }

  private readonly onStateChange = (): void => {
    if (this.disposed) return;
    this.refresh();
    this.onChange();
  };

  /**
   * Re-read the port list and make sure every connected port is listened to.
   *
   * `attached` holds exactly the ports that are present AND connected. A port
   * that vanished from `access.inputs`, or is still listed but `disconnected`,
   * loses its listener and its reference here — otherwise the set only ever
   * grows and every hot-plug of a session leaks one port and one closure. A
   * disconnected port that comes back is the SAME object in Chrome, so it is
   * simply re-attached (and re-opened) by the next refresh.
   */
  private refresh(): void {
    const access = this.access;
    if (!access) return;
    const next: MidiDeviceInfo[] = [];
    const live = new Set<MIDIInput>();
    for (const port of access.inputs.values()) {
      const connected = port.state === 'connected';
      next.push({
        id: port.id,
        name: port.name ?? port.id,
        manufacturer: port.manufacturer ?? '',
        connected,
      });
      if (!connected) continue;
      live.add(port);
      if (!this.attached.has(port)) {
        port.addEventListener('midimessage', this.onMessage);
        this.attached.add(port);
      }
      // Opening it again is what re-arms delivery after a replug.
      if (port.connection === 'closed') void port.open().catch(() => {});
    }
    for (const port of [...this.attached]) {
      if (live.has(port)) continue;
      port.removeEventListener('midimessage', this.onMessage);
      this.attached.delete(port);
    }
    next.sort((a, b) => a.name.localeCompare(b.name));
    this.ports = next;
  }

  private readonly onMessage = (event: MIDIMessageEvent): void => {
    const data = event.data;
    if (!data || data.length < 2) return;
    // `MIDIInput` as a constructor is only defined where the API exists, so the
    // port is narrowed by cast rather than by `instanceof`.
    const portId = (event.target as MIDIInput | null)?.id ?? '';
    if (this.device && portId && portId !== this.device) return;

    const statusByte = data[0] ?? 0;
    const type = statusByte & 0xf0;
    const channel = (statusByte & 0x0f) + 1;
    const first = data[1] ?? 0;
    const second = data[2] ?? 0;
    const atMs = performance.now();

    let normalised: InputEvent | null = null;
    if (type === CONTROL_CHANGE) {
      normalised = { source: 'midi', kind: 'cc', channel, id: first, value: normalize7bit(second), raw: second, atMs };
    } else if (type === NOTE_ON) {
      // Running-status note-off: velocity 0 on a note-on is a release.
      normalised = { source: 'midi', kind: 'note', channel, id: first, value: normalize7bit(second), raw: second, atMs };
    } else if (type === NOTE_OFF) {
      normalised = { source: 'midi', kind: 'note', channel, id: first, value: 0, raw: 0, atMs };
    }
    if (normalised) this.bus.emit(normalised);
  };
}
