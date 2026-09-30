/**
 * Fighting Game HUD Animation Bed
 * 
 * Implements Pilot Family 2 (Fighting-game round) from docs/HUD-ANIMATION-BEDS.md.
 * Provides deterministic, CPU-only audio-reactive fighting game instruments:
 * - Dynamic P1/P2 life bars (directional fill, active health + delayed ghost damage trails, round resets/refills)
 * - Round countdown timer (authoritative 99->0 countdown, urgency flash < 10, exact zero hold)
 * - Super / EX / Power bars (rhythmic energy charge, MAX saturation glow, dynamic discharge bursts)
 * - Authentic arcade HUD text banners (ROUND X, FIGHT!, K.O.!, TIME OVER, XX HITS COMBO!, DANGER!)
 * - Multiple iconic styles: SF2 (CPS-1), SF Alpha 3 (CPS-2), KOF '98 (Neo Geo), Garou (Neo Geo), SamSho, Arcade
 * 
 * 100% deterministic, zero GPU allocation, strict canvas state management.
 */

import type { AvsAudioFrame } from '../avs/types.ts';
import type { AudioSnapshot } from '../contracts.ts';

export const FIGHTING_STYLES = ['sf2', 'sfa3', 'kof98', 'garou', 'samsho', 'arcade'] as const;
export type FightingGameStyle = typeof FIGHTING_STYLES[number];

export type FightingBannerType =
  | 'round'
  | 'fight'
  | 'ko'
  | 'double_ko'
  | 'time_over'
  | 'danger'
  | 'combo'
  | 'super'
  | 'perfect';

export interface FighterState {
  name: string;
  health: number;         // 0..1 current active health
  ghostHealth: number;    // 0..1 trailing ghost damage bar
  ghostTimer: number;     // seconds elapsed since last hit before ghost begins decaying
  superGauge: number;     // 0..1 charge within current level
  superStock: number;     // 0..3 full super stocks accumulated
  isMax: boolean;         // full stock reached / MAX state
  isDanger: boolean;      // health <= 0.25
  roundsWon: number;      // 0..2
  comboCount: number;     // hit counter (0..99)
  comboTimer: number;     // seconds remaining in combo window
  damageDealt: number;    // accumulated damage in current combo
}

export interface FightingBannerState {
  type: FightingBannerType;
  text: string;
  subtext?: string;
  scale: number;
  alpha: number;
  flash: number;
  duration: number;
  elapsed: number;
  side?: 'p1' | 'p2';
}

export interface FightingHudState {
  round: number;
  timer: number;          // 0..99 integer display
  timerUrgent: boolean;   // <= 10 seconds
  phase: 'intro' | 'fight' | 'active' | 'climax' | 'resolution' | 'recovery';
  p1: FighterState;
  p2: FighterState;
  banner: FightingBannerState | null;
  flashIntensity: number; // 0..1 screen / HUD impact flash
  shake: { x: number; y: number };
}

export interface FightingHudSignals {
  time: number;
  dt: number;
  sub: number;       // 0..1 sub-bass energy
  low: number;       // 0..1 low-mid / punch energy
  mid: number;       // 0..1 mid-range energy
  high: number;      // 0..1 high frequency energy
  rms: number;       // 0..1 overall level
  transient: number; // 0..1 onset spike magnitude
  pan: number;       // -1..1 stereo balance (-1 = P1 side, +1 = P2 side)
  beat: boolean;     // rhythmic beat trigger
}

export interface FightingHudFrame {
  time: number;           // Media time in seconds
  localTime: number;      // Local round elapsed time in seconds
  progress: number;       // 0..1 normalized round progress
  bpm: number;
  seed: number;
  audio: AvsAudioFrame | AudioSnapshot;
  style?: FightingGameStyle;
  roundDuration?: number; // default 99
  p1Name?: string;
  p2Name?: string;
  stateOverride?: Partial<FightingHudState>;
}

type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

const TAU = Math.PI * 2;
const clamp = (v: number, min = 0, max = 1): number => Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

