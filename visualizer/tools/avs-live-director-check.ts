import { AvsLiveDirector, AvsLiveLoadGuard, resolveAvsLiveBarPosition } from '../src/avs/live-director.ts';

let assertions = 0;
function equal(actual: unknown, expected: unknown, label: string): void {
  assertions++;
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

const bank = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
const director = new AvsLiveDirector(1234);
director.setBank(bank, 'a', 0);
equal(director.diagnostics().bankSize, 3, 'registered bank is visible to auto-update');
equal(director.diagnostics().currentId, 'a', 'registered bank keeps the rendered selection');
equal(director.update(99, 1), null, 'disabled director holds');
director.enabled = true;
director.select('a', 0, 1);
equal(director.update(1.999, 1), null, 'high-energy dwell respects two bars');
const high = director.update(2, 1);
equal(high === null, false, 'high-energy boundary switches');
equal(high?.id === 'a', false, 'director never immediately repeats current preset');
equal(director.update(100, 1), null, 'pending async selection prevents overlapping switch');
equal(director.diagnostics().pendingId, high?.id, 'pending load is observable for live diagnostics');
director.commit(high!.id, 2, 1);
director.select(high!.id, 10, 0);
equal(director.update(21.999, 0), null, 'low-energy dwell reaches twelve bars');
equal(director.update(22, 0) === null, false, 'low-energy boundary switches');
const left = new AvsLiveDirector(0x55aa);
const right = new AvsLiveDirector(0x55aa);
for (const candidate of [left, right]) {
  candidate.enabled = true;
  candidate.setBank(bank, 'a', 0);
  candidate.select('a', 0, 1);
}
equal(left.update(2, .8, .4)?.id, right.update(2, .8, .4)?.id, 'same seed and timeline are deterministic');
const one = new AvsLiveDirector();
one.enabled = true;
one.setBank([{ id: 'only', name: 'Only' }], 'only', 0);
equal(one.update(100, 1), null, 'single-preset bank cannot auto-switch');
equal(resolveAvsLiveBarPosition(0, 0, 4, 120), 2, 'unlocked timeline falls back to audio-clock bars');
equal(resolveAvsLiveBarPosition(7.25, 128, 99, 120), 7.25, 'locked timeline keeps tracked musical bars');
equal(resolveAvsLiveBarPosition(0, 0, 0, 120), 0, 'no-audio clock does not advance');
equal(resolveAvsLiveBarPosition(0, 0, 4, 120), resolveAvsLiveBarPosition(0, 0, 4, 120), 'paused audio clock remains stationary');
const guard=new AvsLiveLoadGuard(),first=guard.begin(),second=guard.begin();
equal(guard.isCurrent(first),false,'new load supersedes older fetch');
equal(guard.isCurrent(second),true,'latest load remains current');
guard.finish(first);equal(guard.busy,true,'stale completion cannot clear current busy state');
guard.finish(second);equal(guard.busy,false,'current completion clears busy state');
console.log(`avs-live-director-check: PASS (${assertions} assertions)`);
