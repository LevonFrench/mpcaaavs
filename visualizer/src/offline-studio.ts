/**
 * Full-screen control surface for deterministic whole-track rendering.
 *
 * The studio intentionally owns presentation and draft state only. The offline
 * engine is injected through promise-friendly callbacks, keeping the sample
 * clock, renderer and encoders out of the DOM layer.
 */

const DEFAULT_STYLE_HREF = new URL('./offline-studio.css', import.meta.url).href;

export type OfflineRenderMode = 'preset' | 'auto';
export type OfflinePresetKind = 'bundled' | 'local' | 'personal' | 'aaavs' | 'custom';
export type OfflineJobStatus =
  | 'idle'
  | 'analyzing'
  | 'ready'
  | 'rendering'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface OfflineOutputProfile {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly fpsNum: number;
  readonly fpsDen: number;
  readonly purpose: string;
  readonly authority?: boolean;
  /** Browser render is available now; post-render outputs require the CLI. */
  readonly availability?: 'browser' | 'post-render';
}

export interface OfflinePresetOption {
  readonly id: string;
  readonly name: string;
  readonly collection: string;
  readonly kind?: Exclude<OfflinePresetKind, 'custom'>;
  readonly available?: boolean;
  readonly unavailableReason?: string;
}

export interface OfflineTrackSummary {
  readonly name: string;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly totalSamplesPerChannel: number;
  readonly sha256?: string;
  readonly waveform?: Float32Array | readonly number[];
}

export interface OfflineValidationItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly status: 'pending' | 'working' | 'passed' | 'warning' | 'failed';
}

export interface OfflineRenderResult {
  readonly outputPath?: string;
  readonly frameCount: number;
  readonly durationSeconds: number;
  readonly manifestSha256?: string;
  readonly proxyPath?: string;
}

export interface OfflineProgress {
  readonly stage: string;
  readonly completedFrames: number;
  readonly totalFrames: number;
  readonly elapsedSeconds: number;
  readonly etaSeconds?: number;
  readonly throughputFps?: number;
  readonly encodeFps?: number;
  readonly queueDepth?: number;
  readonly gpuMs?: number;
  /** Which pipeline stage limits throughput; shown in place of GPU p50 when no GPU timing exists. */
  readonly boundBy?: string;
}

export interface OfflineStudioDraft {
  readonly audioFile: File | null;
  readonly mode: OfflineRenderMode;
  readonly presetKind: OfflinePresetKind;
  readonly presetId: string | null;
  readonly customPresetFile: File | null;
  readonly profileId: string;
  readonly seed: number;
  readonly bpm: number | null;
  readonly meter: string;
  readonly downbeatSample: number;
  readonly outputDirectoryHandle: unknown | null;
  readonly outputPath: string;
  readonly includePngSequence: boolean;
  readonly includeAudio: boolean;
  readonly generateProxy: boolean;
  readonly runProbe: boolean;
  readonly buildMinimaxSegments: boolean;
  /** Opt-in linear-light preset crossfades; off keeps the historical sRGB integer mix. */
  readonly linearLightTransitions: boolean;
  /**
   * Opt-in photosensitive flash limiting of the exported frames ('limit'
   * mode). Off by default so exports stay byte-identical; recorded in the
   * manifest either way.
   */
  readonly flashLimitFrames: boolean;
}

export interface OfflineStudioState {
  readonly status: OfflineJobStatus;
  readonly track: OfflineTrackSummary | null;
  readonly progress: OfflineProgress;
  readonly validation: readonly OfflineValidationItem[];
  readonly result: OfflineRenderResult | null;
  readonly error: string | null;
  readonly canResume: boolean;
}

export interface OfflineStudioOptions {
  readonly presets?: readonly OfflinePresetOption[];
  readonly profiles?: readonly OfflineOutputProfile[];
  readonly initialDraft?: Partial<OfflineStudioDraft>;
  readonly initialState?: Partial<OfflineStudioState>;
  readonly styleHref?: string;
  readonly onAnalyzeTrack?: (file: File) => void | OfflineTrackSummary | Promise<void | OfflineTrackSummary>;
  readonly onDraftChange?: (draft: OfflineStudioDraft) => void;
  readonly onStart?: (draft: OfflineStudioDraft) => void | Promise<void>;
  readonly onPause?: () => void | Promise<void>;
  readonly onResume?: () => void | Promise<void>;
  readonly onCancel?: () => void | Promise<void>;
  readonly onChooseOutputDirectory?: () => unknown | Promise<unknown>;
  readonly onRevealOutput?: (result: OfflineRenderResult) => void | Promise<void>;
  readonly onSeekPreview?: (frame: number, sample: number) => void | Promise<void>;
}

export interface OfflineStudioController {
  readonly root: HTMLElement;
  readonly previewCanvas: HTMLCanvasElement;
  open(): void;
  close(): void;
  toggle(): void;
  dispose(): void;
  isOpen(): boolean;
  getDraft(): OfflineStudioDraft;
  setDraft(patch: Partial<OfflineStudioDraft>): void;
  setPresets(presets: readonly OfflinePresetOption[]): void;
  getState(): OfflineStudioState;
  setState(patch: Partial<OfflineStudioState>): void;
  updateProgress(patch: Partial<OfflineProgress>): void;
  setWaveform(samples: Float32Array | readonly number[]): void;
  appendLog(message: string, tone?: 'info' | 'success' | 'warning' | 'error'): void;
  clearLogs(): void;
}