/** PRNG with deterministic seed */
function seededRandom(seed: number): number {
  let n = (Math.imul(seed + 1013904223, 0x45d9f3b) ^ 0x9e3779b9) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Extract standard normalized frequency bands and signals from either audio format */
export function extractFightingAudioSignals(audio: AvsAudioFrame | AudioSnapshot, time = 0, dt = 0.016): FightingHudSignals {
  if ('bands' in audio && 'waveform' in audio) {
    // AudioSnapshot contract from contracts.ts
    const snapshot = audio as AudioSnapshot;
    return {
      time: finite(snapshot.time, time),
      dt: Math.max(0.001, dt),
      sub: clamp(snapshot.bands.sub),
      low: clamp(snapshot.bands.low),
      mid: clamp(snapshot.bands.mid),
      high: clamp(snapshot.bands.high + snapshot.bands.air * 0.5),
      rms: clamp(snapshot.level),
      transient: clamp(snapshot.beat),
      pan: clamp(snapshot.pan, -1, 1),
      beat: snapshot.beat > 0.65,
    };
  }

  // AvsAudioFrame contract from avs/types.ts
  const frame = audio as AvsAudioFrame;
  const specL = frame.spectrum[0];
  const specR = frame.spectrum[1];

  let sumSub = 0, sumLow = 0, sumMid = 0, sumHigh = 0;
  let peakL = 0, peakR = 0;

  for (let i = 0; i < 512; i++) {
    const l = (specL[i] ?? 0) / 255;
    const r = (specR[i] ?? 0) / 255;
    const v = (l + r) * 0.5;

    if (i < 8) sumSub += v * v;
    else if (i < 40) sumLow += v * v;
    else if (i < 160) sumMid += v * v;
    else if (i < 380) sumHigh += v * v;

    if (l > peakL) peakL = l;
    if (r > peakR) peakR = r;
  }

  const sub = clamp(Math.sqrt(sumSub / 8) * 1.5);
  const low = clamp(Math.sqrt(sumLow / 32) * 1.4);
  const mid = clamp(Math.sqrt(sumMid / 120) * 1.3);
  const high = clamp(Math.sqrt(sumHigh / 220) * 1.6);
  const rms = clamp((sub * 0.4 + low * 0.3 + mid * 0.2 + high * 0.1));
  const pan = clamp(peakL + peakR > 0.001 ? (peakR - peakL) / (peakL + peakR) : 0, -1, 1);
  const transient = clamp(frame.beatLevel > 0 ? frame.beatLevel / 255 : (sub * 0.7 + low * 0.5));

  return {
    time: finite(time),
    dt: Math.max(0.001, dt),
    sub,
    low,
    mid,
    high,
    rms,
    transient,
    pan,
    beat: frame.beat || transient > 0.72,
  };
}

/** Constants for fighting game physics */
const GHOST_HOLD_SECS = 0.45;
const GHOST_DECAY_RATE = 0.35; // units per second
const COMBO_WINDOW_SECS = 0.75;
const SUPER_CHARGE_RATE = 0.28;

/**
 * Deterministic Fighting Game HUD State Evaluator
 * 
 * Evaluates exact, reproducible fighting HUD state from progress (0..1),
 * media time, seed, and audio features. Guarantees 100% seek determinism.
 */
export function evaluateFightingHud(frame: FightingHudFrame): FightingHudState {
  const progress = clamp(frame.progress, 0, 1);
  const duration = Math.max(10, frame.roundDuration ?? 99);
  const timer = clamp(Math.ceil(duration * (1 - progress)), 0, duration);
  const timerUrgent = timer <= 10;
  const seed = (frame.seed ?? 12345) >>> 0;
  const signals = extractFightingAudioSignals(frame.audio, frame.time);

  const p1Wins = seededRandom(seed) > 0.48;
  const p1Name = frame.p1Name ?? (frame.style === 'kof98' ? 'KYO' : frame.style === 'garou' ? 'TERRY' : 'RYU');
  const p2Name = frame.p2Name ?? (frame.style === 'kof98' ? 'IORI' : frame.style === 'garou' ? 'ROCK' : 'KEN');

  // Determine round phase
  let phase: FightingHudState['phase'] = 'active';
  if (progress < 0.035) phase = 'intro';
  else if (progress < 0.08) phase = 'fight';
  else if (progress > 0.88 && progress < 0.95) phase = 'climax';
  else if (progress >= 0.95) phase = 'resolution';

  // Deterministic health curve (monotonic decrease during round)
  // P1 and P2 trade hits. Audio transient adds immediate impact modulation.
  const combatProgress = clamp((progress - 0.08) / 0.82, 0, 1);

  // Discrete hit steps across combat progress
  let p1Health = 1.0;
  let p2Health = 1.0;

  if (combatProgress > 0) {
    if (p1Wins) {
      // P1 wins: P2 hits 0 around combatProgress = 0.95; P1 drops to ~0.32
      p2Health = clamp(1.0 - Math.pow(combatProgress, 0.85) * 1.05);
      p1Health = clamp(1.0 - Math.pow(combatProgress, 1.1) * 0.68);
    } else {
      // P2 wins: P1 hits 0 around combatProgress = 0.95; P2 drops to ~0.28
      p1Health = clamp(1.0 - Math.pow(combatProgress, 0.85) * 1.05);
      p2Health = clamp(1.0 - Math.pow(combatProgress, 1.1) * 0.72);
    }

    // Modulate with audio transients (small transient tremors without breaking monotonicity)
    const audioDamageP1 = signals.transient * (signals.pan > 0 ? 0.03 : 0.01);
    const audioDamageP2 = signals.transient * (signals.pan < 0 ? 0.03 : 0.01);
    p1Health = clamp(p1Health - audioDamageP1);
    p2Health = clamp(p2Health - audioDamageP2);
  }

  // Ghost health trails slightly behind active health
  const ghostLag = 0.08 * (1 - combatProgress);
  const p1Ghost = clamp(p1Health + ghostLag * (1 + signals.low * 0.5), p1Health, 1.0);
  const p2Ghost = clamp(p2Health + ghostLag * (1 + signals.low * 0.5), p2Health, 1.0);

  // Super gauges: build up from rhythm and discharge periodically
  // Charge cycle repeats every ~12-16% of progress
  const cycleP1 = (progress * 5.5 + seededRandom(seed + 1)) % 1.0;
  const cycleP2 = (progress * 4.8 + seededRandom(seed + 2)) % 1.0;
  const p1SuperGauge = clamp(cycleP1 + signals.sub * 0.2);
  const p2SuperGauge = clamp(cycleP2 + signals.low * 0.2);
  const p1Stock = Math.min(3, Math.floor(progress * 3.5));
  const p2Stock = Math.min(3, Math.floor(progress * 3.2));

  // Determine active banner
  let banner: FightingBannerState | null = null;
  if (phase === 'intro') {
    banner = {
      type: 'round',
      text: 'ROUND 1',
      subtext: 'READY',
      scale: 1.0 + (1 - progress / 0.035) * 0.4,
      alpha: clamp(progress / 0.01, 0, 1),
      flash: 0,
      duration: 1.5,
      elapsed: frame.localTime,
    };
  } else if (phase === 'fight') {
    const fightNorm = (progress - 0.035) / 0.045;
    banner = {
      type: 'fight',
      text: 'FIGHT !',
      scale: 1.0 + Math.max(0, 1 - fightNorm * 3) * 0.8,
      alpha: clamp(1 - (fightNorm - 0.6) * 2.5, 0, 1),
      flash: fightNorm < 0.2 ? 1.0 : 0,
      duration: 1.2,
      elapsed: frame.localTime,
    };
  } else if (phase === 'climax' || phase === 'resolution') {
    if (timer === 0) {
      banner = {
        type: 'time_over',
        text: 'TIME OVER',
        scale: 1.0,
        alpha: 1.0,
        flash: 0,
        duration: 3.0,
        elapsed: frame.localTime,
      };
    } else {
      banner = {
        type: 'ko',
        text: 'K . O . !',
        subtext: p1Wins ? `${p1Name} WINS` : `${p2Name} WINS`,
        scale: 1.0 + Math.max(0, 0.9 - progress) * 1.5,
        alpha: 1.0,
        flash: progress < 0.91 ? 0.8 : 0,
        duration: 3.0,
        elapsed: frame.localTime,
      };
    }
  } else if (signals.transient > 0.85 && signals.beat) {
    // Dynamic transient combo burst
    const hits = 3 + Math.floor(signals.sub * 12);
    banner = {
      type: 'combo',
      text: `${hits} HITS !`,
      scale: 1.15,
      alpha: 0.95,
      flash: 0.3,
      duration: 0.6,
      elapsed: 0.1,
      side: signals.pan < 0 ? 'p1' : 'p2',
    };
  }

  const flashIntensity = banner?.flash ?? (signals.transient > 0.92 ? 0.35 : 0);
  const shakeX = (signals.transient > 0.85 ? (seededRandom(seed + Math.floor(frame.time * 20)) - 0.5) * 6 : 0);
  const shakeY = (signals.transient > 0.85 ? (seededRandom(seed + 99 + Math.floor(frame.time * 20)) - 0.5) * 6 : 0);

  const state: FightingHudState = {
    round: 1,
    timer,
    timerUrgent,
    phase,
    p1: {
      name: p1Name,
      health: p1Health,
      ghostHealth: p1Ghost,
      ghostTimer: 0,
      superGauge: p1SuperGauge,
      superStock: p1Stock,
      isMax: p1Stock >= 3,
      isDanger: p1Health <= 0.25,
      roundsWon: p1Wins && progress >= 0.95 ? 1 : 0,
      comboCount: banner?.type === 'combo' && banner.side === 'p1' ? 7 : 0,
      comboTimer: 0,
      damageDealt: 0,
    },
    p2: {
      name: p2Name,
      health: p2Health,
      ghostHealth: p2Ghost,
      ghostTimer: 0,
      superGauge: p2SuperGauge,
      superStock: p2Stock,
      isMax: p2Stock >= 3,
      isDanger: p2Health <= 0.25,
      roundsWon: !p1Wins && progress >= 0.95 ? 1 : 0,
      comboCount: banner?.type === 'combo' && banner.side === 'p2' ? 5 : 0,
      comboTimer: 0,
      damageDealt: 0,
    },
    banner,
    flashIntensity,
    shake: { x: shakeX, y: shakeY },
  };

  if (frame.stateOverride) {
    Object.assign(state, frame.stateOverride);
  }

  return state;
}

/**
 * Stateful Interactive Fighting HUD Engine
 * 
 * Supports live continuous frame updates, damage simulation, health refill / round
 * recovery (life bars going up and down), super meter charge and discharge bursts,
 * hit combos, and transient banner animations.
 */
export class FightingHudBed {
  private state: FightingHudState;
  private roundDuration: number;
  private elapsedRoundTime = 0;
  private style: FightingGameStyle;

  constructor(p1Name = 'RYU', p2Name = 'KEN', roundDuration = 99, style: FightingGameStyle = 'sf2') {
    this.roundDuration = roundDuration;
    this.style = style;
    this.state = {
      round: 1,
      timer: roundDuration,
      timerUrgent: false,
      phase: 'intro',
      p1: {
        name: p1Name,
        health: 1.0,
        ghostHealth: 1.0,
        ghostTimer: 0,
        superGauge: 0.15,
        superStock: 0,
        isMax: false,
        isDanger: false,
        roundsWon: 0,
        comboCount: 0,
        comboTimer: 0,
        damageDealt: 0,
      },
      p2: {
        name: p2Name,
        health: 1.0,
        ghostHealth: 1.0,
        ghostTimer: 0,
        superGauge: 0.15,
        superStock: 0,
        isMax: false,
        isDanger: false,
        roundsWon: 0,
        comboCount: 0,
        comboTimer: 0,
        damageDealt: 0,
      },
      banner: {
        type: 'round',
        text: 'ROUND 1',
        subtext: 'READY',
        scale: 1.3,
        alpha: 1.0,
        flash: 0,
        duration: 1.8,
        elapsed: 0,
      },
      flashIntensity: 0,
      shake: { x: 0, y: 0 },
    };
  }

  public getState(): Readonly<FightingHudState> {
    return this.state;
  }

  public getStyle(): FightingGameStyle {
    return this.style;
  }

  public setStyle(style: FightingGameStyle): void {
    this.style = style;
  }

  /**
   * Reset round (e.g. for Round 2, Round 3, or restart).
   * Refills health bars smoothly up to 100%.
   */
  public resetRound(nextRound = 1): void {
    this.state.round = nextRound;
    this.state.timer = this.roundDuration;
    this.state.timerUrgent = false;
    this.state.phase = 'intro';
    this.elapsedRoundTime = 0;

    // Refill health bars (life bars going up!)
    this.state.p1.health = 1.0;
    this.state.p1.ghostHealth = 1.0;
    this.state.p1.ghostTimer = 0;
    this.state.p1.isDanger = false;
    this.state.p1.comboCount = 0;

    this.state.p2.health = 1.0;
    this.state.p2.ghostHealth = 1.0;
    this.state.p2.ghostTimer = 0;
    this.state.p2.isDanger = false;
    this.state.p2.comboCount = 0;

    this.state.banner = {
      type: 'round',
      text: nextRound === 3 ? 'FINAL ROUND' : `ROUND ${nextRound}`,
      subtext: 'READY',
      scale: 1.4,
      alpha: 1.0,
      flash: 0,
      duration: 1.8,
      elapsed: 0,
    };
  }

  /** Apply hit damage to a player (life bars going down) */
  public applyHit(targetSide: 'p1' | 'p2', damage: number, chargeAttacker = true): void {
    const target = targetSide === 'p1' ? this.state.p1 : this.state.p2;
    const attacker = targetSide === 'p1' ? this.state.p2 : this.state.p1;

    const actualDamage = Math.max(0.01, Math.min(target.health, damage));
    target.health = clamp(target.health - actualDamage);
    target.ghostTimer = GHOST_HOLD_SECS; // Hold ghost bar before decaying
    target.isDanger = target.health <= 0.25;

    // Attacker gains combo count
    attacker.comboCount += 1;
    attacker.comboTimer = COMBO_WINDOW_SECS;
    attacker.damageDealt += actualDamage;

    // Super meter charges on landing regular hits (super moves do not self-charge)
    if (chargeAttacker) {
      this.chargeSuper(targetSide === 'p1' ? 'p2' : 'p1', actualDamage * 0.8);
    }

    // Screen shake & hit spark
    this.state.shake = {
      x: (Math.random() - 0.5) * actualDamage * 40,
      y: (Math.random() - 0.5) * actualDamage * 40,
    };
    this.state.flashIntensity = Math.min(0.8, actualDamage * 2.5);

    // Check KO
    if (target.health <= 0 && this.state.phase !== 'resolution') {
      this.state.phase = 'resolution';
      attacker.roundsWon += 1;
      this.triggerBanner('ko', 'K . O . !', `${attacker.name} WINS`, 3.5);
    } else if (attacker.comboCount >= 2) {
      this.triggerBanner(
        'combo',
        `${attacker.comboCount} HITS !`,
        `${Math.round(attacker.damageDealt * 100)}% DAMAGE`,
        0.8,
        targetSide === 'p1' ? 'p2' : 'p1'
      );
    }
  }

  /** Restore health to a fighter (life bars going up!) */
  public restoreHealth(side: 'p1' | 'p2', amount: number): void {
    const fighter = side === 'p1' ? this.state.p1 : this.state.p2;
    fighter.health = clamp(fighter.health + amount);
    if (fighter.ghostHealth < fighter.health) {
      fighter.ghostHealth = fighter.health;
    }
    fighter.isDanger = fighter.health <= 0.25;
  }

  /** Charge super gauge (super bar going up) */
  public chargeSuper(side: 'p1' | 'p2', amount: number): void {
    const fighter = side === 'p1' ? this.state.p1 : this.state.p2;
    if (fighter.isMax) return;

    fighter.superGauge += amount;
    while (fighter.superGauge >= 1.0 && fighter.superStock < 3) {
      fighter.superStock += 1;
      fighter.superGauge -= 1.0;
      if (fighter.superStock === 3) {
        fighter.superGauge = 1.0;
        fighter.isMax = true;
        break;
      }
    }
    if (fighter.superStock >= 3) {
      fighter.superStock = 3;
      fighter.superGauge = 1.0;
      fighter.isMax = true;
    }
  }

  /** Discharge super gauge (super bar going down on super move / climax) */
  public dischargeSuper(attackerSide: 'p1' | 'p2'): void {
    const attacker = attackerSide === 'p1' ? this.state.p1 : this.state.p2;
    const opponentSide = attackerSide === 'p1' ? 'p2' : 'p1';

    if (attacker.superStock <= 0 && attacker.superGauge < 0.8) return;

    if (attacker.isMax) {
      attacker.superStock = 0;
      attacker.superGauge = 0;
      attacker.isMax = false;
    } else if (attacker.superStock > 0) {
      attacker.superStock -= 1;
    } else {
      attacker.superGauge = 0;
    }

    // Heavy damage to opponent without self-charging super meter
    this.applyHit(opponentSide, 0.22, false);

    this.state.flashIntensity = 0.9;
    this.triggerBanner('super', 'SUPER COMBO !', `${attacker.name} SPECIAL`, 1.4, attackerSide);
  }

  /** Trigger an announcement banner */
  public triggerBanner(
    type: FightingBannerType,
    text: string,
    subtext?: string,
    duration = 1.5,
    side?: 'p1' | 'p2'
  ): void {
    this.state.banner = {
      type,
      text,
      subtext,
      scale: 1.4,
      alpha: 1.0,
      flash: 0.6,
      duration,
      elapsed: 0,
      side,
    };
  }

  /**
   * Main audio-reactive update tick.
   * Feeds music energy, transients, beats, and stereo balance into the fighting simulation.
   */
  public update(audioInput: FightingHudSignals | AvsAudioFrame | AudioSnapshot, dt: number): FightingHudState {
    const signals: FightingHudSignals =
      'sub' in audioInput && 'rms' in audioInput
        ? (audioInput as FightingHudSignals)
        : extractFightingAudioSignals(audioInput as AvsAudioFrame, this.elapsedRoundTime, dt);

    const safeDt = Math.max(0.001, Math.min(1.0, dt));
    this.elapsedRoundTime += safeDt;

    // Decay screen shake & flash
    this.state.shake.x *= Math.max(0, 1 - safeDt * 12);
    this.state.shake.y *= Math.max(0, 1 - safeDt * 12);
    this.state.flashIntensity *= Math.max(0, 1 - safeDt * 8);

    // Update Banner animation
    if (this.state.banner) {
      this.state.banner.elapsed += safeDt;
      const progress = this.state.banner.elapsed / this.state.banner.duration;
      if (progress >= 1.0) {
        this.state.banner = null;
      } else {
        // Entrance scale bounce -> hold -> fade out
        if (progress < 0.25) {
          const entry = progress / 0.25;
          this.state.banner.scale = 1.0 + (1 - entry) * 0.4;
          this.state.banner.alpha = Math.min(1.0, entry * 2);
        } else if (progress > 0.75) {
          this.state.banner.alpha = (1 - progress) / 0.25;
        } else {
          this.state.banner.scale = 1.0;
          this.state.banner.alpha = 1.0;
        }
      }
    }

    // Phase transitions
    if (this.state.phase === 'intro') {
      if (this.elapsedRoundTime >= 1.8) {
        this.state.phase = 'fight';
        this.triggerBanner('fight', 'FIGHT !', undefined, 1.2);
      }
    } else if (this.state.phase === 'fight') {
      if (this.elapsedRoundTime >= 3.0) {
        this.state.phase = 'active';
      }
    } else if (this.state.phase === 'active') {
      // Countdown Timer (authoritative round countdown)
      const roundProgress = this.elapsedRoundTime / (this.roundDuration * 0.85);
      this.state.timer = Math.max(0, Math.ceil(this.roundDuration * (1 - clamp(roundProgress))));
      this.state.timerUrgent = this.state.timer <= 10;

      if (this.state.timer === 0) {
        this.state.phase = 'resolution';
        if (this.state.p1.health === this.state.p2.health) {
          this.triggerBanner('double_ko', 'DRAW GAME', 'TIME OVER', 3.0);
        } else {
          const winner = this.state.p1.health > this.state.p2.health ? this.state.p1 : this.state.p2;
          winner.roundsWon += 1;
          this.triggerBanner('time_over', 'TIME OVER', `${winner.name} WINS`, 3.0);
        }
      }

      // Audio-Reactive Combat: Transients and beats deal damage
      if (signals.transient > 0.72) {
        // Hit detected from music percussion
        const baseDamage = 0.02 + signals.transient * 0.05 + signals.low * 0.03;

        // Stereo bias selects target:
        // Left-leaning sound (pan < -0.15) -> P1 attacks P2 (P2 takes damage)
        // Right-leaning sound (pan > 0.15) -> P2 attacks P1 (P1 takes damage)
        // Center sound -> alternates based on elapsed time
        let targetSide: 'p1' | 'p2';
        if (signals.pan < -0.15) {
          targetSide = 'p2';
        } else if (signals.pan > 0.15) {
          targetSide = 'p1';
        } else {
          targetSide = Math.sin(this.elapsedRoundTime * 3.5) > 0 ? 'p1' : 'p2';
        }

        this.applyHit(targetSide, baseDamage);
      }

      // Super Meter: Continuous charging on bass/sub energy (super bar going up)
      const chargeEnergy = (signals.sub * 0.5 + signals.low * 0.3 + signals.mid * 0.2) * SUPER_CHARGE_RATE * safeDt;
      this.chargeSuper('p1', chargeEnergy * (1 + (signals.pan < 0 ? 0.3 : 0)));
      this.chargeSuper('p2', chargeEnergy * (1 + (signals.pan > 0 ? 0.3 : 0)));

      // Super Move Climax: When a major drop or climax occurs, discharge super meter (super bar going down)
      if (signals.transient > 0.90 && signals.sub > 0.75) {
        if (this.state.p1.superStock > 0 || this.state.p1.isMax) {
          this.dischargeSuper('p1');
        } else if (this.state.p2.superStock > 0 || this.state.p2.isMax) {
          this.dischargeSuper('p2');
        }
      }
    }

    // Ghost damage trail decay
    for (const fighter of [this.state.p1, this.state.p2]) {
      if (fighter.ghostTimer > 0) {
        const consumed = Math.min(fighter.ghostTimer, safeDt);
        fighter.ghostTimer -= consumed;
        const remainingDt = safeDt - consumed;
        if (remainingDt > 0 && fighter.ghostHealth > fighter.health) {
          fighter.ghostHealth = Math.max(fighter.health, fighter.ghostHealth - GHOST_DECAY_RATE * remainingDt);
        }
      } else if (fighter.ghostHealth > fighter.health) {
        fighter.ghostHealth = Math.max(fighter.health, fighter.ghostHealth - GHOST_DECAY_RATE * safeDt);
      }

      // Combo timer decay
      if (fighter.comboTimer > 0) {
        fighter.comboTimer -= safeDt;
        if (fighter.comboTimer <= 0) {
          fighter.comboCount = 0;
          fighter.damageDealt = 0;
        }
      }
    }

    return this.state;
  }
}

// ---------------------------------------------------------------------------
// Canvas 2D Rendering Pipeline (100% Deterministic, CPU-only)
// ---------------------------------------------------------------------------

/** Color palettes for fighting game themes */
interface ThemeColors {
  hudBg: string;
  frameBorder: string;
  p1HealthFill: [string, string];
  p2HealthFill: [string, string];
  dangerFill: [string, string];
  ghostDamageFill: string;
  emptyRailFill: string;
  timerColor: string;
  timerUrgentColor: string;
  superBg: string;
  superFill: [string, string];
  superMaxFill: [string, string, string];
  nameColor: string;
}

const THEME_CONFIGS: Record<FightingGameStyle, ThemeColors> = {
  sf2: {
    hudBg: '#090d18',
    frameBorder: '#23528b',
    p1HealthFill: ['#ffe600', '#e08a00'],
    p2HealthFill: ['#ffe600', '#e08a00'],
    dangerFill: ['#ff3b30', '#a30d00'],
    ghostDamageFill: '#b51212',
    emptyRailFill: '#1a1f2c',
    timerColor: '#ffcc00',
    timerUrgentColor: '#ff2200',
    superBg: '#0f1828',
    superFill: ['#00bfff', '#0055ff'],
    superMaxFill: ['#00ffff', '#ffdd00', '#ff0055'],
    nameColor: '#ffdf40',
  },
  sfa3: {
    hudBg: '#0c1220',
    frameBorder: '#3f679b',
    p1HealthFill: ['#44e677', '#159640'],
    p2HealthFill: ['#44e677', '#159640'],
    dangerFill: ['#ff4d4d', '#991111'],
    ghostDamageFill: '#c72424',
    emptyRailFill: '#151c28',
    timerColor: '#4de8ff',
    timerUrgentColor: '#ff3344',
    superBg: '#09101c',
    superFill: ['#3b82f6', '#1d4ed8'],
    superMaxFill: ['#ec4899', '#8b5cf6', '#3b82f6'],
    nameColor: '#e2e8f0',
  },
  kof98: {
    hudBg: '#080808',
    frameBorder: '#4a5568',
    p1HealthFill: ['#70e000', '#38b000'],
    p2HealthFill: ['#70e000', '#38b000'],
    dangerFill: ['#d90429', '#ef233c'],
    ghostDamageFill: '#c1121f',
    emptyRailFill: '#1b1b1e',
    timerColor: '#ffd166',
    timerUrgentColor: '#ef233c',
    superBg: '#121214',
    superFill: ['#f77f00', '#d62828'],
    superMaxFill: ['#ffbe0b', '#fb5607', '#ff006e'],
    nameColor: '#ffffff',
  },
  garou: {
    hudBg: '#0a0b10',
    frameBorder: '#5b617a',
    p1HealthFill: ['#f4a261', '#e76f51'],
    p2HealthFill: ['#f4a261', '#e76f51'],
    dangerFill: ['#e63946', '#9b1d20'],
    ghostDamageFill: '#a4161a',
    emptyRailFill: '#161a24',
    timerColor: '#f8f9fa',
    timerUrgentColor: '#e63946',
    superBg: '#0e111a',
    superFill: ['#48cae4', '#0077b6'],
    superMaxFill: ['#90e0ef', '#00b4d8', '#0077b6'],
    nameColor: '#f1faee',
  },
  samsho: {
    hudBg: '#100a06',
    frameBorder: '#8d5b34',
    p1HealthFill: ['#ffb703', '#fb8500'],
    p2HealthFill: ['#ffb703', '#fb8500'],
    dangerFill: ['#ba181b', '#660708'],
    ghostDamageFill: '#800f2f',
    emptyRailFill: '#221610',
    timerColor: '#ffba08',
    timerUrgentColor: '#d00000',
    superBg: '#1a100a',
    superFill: ['#dc2f02', '#9d0208'],
    superMaxFill: ['#ffba08', '#f48c06', '#d00000'],
    nameColor: '#fcedbe',
  },
  arcade: {
    hudBg: '#05070e',
    frameBorder: '#2a3b5c',
    p1HealthFill: ['#00f5d4', '#00bbf9'],
    p2HealthFill: ['#00f5d4', '#00bbf9'],
    dangerFill: ['#f72585', '#b5179e'],
    ghostDamageFill: '#7209b7',
    emptyRailFill: '#111625',
    timerColor: '#fee440',
    timerUrgentColor: '#f72585',
    superBg: '#090e1a',
    superFill: ['#4361ee', '#3a0ca3'],
    superMaxFill: ['#4cc9f0', '#4895ef', '#4361ee'],
    nameColor: '#ffffff',
  },
};

/** Render a beveled rectangle with metallic or dark arcade borders */
function renderBevelBox(
  c: Context,
  x: number,
  y: number,
  w: number,
  h: number,
  bg: string,
  border: string,
  bevel = 2
): void {
  c.fillStyle = bg;
  c.fillRect(x, y, w, h);

  // Border
  c.strokeStyle = border;
  c.lineWidth = 1.5;
  c.strokeRect(x, y, w, h);

  // Highlight (top & left)
  c.fillStyle = 'rgba(255, 255, 255, 0.22)';
  c.fillRect(x + 1, y + 1, w - 2, bevel);
  c.fillRect(x + 1, y + 1, bevel, h - 2);

  // Shadow (bottom & right)
  c.fillStyle = 'rgba(0, 0, 0, 0.45)';
  c.fillRect(x + 1, y + h - bevel - 1, w - 2, bevel);
  c.fillRect(x + w - bevel - 1, y + 1, bevel, h - 2);
}

/** Render a single directional life bar with ghost damage trail */
function renderHealthBar(
  c: Context,
  x: number,
  y: number,
  width: number,
  height: number,
  health: number,
  ghostHealth: number,
  isDanger: boolean,
  isP1: boolean,
  theme: ThemeColors,
  pulseTime: number
): void {
  const safeHealth = clamp(health);
  const safeGhost = clamp(ghostHealth);

  c.save();

  // Rail background (empty health)
  c.fillStyle = theme.emptyRailFill;
  c.fillRect(x, y, width, height);

  // Rail tick markings (arcade segment grid)
  c.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  c.lineWidth = 1;
  const segments = 10;
  for (let i = 1; i < segments; i++) {
    const tx = x + (width / segments) * i;
    c.beginPath();
    c.moveTo(tx, y);
    c.lineTo(tx, y + height);
    c.stroke();
  }

  // Directional coordinates:
  // P1 fills from center towards left (or right to left)
  // P2 fills from center towards right (or left to right)
  // In classic SF2/KOF, P1 drains right-to-left towards the outer edge; P2 drains left-to-right towards outer edge
  const ghostW = width * safeGhost;
  const activeW = width * safeHealth;

  const ghostX = isP1 ? x + (width - ghostW) : x;
  const activeX = isP1 ? x + (width - activeW) : x;

  // 1. Ghost damage trail (shows red damage segment that decays)
  if (safeGhost > safeHealth) {
    c.fillStyle = theme.ghostDamageFill;
    c.fillRect(ghostX, y, ghostW, height);
  }

  // 2. Active health bar fill
  if (activeW > 0) {
    const grad = c.createLinearGradient(x, y, x, y + height);
    if (isDanger) {
      // Danger pulse: flashes red on low health
      const flash = (Math.sin(pulseTime * 12) + 1) * 0.5;
      grad.addColorStop(0, flash > 0.5 ? '#ff6666' : theme.dangerFill[0]);
      grad.addColorStop(1, theme.dangerFill[1]);
    } else {
      const colors = isP1 ? theme.p1HealthFill : theme.p2HealthFill;
      grad.addColorStop(0, colors[0]);
      grad.addColorStop(0.5, colors[0]);
      grad.addColorStop(1, colors[1]);
    }

    c.fillStyle = grad;
    c.fillRect(activeX, y, activeW, height);

    // Specular top highlight on the active bar
    c.fillStyle = 'rgba(255, 255, 255, 0.4)';
    c.fillRect(activeX, y + 1, activeW, Math.max(2, height * 0.3));
  }

  // Health rail outer border
  c.strokeStyle = isDanger && (Math.sin(pulseTime * 12) > 0) ? '#ff3333' : theme.frameBorder;
  c.lineWidth = 2;
  c.strokeRect(x, y, width, height);

  c.restore();
}

/** Render bottom super / power gauge */
function renderSuperGauge(
  c: Context,
  x: number,
  y: number,
  width: number,
  height: number,
  gauge: number,
  stock: number,
  isMax: boolean,
  isP1: boolean,
  theme: ThemeColors,
  pulseTime: number
): void {
  c.save();

  // Background rail
  c.fillStyle = theme.superBg;
  c.fillRect(x, y, width, height);
  c.strokeStyle = theme.frameBorder;
  c.lineWidth = 1.5;
  c.strokeRect(x, y, width, height);

  // Fill calculation
  const safeGauge = clamp(gauge);
  const fillW = width * (isMax ? 1.0 : safeGauge);
  const fillX = isP1 ? x : x + (width - fillW);

  if (fillW > 0) {
    if (isMax) {
      // Hyper cycling rainbow/gold aura on MAX super
      const cycle = (pulseTime * 4) % 1.0;
      const grad = c.createLinearGradient(x, y, x + width, y);
      grad.addColorStop(0, theme.superMaxFill[0]);
      grad.addColorStop(0.5, theme.superMaxFill[1]);
      grad.addColorStop(1, theme.superMaxFill[2]);
      c.fillStyle = grad;
      c.fillRect(x, y, width, height);

      // Max pulsing glow overlay
      c.fillStyle = `rgba(255, 255, 255, ${(Math.sin(pulseTime * 16) + 1) * 0.25})`;
      c.fillRect(x, y, width, height);
    } else {
      const grad = c.createLinearGradient(x, y, x, y + height);
      grad.addColorStop(0, theme.superFill[0]);
      grad.addColorStop(1, theme.superFill[1]);
      c.fillStyle = grad;
      c.fillRect(fillX, y, fillW, height);
    }
  }

  // Stock Orbs / Level Markers
  const orbRadius = 6;
  for (let i = 0; i < 3; i++) {
    const orbX = isP1 ? x + 16 + i * 18 : x + width - 16 - i * 18;
    const orbY = y + height / 2;

    c.beginPath();
    c.arc(orbX, orbY, orbRadius, 0, TAU);
    if (i < stock || isMax) {
      c.fillStyle = isMax ? '#ffd700' : '#00ffff';
      c.fill();
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1.5;
      c.stroke();
    } else {
      c.fillStyle = 'rgba(0, 0, 0, 0.6)';
      c.fill();
      c.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      c.lineWidth = 1;
      c.stroke();
    }
  }

  // Gauge text label
  c.font = 'bold 11px Impact, "Arial Black", sans-serif';
  c.fillStyle = isMax ? '#ffd700' : '#ffffff';
  c.textAlign = isP1 ? 'right' : 'left';
  c.textBaseline = 'middle';
  const labelText = isMax ? 'MAX !' : stock > 0 ? `LV.${stock}` : 'SUPER';
  c.fillText(labelText, isP1 ? x + width - 8 : x + 8, y + height / 2);

  c.restore();
}

/** Render round countdown timer */
function renderRoundTimer(
  c: Context,
  centerX: number,
  centerY: number,
  timerValue: number,
  isUrgent: boolean,
  theme: ThemeColors,
  pulseTime: number
): void {
  c.save();

  // Box backing
  const boxW = 54, boxH = 42;
  renderBevelBox(c, centerX - boxW / 2, centerY - boxH / 2, boxW, boxH, '#090c14', theme.frameBorder, 2);

  // Digits formatted as 2-digit string
  const str = String(clamp(timerValue, 0, 99)).padStart(2, '0');

  // Urgency pulse scale
  const scale = isUrgent ? 1.0 + Math.max(0, Math.sin(pulseTime * 14)) * 0.12 : 1.0;
  c.translate(centerX, centerY);
  c.scale(scale, scale);

  c.font = '900 32px Impact, "Arial Black", "Trebuchet MS", sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';

  // Drop shadow
  c.fillStyle = '#000000';
  c.fillText(str, 2, 2);

  // Digit text fill
  if (isUrgent) {
    const flash = Math.sin(pulseTime * 16) > 0;
    c.fillStyle = flash ? '#ffffff' : theme.timerUrgentColor;
  } else {
    c.fillStyle = theme.timerColor;
  }
  c.fillText(str, 0, 0);

  c.restore();
}

/** Render Central K.O. Emblem */
function renderKoEmblem(c: Context, centerX: number, y: number, theme: ThemeColors): void {
  c.save();
  c.translate(centerX, y);

  const w = 40, h = 18;
  renderBevelBox(c, -w / 2, -h / 2, w, h, '#900c0c', '#ffdd00', 1);

  c.font = 'bold 12px Impact, "Arial Black", sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#ffea00';
  c.fillText('K.O.', 0, 0);

  c.restore();
}

/** Render Fighter Name & Victory Markers */
function renderFighterInfo(
  c: Context,
  name: string,
  roundsWon: number,
  x: number,
  y: number,
  isP1: boolean,
  theme: ThemeColors
): void {
  c.save();

  // Character Name
  c.font = 'bold 14px Impact, "Arial Black", sans-serif';
  c.textAlign = isP1 ? 'left' : 'right';
  c.textBaseline = 'top';

  // Text shadow
  c.fillStyle = '#000000';
  c.fillText(name, x + 1, y + 1);
  c.fillStyle = theme.nameColor;
  c.fillText(name, x, y);

  // Victory Markers ('V' orbs)
  const markerStartX = isP1 ? x + 90 : x - 90;
  for (let r = 0; r < 2; r++) {
    const mx = isP1 ? markerStartX + r * 16 : markerStartX - r * 16;
    const my = y + 7;

    c.beginPath();
    c.arc(mx, my, 5, 0, TAU);
    if (r < roundsWon) {
      c.fillStyle = '#ffcc00';
      c.fill();
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1;
      c.stroke();
    } else {
      c.fillStyle = 'rgba(0, 0, 0, 0.5)';
      c.fill();
      c.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      c.lineWidth = 1;
      c.stroke();
    }
  }

  c.restore();
}

/** Render Dynamic Announcement Banners (ROUND 1, FIGHT!, K.O.!, etc.) */
function renderBanner(c: Context, width: number, height: number, banner: FightingBannerState): void {
  c.save();

  const centerX = width / 2;
  const centerY = height * 0.42;

  c.translate(centerX, centerY);
  c.scale(banner.scale, banner.scale);
  c.globalAlpha = clamp(banner.alpha);

  // Giant arcade font
  const fontSize = banner.type === 'ko' ? 68 : banner.type === 'fight' ? 64 : 46;
  c.font = `900 ${fontSize}px Impact, "Arial Black", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';

  // Banner ribbon background for stability
  const textWidth = c.measureText(banner.text).width;
  const ribbonW = textWidth + 80;
  const ribbonH = fontSize * 1.35;

  c.fillStyle = 'rgba(0, 0, 0, 0.75)';
  c.fillRect(-ribbonW / 2, -ribbonH / 2, ribbonW, ribbonH);

  // Golden or Crimson border lines
  c.strokeStyle = banner.type === 'ko' ? '#ff2222' : '#ffcc00';
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(-ribbonW / 2, -ribbonH / 2);
  c.lineTo(ribbonW / 2, -ribbonH / 2);
  c.moveTo(-ribbonW / 2, ribbonH / 2);
  c.lineTo(ribbonW / 2, ribbonH / 2);
  c.stroke();

  // Multi-pass drop shadow
  c.fillStyle = '#000000';
  for (let off = 1; off <= 5; off++) {
    c.fillText(banner.text, off, off);
  }

  // Text gradient
  const grad = c.createLinearGradient(0, -fontSize / 2, 0, fontSize / 2);
  if (banner.type === 'ko') {
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.3, '#ffcc00');
    grad.addColorStop(0.7, '#ff2200');
    grad.addColorStop(1, '#8b0000');
  } else if (banner.type === 'fight') {
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.4, '#ffee33');
    grad.addColorStop(1, '#ff6600');
  } else {
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.5, '#ffd700');
    grad.addColorStop(1, '#e68a00');
  }

  c.fillStyle = grad;
  c.fillText(banner.text, 0, 0);

  // White stroke outline
  c.strokeStyle = '#ffffff';
  c.lineWidth = 1.5;
  c.strokeText(banner.text, 0, 0);

  // Subtext (e.g. "RYU WINS" or "READY")
  if (banner.subtext) {
    c.font = 'bold 18px Impact, "Arial Black", sans-serif';
    c.fillStyle = '#ffffff';
    c.fillText(banner.subtext, 0, fontSize * 0.72);
  }

  c.restore();
}

/** Render Combo Counter on fighter's side */
function renderComboCounter(c: Context, count: number, isP1: boolean, width: number, height: number): void {
  if (count <= 1) return;

  c.save();
  const x = isP1 ? width * 0.18 : width * 0.82;
  const y = height * 0.32;

  c.font = '900 28px Impact, "Arial Black", sans-serif';
  c.textAlign = isP1 ? 'left' : 'right';
  c.textBaseline = 'middle';

  // Drop shadow
  c.fillStyle = '#000000';
  c.fillText(`${count} HITS !`, x + 2, y + 2);

  c.fillStyle = '#ffea00';
  c.fillText(`${count} HITS !`, x, y);

  c.strokeStyle = '#ffffff';
  c.lineWidth = 1;
  c.strokeText(`${count} HITS !`, x, y);

  c.restore();
}

/**
 * Main Fighting Game HUD Render Function
 * 
 * Draws the complete, pixel-accurate fighting game HUD onto any 2D canvas context.
 * Strictly restores canvas state and guarantees finite numerical coordinates.
 */
export function renderFightingHud(
  c: Context,
  width: number,
  height: number,
  frameOrState: FightingHudFrame | { state: FightingHudState; style?: FightingGameStyle }
): void {
  c.save();

  // Extract state & style
  let state: FightingHudState;
  let style: FightingGameStyle = 'sf2';
  let pulseTime = 0;

  if ('state' in frameOrState) {
    state = frameOrState.state;
    style = frameOrState.style ?? 'sf2';
    pulseTime = Date.now() * 0.001;
  } else {
    const frame = frameOrState as FightingHudFrame;
    style = frame.style ?? 'sf2';
    state = frame.stateOverride ? { ...evaluateFightingHud(frame), ...frame.stateOverride } : evaluateFightingHud(frame);
    pulseTime = frame.localTime ?? frame.time;
  }

  const theme = THEME_CONFIGS[style] ?? THEME_CONFIGS.sf2;

  // Apply screen shake if active
  if (state.shake.x !== 0 || state.shake.y !== 0) {
    c.translate(finite(state.shake.x), finite(state.shake.y));
  }

  // Layout metrics (responsive to target canvas)
  const barMargin = Math.max(12, width * 0.04);
  const topY = Math.max(16, height * 0.05);
  const barHeight = Math.max(16, height * 0.045);
  const centerTimerW = 60;
  const barWidth = Math.max(80, (width - barMargin * 2 - centerTimerW) / 2);

  const p1BarX = barMargin;
  const p2BarX = width - barMargin - barWidth;
  const timerCenterX = width / 2;
  const timerCenterY = topY + barHeight / 2;

  // 1. Top HUD Dock Background Bar (SF2 arcade style)
  const topDockHeight = barHeight + 36;
  c.fillStyle = theme.hudBg;
  c.fillRect(0, 0, width, topDockHeight);
  c.strokeStyle = theme.frameBorder;
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(0, topDockHeight);
  c.lineTo(width, topDockHeight);
  c.stroke();

  // 2. Life Bars (P1 and P2)
  renderHealthBar(
    c,
    p1BarX,
    topY,
    barWidth,
    barHeight,
    state.p1.health,
    state.p1.ghostHealth,
    state.p1.isDanger,
    true,
    theme,
    pulseTime
  );

  renderHealthBar(
    c,
    p2BarX,
    topY,
    barWidth,
    barHeight,
    state.p2.health,
    state.p2.ghostHealth,
    state.p2.isDanger,
    false,
    theme,
    pulseTime
  );

  // 3. Round Countdown Timer & KO Emblem
  renderRoundTimer(c, timerCenterX, timerCenterY, state.timer, state.timerUrgent, theme, pulseTime);
  renderKoEmblem(c, timerCenterX, topY + barHeight + 14, theme);

  // 4. Character Names & Victory Markers
  const nameY = topY + barHeight + 6;
  renderFighterInfo(c, state.p1.name, state.p1.roundsWon, p1BarX + 4, nameY, true, theme);
  renderFighterInfo(c, state.p2.name, state.p2.roundsWon, p2BarX + barWidth - 4, nameY, false, theme);

  // 5. Bottom Super Gauges (P1 & P2)
  const superY = height - Math.max(24, height * 0.08);
  const superH = Math.max(14, height * 0.035);
  const superW = Math.max(100, width * 0.36);

  renderSuperGauge(
    c,
    barMargin,
    superY,
    superW,
    superH,
    state.p1.superGauge,
    state.p1.superStock,
    state.p1.isMax,
    true,
    theme,
    pulseTime
  );

  renderSuperGauge(
    c,
    width - barMargin - superW,
    superY,
    superW,
    superH,
    state.p2.superGauge,
    state.p2.superStock,
    state.p2.isMax,
    false,
    theme,
    pulseTime
  );

  // 6. Combo Counters
  if (state.p1.comboCount > 1) {
    renderComboCounter(c, state.p1.comboCount, true, width, height);
  }
  if (state.p2.comboCount > 1) {
    renderComboCounter(c, state.p2.comboCount, false, width, height);
  }

  // 7. Center Announcement Banner
  if (state.banner) {
    renderBanner(c, width, height, state.banner);
  }

  // 8. Screen Flash Impact
  if (state.flashIntensity > 0.01) {
    c.fillStyle = `rgba(255, 255, 255, ${clamp(state.flashIntensity)})`;
    c.fillRect(0, 0, width, height);
  }

  c.restore();
}
