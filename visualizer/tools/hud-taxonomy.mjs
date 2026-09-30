// Deterministic local taxonomy. Source wording is inspected, never emitted. No remote calls.
import { readFileSync } from 'node:fs';
export const DECISIONS = JSON.parse(readFileSync(new URL('./hud-taxonomy.decisions.json', import.meta.url), 'utf8'));
export const PACK_LABELS = Object.freeze(['Showcase', 'Arcade · Fighting', 'Arcade · Action', 'Neo Geo', 'Vector & Early Arcade', '8/16-bit Consoles', '32/64-bit Consoles', '128-bit Consoles', 'Handheld & LCD', 'Home Computers', 'PC Classic', 'Flight, Space & Racing', 'Modern', 'Rhythm', 'Cinema & TV', 'Anime & Mecha']);
export const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const ROLE_RULES = Object.freeze([
  [/^player-status-gauge$/, 'bar'], [/^radar-or-counter$/, 'counter'], [/^countdown-timer-boss$/, 'timer'], [/^command-selector$/, 'slots'], [/^minimap-subweapon$/, 'radar'],
  [/chassis|recessed-beveled-housing/, 'panel'], [/target-blip-layer/, 'radar'], [/character-swap-box/, 'slots'], [/cipher-telemetry-feed/, 'terminal'], [/vertical-zoom-scale/, 'bar'], [/bounty-card/, 'portrait'],
  [/hud-panel|header-panel|header-dock|bottom-hud-group|score-header|(?:dock|banner|sidebar|console|cluster)$/, 'panel'],
  [/viewport|^arena-|^background-/, 'viewport'], [/reticle|crosshair|pipper|targeting|lock-on/, 'reticle'], [/radar|minimap|motion-tracker|compass|sweep|doppler/, 'radar'],
  [/portrait|face|emblem|paperdoll|damage-doll|character.card|status.card/, 'portrait'], [/globe|orb|fluid|radial|ring|speedometer|rotary|curved|sync.graph/, 'dial'],
  [/timer|countdown|clock|lap|elapsed/, 'timer'], [/counter|score|numeric|digit|ammo|credit|currency|percentage|readout|multiplier/, 'counter'],
  [/bargraph|equalizer|spectrogram|spectrum|cymatic|frequency|six-band|channel.level/, 'spectrum'], [/oscillo|lissajous|waveform|ecg|cardio/, 'scope'],
  [/rain|glyph.stream/, 'rain'], [/terminal|typewriter|text.feed|hex|assembly|directive/, 'terminal'], [/matrix|power-meter|keycard/, 'matrix'],
  [/inventory|slot|item.grid|carousel|selector/, 'slots'], [/lives|heart|medal|pip/, 'pips'], [/warning|alert|danger|overload|hazard/, 'warning'], [/rank|stylish|combo|chain/, 'combo'],
  [/cursor|blink|label|glyph|text/, 'label'], [/vitality|health|life|energy|stamina|magic|power|shield|armor|fuel|gauge|meter|rail|segment|super|bar/, 'bar'],
]);
export function classify(role, driver = '', observed = '') {
  const r = String(role ?? '').toLowerCase();
  // Dock bars keep their function rather than being swallowed by the container rule.
  if (/(?:vitality|magic|charge|fuel|shield|armor|power|weapon|ammo|energy).*dock/.test(r)) return { kind: 'bar', confidence: 'rule' };
  for (const [pattern, kind] of ROLE_RULES) if (pattern.test(r)) return { kind, confidence: 'rule' };
  for (const [pattern, kind] of ROLE_RULES.slice(2)) if (pattern.test(String(driver).toLowerCase())) return { kind, confidence: 'driver' };
  // The observed state is private prose; only a closed vocabulary lookup can influence the result.
  for (const [pattern, kind] of ROLE_RULES.slice(2)) if (pattern.test(String(observed).toLowerCase())) return { kind, confidence: 'observed' };
  return { kind: null, confidence: 'fallback' };
}
export function driverSignal(driver = '', kind = 'bar') {
  const s = String(driver).toLowerCase();
  const patterns = [[/left.channel/, 'audio.bandL.mid'], [/right.channel/, 'audio.bandR.mid'], [/high.band/, 'audio.band.high'], [/low.band/, 'audio.band.low'], [/transient|onset/, 'audio.onset.any.env'], [/track.elapsed/, 'track.position'], [/remaining|countdown/, 'interval.remaining01'], [/section|progress/, 'interval.progress'], [/beat|cadence/, 'clock.beatPhase'], [/rms|volume|loudness|energy/, 'audio.rms']];
  for (const [re, signal] of patterns) if (re.test(s)) return { signal, fallback: false };
  if (kind === 'bar') return { signal: 'interval.remaining01', fallback: true };
  if (kind === 'counter') return { signal: 'interval.progress', fallback: true };
  if (kind === 'timer') return { signal: 'interval.remaining', fallback: true };
  return { signal: DECISIONS.unknownDriver, fallback: true };
}
export function familyOf(source) {
  const s = `${source.hud_family ?? ''} ${source.family ?? ''} ${(source.elements ?? []).map(e => e.role).join(' ')} ${source.title ?? ''}`.toLowerCase();
  const families = [[/rhythm|music/, 'rhythm'], [/fight|duel|round.timer/, 'fighting'], [/shmup|shoot.em.up/, 'shmup'], [/platform/, 'platformer'], [/brawl/, 'brawler'], [/rac|speedometer/, 'racing'], [/sport/, 'sports'], [/puzzle/, 'puzzle'], [/moba/, 'moba'], [/mmo/, 'mmo'], [/rpg|role.play/, 'rpg'], [/rts|strategy|command.selector/, 'rts'], [/fps|first.person/, 'fps'], [/flight|aviation/, 'flight'], [/mecha/, 'mecha'], [/cockpit/, 'cockpit'], [/terminal/, 'terminal'], [/scifi|science.fiction|fui/, 'scifi']];
  return families.find(([re]) => re.test(s))?.[1] ?? 'misc';
}
export function packOf(source, family = familyOf(source)) {
  const medium = String(source.medium ?? '').toLowerCase(), platform = `${source.platform ?? source.provenance?.platform ?? ''} ${String(source.key ?? source.kitName ?? '').split('-').at(-1)}`.toLowerCase();
  if (/anime|mecha/.test(medium)) return 'Anime & Mecha';
  if (/cinema|film|movie|television|^tv$/.test(medium)) return 'Cinema & TV';
  if (family === 'rhythm') return 'Rhythm';
  if (/neo.?geo/.test(platform)) return 'Neo Geo';
  if (/vector|early.arcade|atari.?2600|vectrex/.test(platform)) return 'Vector & Early Arcade';
  if (/handheld|game.?boy|gba|nds|3ds|psp|vita|lcd|game.?gear|lynx|wonderswan/.test(platform)) return 'Handheld & LCD';
  if (/commodore|c64|amiga|amstrad|spectrum|msx|home.computer/.test(platform)) return 'Home Computers';
  if (/nes|snes|famicom|genesis|mega.drive|master.system|pc.engine|turbografx/.test(platform)) return '8/16-bit Consoles';
  if (/saturn|ps1|playstation.1|n64|nintendo.64|32bit|64bit/.test(platform)) return '32/64-bit Consoles';
  if (/ps2|dreamcast|gamecube|xbox(?![ .]?(?:one|series))|128bit/.test(platform)) return '128-bit Consoles';
  if (/arcade|cps|mame/.test(platform)) return family === 'fighting' ? 'Arcade · Fighting' : 'Arcade · Action';
  if (['flight', 'cockpit', 'racing'].includes(family)) return 'Flight, Space & Racing';
  if (/dos|pc.classic|windows.9|ega|vga|pc$/.test(platform) && (!source.year || source.year < 2001)) return 'PC Classic';
  return 'Modern';
}
export function eraOf(pack) { return ({ 'Arcade · Fighting': 'arcade', 'Arcade · Action': 'arcade', 'Neo Geo': 'arcade', 'Vector & Early Arcade': 'vector', '8/16-bit Consoles': '16bit', '32/64-bit Consoles': '32bit', '128-bit Consoles': '128bit', 'Handheld & LCD': 'handheld', 'Home Computers': 'home', 'PC Classic': 'pc-classic', 'Cinema & TV': 'cinema', 'Anime & Mecha': 'anime' })[pack] ?? 'modern'; }