export const OFFLINE_OUTPUT_PROFILES: readonly OfflineOutputProfile[] = [
  { id: 'minimax-anchor-736x416-24', label: 'MiniMax anchor', width: 736, height: 416, fpsNum: 24, fpsDen: 1, purpose: 'Authoritative PNG + WAV package', authority: true },
  { id: 'minimax-review-736x416-24', label: 'MiniMax review', width: 736, height: 416, fpsNum: 24, fpsDen: 1, purpose: 'H.264 review proxy · CLI post-render', availability: 'post-render' },
  { id: 'archive-lossless-736x416-24', label: 'Lossless archive', width: 736, height: 416, fpsNum: 24, fpsDen: 1, purpose: 'FFV1 Matroska preservation · CLI post-render', availability: 'post-render' },
  { id: 'minimax-selector-416x256-24', label: 'MiniMax 0.1 MP', width: 416, height: 256, fpsNum: 24, fpsDen: 1, purpose: 'Diagnostic selector canvas' },
  { id: 'minimax-selector-608x352-24', label: 'MiniMax 0.2 MP', width: 608, height: 352, fpsNum: 24, fpsDen: 1, purpose: 'Lightweight H3 canvas' },
  { id: 'minimax-selector-864x480-24', label: 'MiniMax 0.4 MP', width: 864, height: 480, fpsNum: 24, fpsDen: 1, purpose: 'Higher-pixel experiment' },
  { id: 'minimax-selector-960x544-24', label: 'MiniMax 0.5 MP', width: 960, height: 544, fpsNum: 24, fpsDen: 1, purpose: 'Experimental selector canvas' },
  { id: 'minimax-selector-1056x608-24', label: 'MiniMax 0.6 MP', width: 1056, height: 608, fpsNum: 24, fpsDen: 1, purpose: 'Experimental selector canvas' },
  { id: 'minimax-selector-1216x672-24', label: 'MiniMax 0.8 MP', width: 1216, height: 672, fpsNum: 24, fpsDen: 1, purpose: 'Experimental selector canvas' },
  { id: 'minimax-selector-1376x768-24', label: 'MiniMax 1.0 MP', width: 1376, height: 768, fpsNum: 24, fpsDen: 1, purpose: 'High-memory selector canvas' },
  { id: 'true-16x9-compact', label: 'True 16:9 compact', width: 768, height: 432, fpsNum: 24, fpsDen: 1, purpose: 'Exact 16:9 AAAVS export' },
  { id: 'exact2x-review', label: 'Exact 2× review', width: 1472, height: 832, fpsNum: 24, fpsDen: 1, purpose: 'Exact 2× canonical raster' },
  { id: 'hd-delivery', label: 'HD delivery', width: 1920, height: 1080, fpsNum: 24, fpsDen: 1, purpose: 'Presentation conform' },
  { id: 'qhd-performance-60', label: 'QHD performance · 60', width: 2560, height: 1440, fpsNum: 60, fpsDen: 1, purpose: 'Performance qualification' },
  { id: 'qhd-performance-120', label: 'QHD performance · 120', width: 2560, height: 1440, fpsNum: 120, fpsDen: 1, purpose: '120 fps stress qualification' },
] as const;

const EMPTY_PROGRESS: OfflineProgress = {
  stage: 'Awaiting source', completedFrames: 0, totalFrames: 0, elapsedSeconds: 0,
};

const DEFAULT_DRAFT: OfflineStudioDraft = {
  audioFile: null,
  mode: 'preset',
  presetKind: 'bundled',
  presetId: null,
  customPresetFile: null,
  profileId: 'minimax-anchor-736x416-24',
  seed: 1,
  bpm: null,
  meter: '4/4',
  downbeatSample: 0,
  outputDirectoryHandle: null,
  outputPath: '',
  includePngSequence: true,
  includeAudio: true,
  generateProxy: false,
  runProbe: false,
  buildMinimaxSegments: true,
  linearLightTransitions: false,
  flashLimitFrames: false,
};

const DEFAULT_STATE: OfflineStudioState = {
  status: 'idle',
  track: null,
  progress: EMPTY_PROGRESS,
  validation: [],
  result: null,
  error: null,
  canResume: false,
};

