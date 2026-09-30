#!/usr/bin/env python3
"""Screen review findings with the Jev claim-vs-source judge (advisory only).

Each finding is {"id", "claim", "file", "line", "line_end"?}. The tool cuts a small excerpt
from the cited repository file and asks the jev-harness `claim-vs-source` pack whether the
excerpt supports the claim. Output: one JSON report; a finding is NEVER dropped or changed
because of a verdict - triage stays with code-owned policy and a human.

Verdicts: supported | contradicted | unsure | unavailable.
  unavailable = no backend (no TypeSafe key reachable), pack error, unreadable/blocked file,
                or --dry-run. Nothing is sent to the network in those cases.

Live use needs a key in the environment of the process that runs this tool, supplied by the
owner (TYPESAFE_API_KEY, TYPESAFE_API_KEY_COMMAND or JEV_KEY_FILE). This tool never reads,
prints or stores a key; the harness resolves it. Only the claim text and a short excerpt of
public repository source are sent; private catalogs, kits and secrets are refused.

Usage:
  python tools/jev-screen-findings.py --findings findings.json [--out report.json] [--dry-run]
         [--decider rest|stub|replay] [--context 8] [--limit 60]
"""
import argparse, glob, json, os, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BLOCKED_PARTS = ('avs presets', 'assets', '.git', 'node_modules', '.tmp', 'golden')
BLOCKED_SUFFIX = ('.env', '.pem', '.key', '.pfx', '.p12')
MAX_EXCERPT = 1800


def harness_dir():
    d = os.environ.get('JEV_HARNESS_DIR')
    if d and (Path(d) / 'jev_harness').is_dir():
        return Path(d)
    hits = sorted(glob.glob(str(Path.home() / '.claude' / 'plugins' / 'cache' / 'jev-tools' / 'jev-harness' / '*' / 'jev_harness')))
    return Path(hits[-1]).parent if hits else None


def excerpt(rel, line, end, ctx):
    p = (ROOT / rel).resolve()
    if ROOT not in p.parents and p != ROOT:
        raise ValueError('outside repository')
    low = [s.lower() for s in p.relative_to(ROOT).parts]
    if any(b in low for b in BLOCKED_PARTS) or p.name.lower().endswith(BLOCKED_SUFFIX):
        raise ValueError('blocked path')
    text = p.read_text(encoding='utf-8', errors='replace').splitlines()
    a = max(1, int(line) - ctx)
    b = min(len(text), int(end or line) + ctx)
    body = '\n'.join(f'{n}: {text[n - 1]}' for n in range(a, b + 1))
    return body[:MAX_EXCERPT]


def judge(hd, decider, state):
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    cmd = [sys.executable, '-m', 'jev_harness', 'judge', '--pack', 'claim-vs-source', '--state', '-', '--no-log']
    if decider:
        cmd += ['--decider', decider]
    r = subprocess.run(cmd, input=json.dumps(state), text=True, capture_output=True, cwd=str(hd), env=env, timeout=30)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return {'error': 'unparseable harness output', 'stderr': r.stderr[-300:]}


def classify(out):
    if out.get('error') or out.get('is_mock'):
        return 'unavailable', out.get('error') or 'simulated backend'
    tags = ' '.join(m.get('tag', '') if isinstance(m, dict) else str(m) for m in (out.get('matched') or []))
    if 'fail:' in tags:
        return 'contradicted', tags
    if 'unsure:' in tags:
        return 'unsure', tags
    return 'supported', 'pass'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--findings', required=True)
    ap.add_argument('--out')
    ap.add_argument('--dry-run', action='store_true', help='build the excerpts, call nothing')
    ap.add_argument('--decider', default=None)
    ap.add_argument('--context', type=int, default=8)
    ap.add_argument('--limit', type=int, default=60)
    a = ap.parse_args()
    findings = json.loads(Path(a.findings).read_text(encoding='utf-8'))[:a.limit]
    hd = harness_dir()
    report, counts = [], {}
    for f in findings:
        row = {'id': f.get('id'), 'file': f.get('file'), 'line': f.get('line')}
        try:
            ex = excerpt(f['file'], f['line'], f.get('line_end'), a.context)
        except Exception as e:
            row.update(verdict='unavailable', reason=f'excerpt: {e}')
        else:
            if a.dry_run or hd is None:
                row.update(verdict='unavailable', reason='dry-run' if a.dry_run else 'jev-harness not found', excerpt_chars=len(ex))
            else:
                out = judge(hd, a.decider, {'claim': str(f['claim'])[:600], 'source_excerpt': ex})
                v, why = classify(out)
                row.update(verdict=v, reason=why, backend=out.get('backend'), answers=out.get('answers'))
        counts[row['verdict']] = counts.get(row['verdict'], 0) + 1
        report.append(row)
    result = {'advisory_only': True, 'counts': counts, 'findings': report}
    text = json.dumps(result, indent=2, default=str)
    if a.out:
        Path(a.out).write_text(text, encoding='utf-8')
    print(text if not a.out else json.dumps({'advisory_only': True, 'counts': counts, 'out': a.out}))


if __name__ == '__main__':
    main()