function ensureStylesheet(href: string): void {
  if (document.querySelector(`link[data-aaavs-offline-studio="${CSS.escape(href)}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.aaavsOfflineStudio = href;
  document.head.append(link);
}

function element<T extends keyof HTMLElementTagNameMap>(tag: T, className = '', text = ''): HTMLElementTagNameMap[T] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function cloneDraft(draft: OfflineStudioDraft): OfflineStudioDraft { return { ...draft }; }
function cloneState(state: OfflineStudioState): OfflineStudioState {
  return { ...state, progress: { ...state.progress }, validation: [...state.validation] };
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0 ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

class Studio implements OfflineStudioController {
  readonly root: HTMLElement;
  readonly previewCanvas: HTMLCanvasElement;
  private readonly options: OfflineStudioOptions;
  private readonly profiles: readonly OfflineOutputProfile[];
  private presets: readonly OfflinePresetOption[];
  private draft: OfflineStudioDraft;
  private state: OfflineStudioState;
  private waveform: Float32Array | readonly number[] = new Float32Array(0);
  private readonly timelineCanvas: HTMLCanvasElement;
  private readonly fileInput: HTMLInputElement;
  private readonly presetFileInput: HTMLInputElement;
  private readonly statusPill: HTMLElement;
  private readonly trackName: HTMLElement;
  private readonly trackMeta: HTMLElement;
  private readonly trackHash: HTMLElement;
  private readonly dropZone: HTMLElement;
  private readonly presetSelect: HTMLSelectElement;
  private readonly customPresetName: HTMLElement;
  private readonly profileSelect: HTMLSelectElement;
  private readonly profileRaster: HTMLElement;
  private readonly profileClock: HTMLElement;
  private readonly frameInterval: HTMLElement;
  private readonly frameCount: HTMLElement;
  private readonly outputName: HTMLElement;
  private readonly renderButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly progressFill: HTMLElement;
  private readonly progressTrack: HTMLElement;
  private readonly progressLabel: HTMLElement;
  private readonly progressPct: HTMLElement;
  private readonly etaValue: HTMLElement;
  private readonly throughputValue: HTMLElement;
  private readonly queueValue: HTMLElement;
  private readonly gpuValue: HTMLElement;
  private readonly gpuLabel: HTMLElement;
  private readonly validationList: HTMLElement;
  private readonly resultPanel: HTMLElement;
  private readonly errorPanel: HTMLElement;
  private readonly logList: HTMLElement;
  private readonly previewSlate: HTMLElement;
  private readonly previewFrame: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;
  private lastFocus: Element | null = null;
  private logSequence = 0;

  constructor(options: OfflineStudioOptions) {
    this.options = options;
    this.profiles = options.profiles?.length ? options.profiles : OFFLINE_OUTPUT_PROFILES;
    this.presets = options.presets ?? [];
    this.draft = { ...DEFAULT_DRAFT, ...options.initialDraft };
    this.state = {
      ...DEFAULT_STATE,
      ...options.initialState,
      progress: { ...EMPTY_PROGRESS, ...options.initialState?.progress },
      validation: options.initialState?.validation ? [...options.initialState.validation] : [],
    };
    if (!this.profiles.some((profile) => profile.id === this.draft.profileId)) this.draft = { ...this.draft, profileId: this.profiles[0]?.id ?? '' };

    ensureStylesheet(options.styleHref ?? DEFAULT_STYLE_HREF);
    this.root = element('section', 'offline-studio');
    this.root.id = 'aaavs-offline-studio';
    this.root.hidden = true;
    this.root.tabIndex = -1;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'offline-studio-title');
    this.root.innerHTML = this.template();
    document.body.append(this.root);

    this.previewCanvas = this.need('canvas[data-role="preview"]');
    this.timelineCanvas = this.need('canvas[data-role="timeline"]');
    this.fileInput = this.need('input[data-role="audio-file"]');
    this.presetFileInput = this.need('input[data-role="preset-file"]');
    this.statusPill = this.need('[data-role="status"]');
    this.trackName = this.need('[data-role="track-name"]');
    this.trackMeta = this.need('[data-role="track-meta"]');
    this.trackHash = this.need('[data-role="track-hash"]');
    this.dropZone = this.need('[data-role="drop-zone"]');
    this.presetSelect = this.need('select[data-role="preset"]');
    this.customPresetName = this.need('[data-role="custom-preset-name"]');
    this.profileSelect = this.need('select[data-role="profile"]');
    this.profileRaster = this.need('[data-role="profile-raster"]');
    this.profileClock = this.need('[data-role="profile-clock"]');
    this.frameInterval = this.need('[data-role="frame-interval"]');
    this.frameCount = this.need('[data-role="frame-count"]');
    this.outputName = this.need('[data-role="output-name"]');
    this.renderButton = this.need('button[data-action="render"]');
    this.pauseButton = this.need('button[data-action="pause"]');
    this.cancelButton = this.need('button[data-action="cancel"]');
    this.progressFill = this.need('[data-role="progress-fill"]');
    this.progressTrack = this.need('[data-role="progress-track"]');
    this.progressLabel = this.need('[data-role="progress-label"]');
    this.progressPct = this.need('[data-role="progress-pct"]');
    this.etaValue = this.need('[data-role="eta"]');
    this.throughputValue = this.need('[data-role="throughput"]');
    this.queueValue = this.need('[data-role="queue"]');
    this.gpuValue = this.need('[data-role="gpu"]');
    this.gpuLabel = this.need('[data-role="gpu-label"]');
    this.validationList = this.need('[data-role="validation"]');
    this.resultPanel = this.need('[data-role="result"]');
    this.errorPanel = this.need('[data-role="error"]');
    this.logList = this.need('[data-role="logs"]');
    this.previewSlate = this.need('[data-role="preview-slate"]');
    this.previewFrame = this.need('[data-role="preview-frame"]');

    this.populatePresets();
    this.populateProfiles();
    this.bind();
    this.resizeObserver = new ResizeObserver(() => this.drawTimeline());
    this.resizeObserver.observe(this.timelineCanvas);
    this.render();
  }

  open(): void {
    if (!this.root.hidden) return;
    this.lastFocus = document.activeElement;
    this.root.hidden = false;
    document.documentElement.classList.add('offline-studio-open');
    requestAnimationFrame(() => {
      this.root.focus();
      this.drawTimeline();
    });
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    document.documentElement.classList.remove('offline-studio-open');
    if (this.lastFocus instanceof HTMLElement) this.lastFocus.focus();
  }

  toggle(): void { this.root.hidden ? this.open() : this.close(); }
  isOpen(): boolean { return !this.root.hidden; }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.documentElement.classList.remove('offline-studio-open');
    this.root.remove();
  }

  getDraft(): OfflineStudioDraft { return cloneDraft(this.draft); }
  setDraft(patch: Partial<OfflineStudioDraft>): void {
    this.draft = { ...this.draft, ...patch };
    this.options.onDraftChange?.(this.getDraft());
    this.render();
  }

  setPresets(presets: readonly OfflinePresetOption[]): void {
    this.presets = presets;
    this.populatePresets();
    this.renderDraft();
  }

  getState(): OfflineStudioState { return cloneState(this.state); }
  setState(patch: Partial<OfflineStudioState>): void {
    this.state = {
      ...this.state,
      ...patch,
      progress: patch.progress ? { ...patch.progress } : this.state.progress,
      validation: patch.validation ? [...patch.validation] : this.state.validation,
    };
    if (patch.track?.waveform) this.waveform = patch.track.waveform;
    this.render();
  }

  updateProgress(patch: Partial<OfflineProgress>): void {
    this.state = { ...this.state, progress: { ...this.state.progress, ...patch } };
    this.renderProgress();
    this.drawTimeline();
  }

  setWaveform(samples: Float32Array | readonly number[]): void {
    this.waveform = samples;
    this.drawTimeline();
  }

  appendLog(message: string, tone: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    const row = element('li', `offline-log is-${tone}`);
    const sequence = element('span', 'offline-log-sequence', String(++this.logSequence).padStart(3, '0'));
    const time = element('time', 'offline-log-time', new Date().toLocaleTimeString([], { hour12: false }));
    row.append(sequence, time, element('span', 'offline-log-message', message));
    this.logList.append(row);
    while (this.logList.childElementCount > 250) this.logList.firstElementChild?.remove();
    this.logList.scrollTop = this.logList.scrollHeight;
  }

  clearLogs(): void { this.logList.replaceChildren(); this.logSequence = 0; }

  private need<T extends Element>(selector: string): T {
    const found = this.root.querySelector<T>(selector);
    if (!found) throw new Error(`Offline studio is missing ${selector}`);
    return found;
  }

  private template(): string {
    return `
      <header class="offline-mast">
        <div class="offline-wordmark">
          <span class="offline-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <div><h1 id="offline-studio-title">AAAVS <em>transfer</em></h1><p>sample-clock offline render studio</p></div>
        </div>
        <div class="offline-master-clock" aria-label="Canonical clock"><span>MASTER CLOCK</span><b>48,000</b><small>samples / sec</small></div>
        <span class="offline-status" data-role="status">Idle</span>
        <button class="offline-icon-button" data-action="close" type="button" aria-label="Close offline render studio" title="Close (Escape)">×</button>
      </header>

      <div class="offline-workbench">
        <aside class="offline-rail offline-source-rail" aria-label="Source and preset setup">
          <section class="offline-panel offline-source-panel">
            <header><span class="offline-section-code">SOURCE / A</span><h2>Track authority</h2></header>
            <button class="offline-drop" data-role="drop-zone" type="button">
              <span class="offline-drop-icon" aria-hidden="true">↧</span>
              <strong>Load an audio track</strong>
              <span>Drop WAV, FLAC, MP3, M4A, or OGG</span>
              <small>Decoded once · normalized to 48 kHz</small>
            </button>
            <input data-role="audio-file" class="offline-visually-hidden" type="file" accept="audio/*,.wav,.flac,.mp3,.m4a,.ogg" />
            <div class="offline-track-card" aria-live="polite">
              <span class="offline-track-reel" aria-hidden="true"></span>
              <div><strong data-role="track-name">No source loaded</strong><span data-role="track-meta">Awaiting immutable analysis buffer</span><code data-role="track-hash">SHA-256 —</code></div>
            </div>
          </section>

          <section class="offline-panel">
            <header><span class="offline-section-code">PROGRAM / B</span><h2>Preset schedule</h2></header>
            <div class="offline-segmented" role="group" aria-label="Preset schedule mode">
              <button type="button" data-mode="preset">Fixed preset</button>
              <button type="button" data-mode="auto">Auto director</button>
            </div>
            <label class="offline-field"><span>Preset bank</span><select data-role="preset"></select></label>
            <div class="offline-file-row">
              <button class="offline-secondary-button" data-action="load-preset" type="button">Load custom .avs</button>
              <span data-role="custom-preset-name">No custom preset</span>
            </div>
            <input data-role="preset-file" class="offline-visually-hidden" type="file" accept=".avs,application/octet-stream" />
            <div class="offline-grid-fields">
              <label class="offline-field"><span>Seed</span><input data-field="seed" type="number" min="0" step="1" inputmode="numeric" /></label>
              <label class="offline-field"><span>Reviewed BPM · required</span><input data-field="bpm" type="number" min="20" max="400" step=".01" placeholder="enter tempo" inputmode="decimal" required /></label>
              <label class="offline-field"><span>Meter</span><select data-field="meter"><option>4/4</option><option>3/4</option><option>5/4</option><option>6/8</option><option>7/8</option></select></label>
              <label class="offline-field"><span>Downbeat sample</span><input data-field="downbeat" type="number" min="0" step="1" inputmode="numeric" /></label>
            </div>
            <p class="offline-note"><span>LOCK</span> Schedule decisions resolve before frame 000000. No wall-clock timing or frame skipping.</p>
          </section>
        </aside>

        <main class="offline-picture" aria-label="Offline render preview">
          <section class="offline-monitor">
            <header class="offline-monitor-head"><span>PROGRAM MONITOR</span><span data-role="preview-frame">F 000000 · S 000000000</span></header>
            <div class="offline-monitor-stage">
              <canvas data-role="preview" width="736" height="416" aria-label="Offline render preview"></canvas>
              <div class="offline-safe-area" aria-hidden="true"></div>
              <div class="offline-preview-slate" data-role="preview-slate"><b>NO TRACK</b><span>Load source to build frame ledger</span></div>
              <span class="offline-monitor-badge">RGB24</span>
            </div>
            <footer><span data-role="profile-raster">736 × 416</span><span>sRGB · progressive · square pixel</span><span>feedback reset at F0</span></footer>
          </section>

          <section class="offline-timeline" aria-label="Sample-accurate output frame ruler">
            <header>
              <div><span class="offline-section-code">FRAME LEDGER</span><h2>Every frame owns an exact audio interval</h2></div>
              <div class="offline-ledger-readout"><span data-role="profile-clock">24 / 1 fps</span><b data-role="frame-interval">2,000 samples / frame</b></div>
            </header>
            <canvas data-role="timeline" height="176" tabindex="0" aria-label="Waveform and output frame filmstrip. Click to inspect a frame."></canvas>
            <footer><span>audio authority <b>sample 0</b></span><span data-role="frame-count">0 frames resolved</span><span>end boundary <b>—</b></span></footer>
          </section>
        </main>

        <aside class="offline-rail offline-output-rail" aria-label="Output and validation setup">
          <section class="offline-panel offline-profile-panel">
            <header><span class="offline-section-code">OUTPUT / C</span><h2>Render profile</h2></header>
            <label class="offline-field"><span>Profile</span><select data-role="profile"></select></label>
            <dl class="offline-profile-spec">
              <div><dt>Raster</dt><dd data-role="profile-raster">736 × 416</dd></div>
              <div><dt>Frame clock</dt><dd data-role="profile-clock">24 / 1 fps</dd></div>
              <div><dt>Color</dt><dd>RGB24 / sRGB</dd></div>
              <div><dt>Scan</dt><dd>Progressive</dd></div>
            </dl>
            <div class="offline-output-dir"><span>Output directory</span><button data-action="directory" type="button"><b data-role="output-name">Choose folder</b><small>package is never silently overwritten</small></button></div>
            <div class="offline-checks">
              <label class="is-required" title="Required for every transactional browser package"><input data-toggle="png" type="checkbox" disabled /> <span>RGB24 PNG frame sequence</span></label>
              <label class="is-required" title="Required for every transactional browser package"><input data-toggle="audio" type="checkbox" disabled /> <span>48 kHz stereo PCM WAV</span></label>
              <label class="is-required" title="Required for every transactional browser package"><input type="checkbox" checked disabled /> <span>Manifest + SHA-256 inventory</span></label>
              <label class="is-required" title="Required for every transactional browser package"><input data-toggle="segments" type="checkbox" disabled /> <span>Features · events · anchors · segments</span></label>
              <label title="Opt-in. Auto-director crossfades mix in linear light instead of 8-bit sRGB codes; recorded in the manifest"><input data-toggle="linear-transitions" type="checkbox" /> <span>Linear-light crossfades · opt-in</span></label>
              <label title="Opt-in. Deterministically limits photosensitive flashes (WCAG general and red flash) in the written frames; changes pixels and is recorded in the manifest"><input data-toggle="flash-limit" type="checkbox" /> <span>Flash limiting · opt-in</span></label>
              <label class="is-unavailable" title="Available from the render:proxy CLI after the browser package completes"><input data-toggle="proxy" type="checkbox" disabled /> <span>H.264 proxy · CLI post-render</span></label>
              <label class="is-unavailable" title="Planned for the render:probe CLI"><input data-toggle="probe" type="checkbox" disabled /> <span>ffprobe report · future CLI</span></label>
            </div>
          </section>

          <section class="offline-panel offline-preflight-panel">
            <header><span class="offline-section-code">PREFLIGHT / D</span><h2>Authority checks</h2></header>
            <ul class="offline-validation" data-role="validation"></ul>
            <div class="offline-error" data-role="error" hidden></div>
            <button class="offline-render-button" data-action="render" type="button"><span>Render complete track</span><small>deterministic fixed-step pass</small></button>
          </section>

          <section class="offline-result" data-role="result" hidden>
            <span class="offline-section-code">VALIDATED PACKAGE</span><strong>Render complete</strong><p></p><button data-action="reveal" type="button">Reveal output</button>
          </section>
        </aside>

        <section class="offline-deck" aria-label="Render queue and diagnostics">
          <div class="offline-job">
            <header><span class="offline-live-dot" aria-hidden="true"></span><div><span>RENDER QUEUE / JOB 01</span><strong data-role="progress-label">Awaiting source</strong></div><b data-role="progress-pct">0.0%</b></header>
            <div class="offline-progress-track" data-role="progress-track" role="progressbar" aria-label="Offline render progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i data-role="progress-fill"></i><span></span><span></span><span></span></div>
            <div class="offline-job-controls">
              <button data-action="pause" type="button" disabled>Pause</button>
              <button data-action="cancel" type="button" disabled>Cancel render</button>
            </div>
          </div>
          <dl class="offline-metrics">
            <div><dt>ETA</dt><dd data-role="eta">—</dd></div>
            <div><dt>Render</dt><dd data-role="throughput">— fps</dd></div>
            <div><dt>Queue</dt><dd data-role="queue">0 frames</dd></div>
            <div><dt data-role="gpu-label">GPU p50</dt><dd data-role="gpu">— ms</dd></div>
          </dl>
          <div class="offline-log-panel"><header><span>PROCESS LOG</span><button data-action="clear-log" type="button">Clear</button></header><ol data-role="logs"></ol></div>
        </section>
      </div>`;
  }

  private populatePresets(): void {
    this.presetSelect.replaceChildren();
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const preset of this.presets) {
      let group = groups.get(preset.collection);
      if (!group) {
        group = document.createElement('optgroup');
        group.label = preset.collection;
        groups.set(preset.collection, group);
        this.presetSelect.append(group);
      }
      const option = element('option');
      option.value = `${preset.kind ?? 'bundled'}:${preset.id}`;
      option.disabled = preset.available === false;
      option.textContent = `${preset.name}${preset.available === false ? ' · unavailable' : ''}`;
      if (preset.unavailableReason) option.title = preset.unavailableReason;
      group.append(option);
    }
    if (!this.presetSelect.options.length) {
      const option = element('option', '', 'No preset catalog connected');
      option.value = '';
      this.presetSelect.append(option);
    }
  }

  private populateProfiles(): void {
    this.profileSelect.replaceChildren();
    for (const profile of this.profiles) {
      const postRender = profile.availability === 'post-render'
        || profile.id === 'minimax-review-736x416-24'
        || profile.id === 'archive-lossless-736x416-24'
        || profile.id === 'exact2x-review'
        || profile.id === 'hd-delivery';
      const option = element('option');
      option.value = profile.id;
      option.disabled = postRender;
      option.textContent = `${profile.label} — ${profile.width}×${profile.height} / ${profile.fpsNum} fps${profile.authority ? ' · AUTHORITY' : ''}${postRender ? ' · CLI ONLY' : ''}`;
      this.profileSelect.append(option);
    }
  }

  private bind(): void {
    this.need('button[data-action="close"]').addEventListener('click', () => this.close());
    this.dropZone.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => { const file = this.fileInput.files?.[0]; if (file) void this.acceptTrack(file); });
    for (const type of ['dragenter', 'dragover'] as const) this.dropZone.addEventListener(type, (event) => { event.preventDefault(); this.dropZone.classList.add('is-dragging'); });
    for (const type of ['dragleave', 'drop'] as const) this.dropZone.addEventListener(type, (event) => { event.preventDefault(); this.dropZone.classList.remove('is-dragging'); });
    this.dropZone.addEventListener('drop', (event) => { const file = event.dataTransfer?.files[0]; if (file) void this.acceptTrack(file); });

    this.need('button[data-action="load-preset"]').addEventListener('click', () => this.presetFileInput.click());
    this.presetFileInput.addEventListener('change', () => {
      const file = this.presetFileInput.files?.[0];
      if (!file) return;
      this.setDraft({ customPresetFile: file, presetKind: 'custom', presetId: null, mode: 'preset' });
      this.appendLog(`Custom preset loaded: ${file.name}`, 'success');
    });

    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-mode]')) button.addEventListener('click', () => this.setDraft({ mode: button.dataset.mode as OfflineRenderMode }));
    this.presetSelect.addEventListener('change', () => {
      const [kind, ...id] = this.presetSelect.value.split(':');
      const presetKind: OfflinePresetKind = kind === 'local' || kind === 'personal' || kind === 'aaavs'
        ? kind
        : 'bundled';
      this.setDraft({ presetKind, presetId: id.join(':') || null, customPresetFile: null });
    });
    this.profileSelect.addEventListener('change', () => this.setDraft({ profileId: this.profileSelect.value }));

    this.bindNumber('seed', (value) => this.setDraft({ seed: Math.max(0, Math.floor(value ?? 1)) }));
    this.bindNumber('bpm', (value) => this.setDraft({ bpm: value }));
    this.bindNumber('downbeat', (value) => this.setDraft({ downbeatSample: Math.max(0, Math.floor(value ?? 0)) }));
    this.need<HTMLSelectElement>('select[data-field="meter"]').addEventListener('change', (event) => this.setDraft({ meter: (event.currentTarget as HTMLSelectElement).value }));

    for (const [name, key] of [['png', 'includePngSequence'], ['audio', 'includeAudio'], ['proxy', 'generateProxy'], ['probe', 'runProbe'], ['segments', 'buildMinimaxSegments'], ['linear-transitions', 'linearLightTransitions'], ['flash-limit', 'flashLimitFrames']] as const) {
      this.need<HTMLInputElement>(`input[data-toggle="${name}"]`).addEventListener('change', (event) => this.setDraft({ [key]: (event.currentTarget as HTMLInputElement).checked }));
    }

    this.need('button[data-action="directory"]').addEventListener('click', () => void this.chooseDirectory());
    this.renderButton.addEventListener('click', () => void this.start());
    this.pauseButton.addEventListener('click', () => void (this.state.status === 'paused' ? this.resume() : this.pause()));
    this.cancelButton.addEventListener('click', () => void this.cancel());
    this.need('button[data-action="clear-log"]').addEventListener('click', () => this.clearLogs());
    this.need('button[data-action="reveal"]').addEventListener('click', () => { if (this.state.result) void this.options.onRevealOutput?.(this.state.result); });

    this.timelineCanvas.addEventListener('pointerdown', (event) => void this.seekFromPointer(event));
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); this.close(); }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void this.start(); }
      if (event.key === 'Tab') this.trapFocus(event);
    });
  }

  private bindNumber(field: string, callback: (value: number | null) => void): void {
    this.need<HTMLInputElement>(`input[data-field="${field}"]`).addEventListener('change', (event) => {
      const raw = (event.currentTarget as HTMLInputElement).value;
      callback(raw === '' ? null : Number(raw));
    });
  }

  private async acceptTrack(file: File): Promise<void> {
    if (!file.type.startsWith('audio/') && !/\.(wav|flac|mp3|m4a|ogg)$/i.test(file.name)) {
      this.appendLog(`${file.name} is not a supported audio source`, 'error');
      return;
    }
    this.setDraft({ audioFile: file });
    this.setState({ status: 'analyzing', error: null, result: null, track: { name: file.name, durationSeconds: 0, sampleRate: 48_000, channels: 2, totalSamplesPerChannel: 0 } });
    this.appendLog(`Analyzing ${file.name} (${formatBytes(file.size)})`);
    try {
      const analyzed = await this.options.onAnalyzeTrack?.(file);
      if (analyzed) this.setState({ track: analyzed, status: 'ready' });
      else if (!this.options.onAnalyzeTrack) this.setState({ status: 'ready' });
      this.appendLog('Source analysis frozen to sample clock', 'success');
    } catch (error) {
      this.setState({ status: 'failed', track: null, error: error instanceof Error ? error.message : String(error) });
      this.appendLog(`Analysis failed: ${String(error)}`, 'error');
    }
  }

  private async chooseDirectory(): Promise<void> {
    try {
      let handle = await this.options.onChooseOutputDirectory?.();
      if (handle === undefined && 'showDirectoryPicker' in window) {
        handle = await (window as Window & { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker();
      }
      if (handle !== undefined && handle !== null) {
        const name = typeof handle === 'object' && 'name' in handle ? String(handle.name) : 'Selected output';
        this.setDraft({ outputDirectoryHandle: handle, outputPath: name });
        this.appendLog(`Output directory armed: ${name}`, 'success');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.setState({ error: error instanceof Error ? error.message : String(error) });
      this.appendLog(`Could not select output: ${String(error)}`, 'error');
    }
  }

  private async start(): Promise<void> {
    if (!this.draft.audioFile || !this.state.track) {
      this.setState({ error: 'Load and analyze an audio track before rendering.' });
      this.dropZone.focus();
      return;
    }
    if (this.draft.mode === 'preset' && !this.draft.presetId && !this.draft.customPresetFile) {
      this.setState({ error: 'Choose a bundled AVS preset or a custom .avs file.' });
      this.presetSelect.focus();
      return;
    }
    if (this.draft.bpm === null || !(this.draft.bpm > 0)) {
      this.setState({ error: 'Enter the reviewed track BPM before rendering. AAAVS will not claim an unreviewed fallback tempo.' });
      this.need<HTMLInputElement>('input[data-field="bpm"]').focus();
      return;
    }
    if (!this.draft.outputDirectoryHandle) {
      this.setState({ error: 'Choose an empty output directory before rendering the frame-complete package.' });
      this.need<HTMLButtonElement>('button[data-action="directory"]').focus();
      return;
    }
    this.setState({ status: 'rendering', error: null, result: null, progress: { ...this.state.progress, stage: 'Preparing deterministic ledger' } });
    this.appendLog(`Render started · ${this.activeProfile()?.label ?? this.draft.profileId} · seed ${this.draft.seed}`);
    try {
      await this.options.onStart?.(this.getDraft());
    } catch (error) {
      if (this.state.status === 'cancelled' || (error instanceof DOMException && error.name === 'AbortError')) {
        this.setState({ status: 'cancelled', error: null, canResume: false });
        return;
      }
      this.setState({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
      this.appendLog(`Render failed: ${String(error)}`, 'error');
    }
  }

  private async pause(): Promise<void> {
    if (this.state.status !== 'rendering') return;
    await this.options.onPause?.();
    this.setState({ status: 'paused', canResume: true });
    this.appendLog('Render paused at validated checkpoint', 'warning');
  }

  private async resume(): Promise<void> {
    if (this.state.status !== 'paused' || !this.state.canResume) return;
    await this.options.onResume?.();
    this.setState({ status: 'rendering' });
    this.appendLog('Render resumed from validated checkpoint');
  }

  private async cancel(): Promise<void> {
    if (this.state.status !== 'rendering' && this.state.status !== 'paused') return;
    await this.options.onCancel?.();
    this.setState({ status: 'cancelled', canResume: false });
    this.appendLog('Render cancelled; incomplete transaction retained for inspection', 'warning');
  }

  private render(): void {
    this.statusPill.textContent = this.state.status;
    this.statusPill.dataset.status = this.state.status;
    this.root.dataset.status = this.state.status;
    this.renderTrack();
    this.renderDraft();
    this.renderProfile();
    this.renderValidation();
    this.renderProgress();
    this.renderResult();
    this.drawTimeline();
  }

  private renderTrack(): void {
    const track = this.state.track;
    if (!track) {
      this.trackName.textContent = 'No source loaded';
      this.trackMeta.textContent = 'Awaiting immutable analysis buffer';
      this.trackHash.textContent = 'SHA-256 —';
      this.previewSlate.hidden = false;
      return;
    }
    this.trackName.textContent = track.name;
    const fileSize = this.draft.audioFile ? ` · ${formatBytes(this.draft.audioFile.size)}` : '';
    this.trackMeta.textContent = `${formatTime(track.durationSeconds)} · ${track.sampleRate.toLocaleString()} Hz · ${track.channels === 1 ? 'mono' : `${track.channels} ch`}${fileSize}`;
    this.trackHash.textContent = track.sha256 ? `SHA-256 ${track.sha256.slice(0, 16)}…` : 'SHA-256 analyzing…';
    this.previewSlate.hidden = this.state.status !== 'analyzing';
    this.previewSlate.querySelector('b')!.textContent = this.state.status === 'analyzing' ? 'ANALYZING' : 'SOURCE READY';
    this.previewSlate.querySelector('span')!.textContent = this.state.status === 'analyzing' ? 'Freezing waveform, tempo and event ledger' : 'Frame 000000 ready to inspect';
  }

  private renderDraft(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      const active = button.dataset.mode === this.draft.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    this.presetSelect.disabled = false;
    const selectedValue = this.draft.presetId ? `${this.draft.presetKind}:${this.draft.presetId}` : '';
    if ([...this.presetSelect.options].some((option) => option.value === selectedValue)) this.presetSelect.value = selectedValue;
    this.customPresetName.textContent = this.draft.customPresetFile?.name ?? 'No custom preset';
    this.customPresetName.classList.toggle('is-loaded', !!this.draft.customPresetFile);
    this.need<HTMLInputElement>('input[data-field="seed"]').value = String(this.draft.seed);
    this.need<HTMLInputElement>('input[data-field="bpm"]').value = this.draft.bpm === null ? '' : String(this.draft.bpm);
    this.need<HTMLInputElement>('input[data-field="downbeat"]').value = String(this.draft.downbeatSample);
    this.need<HTMLSelectElement>('select[data-field="meter"]').value = this.draft.meter;
    for (const [name, checked] of [['png', this.draft.includePngSequence], ['audio', this.draft.includeAudio], ['proxy', this.draft.generateProxy], ['probe', this.draft.runProbe], ['segments', this.draft.buildMinimaxSegments], ['linear-transitions', this.draft.linearLightTransitions], ['flash-limit', this.draft.flashLimitFrames]] as const) this.need<HTMLInputElement>(`input[data-toggle="${name}"]`).checked = checked;
    this.outputName.textContent = this.draft.outputPath || 'Choose folder';
  }

  private renderProfile(): void {
    const profile = this.activeProfile();
    if (!profile) return;
    this.profileSelect.value = profile.id;
    for (const node of this.root.querySelectorAll<HTMLElement>('[data-role="profile-raster"]')) node.textContent = `${profile.width.toLocaleString()} × ${profile.height.toLocaleString()}`;
    for (const node of this.root.querySelectorAll<HTMLElement>('[data-role="profile-clock"]')) node.textContent = `${profile.fpsNum} / ${profile.fpsDen} fps`;
    const samples = this.samplesPerFrame(profile);
    this.frameInterval.textContent = Number.isInteger(samples) ? `${samples.toLocaleString()} samples / frame` : `${samples.toFixed(3)} samples / frame`;
    const count = this.totalFrames(profile);
    this.frameCount.textContent = count ? `${count.toLocaleString()} frames resolved` : '0 frames resolved';
    const output = this.previewCanvas;
    if (output.width !== profile.width || output.height !== profile.height) { output.width = profile.width; output.height = profile.height; }
  }

  private renderValidation(): void {
    const checks = this.state.validation.length ? this.state.validation : this.defaultValidation();
    this.validationList.replaceChildren();
    for (const check of checks) {
      const row = element('li', `is-${check.status}`);
      const mark = element('span', 'offline-validation-mark', check.status === 'passed' ? '✓' : check.status === 'failed' ? '×' : check.status === 'warning' ? '!' : check.status === 'working' ? '↻' : '·');
      const copy = element('div');
      copy.append(element('strong', '', check.label));
      if (check.detail) copy.append(element('small', '', check.detail));
      row.append(mark, copy);
      this.validationList.append(row);
    }
    this.errorPanel.hidden = !this.state.error;
    this.errorPanel.textContent = this.state.error ?? '';
    const running = this.state.status === 'rendering' || this.state.status === 'paused';
    this.renderButton.disabled = running || this.state.status === 'analyzing';
    this.renderButton.querySelector('span')!.textContent = this.state.status === 'completed' ? 'Render again' : 'Render complete track';
  }

  private renderProgress(): void {
    const { progress, status } = this.state;
    const ratio = progress.totalFrames > 0 ? Math.min(1, progress.completedFrames / progress.totalFrames) : 0;
    this.progressFill.style.width = `${(ratio * 100).toFixed(3)}%`;
    this.progressTrack.setAttribute('aria-valuenow', (ratio * 100).toFixed(1));
    this.progressTrack.setAttribute('aria-valuetext', `${progress.completedFrames.toLocaleString()} of ${progress.totalFrames.toLocaleString()} frames`);
    this.progressLabel.textContent = progress.stage;
    this.progressPct.textContent = `${(ratio * 100).toFixed(1)}%`;
    this.etaValue.textContent = progress.etaSeconds === undefined ? '—' : formatTime(progress.etaSeconds);
    this.throughputValue.textContent = progress.throughputFps === undefined ? '— fps' : `${progress.throughputFps.toFixed(1)} fps`;
    this.queueValue.textContent = `${progress.queueDepth ?? 0} frames`;
    if (progress.gpuMs === undefined && progress.boundBy !== undefined) {
      this.gpuLabel.textContent = 'Bound by';
      this.gpuValue.textContent = progress.boundBy;
    } else {
      this.gpuLabel.textContent = 'GPU p50';
      this.gpuValue.textContent = progress.gpuMs === undefined ? '— ms' : `${progress.gpuMs.toFixed(2)} ms`;
    }
    const running = status === 'rendering' || status === 'paused';
    this.pauseButton.disabled = !running;
    this.pauseButton.textContent = status === 'paused' ? 'Resume' : 'Pause';
    this.cancelButton.disabled = !running;
    const frame = Math.min(progress.completedFrames, Math.max(0, progress.totalFrames - 1));
    const sample = Math.floor(frame * this.samplesPerFrame(this.activeProfile()));
    this.previewFrame.textContent = `F ${String(frame).padStart(6, '0')} · S ${String(sample).padStart(9, '0')}`;
  }

  private renderResult(): void {
    const result = this.state.result;
    this.resultPanel.hidden = !result || this.state.status !== 'completed';
    if (result) this.resultPanel.querySelector('p')!.textContent = `${result.frameCount.toLocaleString()} frames · ${formatTime(result.durationSeconds)}${result.manifestSha256 ? ` · manifest ${result.manifestSha256.slice(0, 12)}…` : ''}`;
  }

  private defaultValidation(): OfflineValidationItem[] {
    const profile = this.activeProfile();
    const presetReady = this.draft.mode === 'auto' || !!this.draft.presetId || !!this.draft.customPresetFile;
    const tempoReady = this.draft.bpm !== null && this.draft.bpm > 0;
    return [
      { id: 'source', label: 'Audio authority', detail: this.state.track ? `${this.state.track.sampleRate.toLocaleString()} Hz · ${this.state.track.totalSamplesPerChannel.toLocaleString()} samples` : 'Load a track to begin', status: this.state.track ? 'passed' : this.state.status === 'analyzing' ? 'working' : 'pending' },
      { id: 'program', label: 'Preset schedule', detail: this.draft.mode === 'auto' ? 'Auto ledger resolves before rendering' : presetReady ? 'Fixed deterministic authority' : 'Select a preset', status: presetReady ? 'passed' : 'pending' },
      { id: 'tempo', label: 'Reviewed musical grid', detail: tempoReady ? `${this.draft.bpm!.toFixed(2)} BPM · ${this.draft.meter} · downbeat S${this.draft.downbeatSample}` : 'Enter a reviewed BPM; no fallback is labeled as analysis', status: tempoReady ? 'passed' : 'pending' },
      { id: 'clock', label: 'Frame/sample clock', detail: profile ? `${profile.fpsNum} fps · ${this.frameInterval.textContent}` : 'Choose an output profile', status: this.state.track && profile ? 'passed' : 'pending' },
      { id: 'output', label: 'Transactional output', detail: this.draft.outputPath || 'Choose an empty directory · proxy/archive use CLI', status: this.draft.outputDirectoryHandle ? 'passed' : 'pending' },
      { id: 'gpu', label: 'Renderer diagnostics', detail: 'Fail-closed WebGPU checks before frame 0', status: 'pending' },
    ];
  }

  private activeProfile(): OfflineOutputProfile | undefined { return this.profiles.find((profile) => profile.id === this.draft.profileId) ?? this.profiles[0]; }
  private samplesPerFrame(profile = this.activeProfile()): number {
    const rate = this.state.track?.sampleRate ?? 48_000;
    return profile ? rate * profile.fpsDen / profile.fpsNum : 0;
  }
  private totalFrames(profile = this.activeProfile()): number {
    const samples = this.state.track?.totalSamplesPerChannel ?? 0;
    const perFrame = this.samplesPerFrame(profile);
    return perFrame > 0 ? Math.ceil(samples / perFrame) : 0;
  }

  private drawTimeline(): void {
    const canvas = this.timelineCanvas;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(176 * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = 176;
    ctx.fillStyle = '#081018'; ctx.fillRect(0, 0, w, h);
    const center = 53;
    ctx.strokeStyle = 'rgba(209,230,239,.11)'; ctx.beginPath(); ctx.moveTo(0, center + .5); ctx.lineTo(w, center + .5); ctx.stroke();
    const source = this.waveform;
    if (source.length) {
      ctx.strokeStyle = '#42d8ee'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < Math.ceil(w); x += 1) {
        const start = Math.floor(x / w * source.length);
        const end = Math.max(start + 1, Math.floor((x + 1) / w * source.length));
        let peak = 0;
        for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(source[index] ?? 0));
        const y = peak * 42;
        ctx.moveTo(x + .5, center - y); ctx.lineTo(x + .5, center + y);
      }
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(66,216,238,.22)'; ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.moveTo(0, center); ctx.lineTo(w, center); ctx.stroke(); ctx.setLineDash([]);
    }

    const profile = this.activeProfile();
    const total = Math.max(this.totalFrames(profile), this.state.progress.totalFrames);
    const current = Math.min(Math.max(0, this.state.progress.completedFrames), Math.max(0, total - 1));
    const stripY = 108;
    const stripH = 42;
    const visible = Math.min(24, Math.max(1, total || 24));
    const startFrame = Math.max(0, Math.min(Math.max(0, total - visible), current - Math.floor(visible / 2)));
    const cellW = w / visible;
    ctx.font = '9px "Cascadia Mono", Consolas, monospace'; ctx.textBaseline = 'middle';
    for (let slot = 0; slot < visible; slot += 1) {
      const frame = startFrame + slot;
      const x = slot * cellW;
      const selected = frame === current && total > 0;
      ctx.fillStyle = selected ? 'rgba(66,216,238,.18)' : slot % 2 ? 'rgba(255,255,255,.018)' : 'rgba(255,255,255,.035)';
      ctx.fillRect(x, stripY, Math.max(0, cellW - 1), stripH);
      ctx.strokeStyle = selected ? '#42d8ee' : 'rgba(209,230,239,.18)';
      ctx.strokeRect(x + .5, stripY + .5, Math.max(0, cellW - 1), stripH - 1);
      if (cellW > 34) {
        ctx.fillStyle = selected ? '#f4fbff' : '#8195a3';
        ctx.fillText(`F${String(frame).padStart(4, '0')}`, x + 5, stripY + 13);
        const sample = Math.floor(frame * this.samplesPerFrame(profile));
        ctx.fillStyle = selected ? '#42d8ee' : '#526875';
        ctx.fillText(`S${sample}`, x + 5, stripY + 29);
      }
    }
    ctx.fillStyle = '#68808d'; ctx.font = '9px "Cascadia Mono", Consolas, monospace';
    ctx.fillText('TRACK OVERVIEW / SAMPLE DOMAIN', 10, 93);
    ctx.textAlign = 'right'; ctx.fillText(`FRAME WINDOW ${startFrame}—${startFrame + visible - 1}`, w - 10, 93); ctx.textAlign = 'left';
    const progressX = total > 0 ? current / Math.max(1, total - 1) * w : 0;
    ctx.fillStyle = '#ff6f61'; ctx.fillRect(Math.max(0, progressX - 1), 6, 2, 88);
  }

  private async seekFromPointer(event: PointerEvent): Promise<void> {
    const profile = this.activeProfile();
    const total = this.totalFrames(profile);
    if (!profile || total <= 0) return;
    const rect = this.timelineCanvas.getBoundingClientRect();
    const frame = Math.min(total - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * total)));
    const sample = Math.floor(frame * this.samplesPerFrame(profile));
    this.previewFrame.textContent = `F ${String(frame).padStart(6, '0')} · S ${String(sample).padStart(9, '0')}`;
    await this.options.onSeekPreview?.(frame, sample);
  }

  private trapFocus(event: KeyboardEvent): void {
    const focusable = [...this.root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')].filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
}

export function createOfflineStudio(options: OfflineStudioOptions = {}): OfflineStudioController {
  return new Studio(options);
}
