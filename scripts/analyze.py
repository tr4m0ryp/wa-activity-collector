#!/usr/bin/env python3
"""Decompose and analyse WhatsApp probe data for a single target.

Pulls live from the GCP server's SQLite over gcloud-ssh (WAL-safe, doesn't
interrupt collection), classifies the target's devices by RTT signature,
maps phone RTT to behavioural states, and renders a behavioural timeline
in local time.

Usage:
    python3 scripts/analyze.py <target_name>
    python3 scripts/analyze.py mirthe-lynn --mode all
    python3 scripts/analyze.py 31628326588 --since 24h
    python3 scripts/analyze.py mirthe-lynn --source file --file exports/foo.csv
"""
from __future__ import annotations
import argparse, csv, statistics, subprocess, sys, tempfile, os
from collections import defaultdict, Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path

VM_NAME = os.environ.get('WA_VM_NAME', 'wa-collector')
ZONE = os.environ.get('WA_ZONE', 'europe-west4-a')
DB_PATH = '/opt/wa-collector/data/activity.db'

# RTT bands (ms above per-device baseline) for phone state classification
PHONE_STATE_BANDS = [
    ('foreground',    0,    200),
    ('minimized',     200,  500),
    ('screen-on-bg',  500,  1500),
    ('screen-off',    1500, 2500),
    ('deep-sleep',    2500, 99999),
]

LABEL = {
    'BOTH':    'phone + laptop both online',
    'LAPTOP':  'at desk (laptop online)',
    'PHONE':   'mobile (phone only)',
    'OFFLINE': 'fully off the grid',
}


def parse_since(s: str | None) -> int | None:
    """Return ms-epoch lower bound. Accepts '24h', '3d', or ISO datetime."""
    if s is None: return None
    if s.endswith('h'): return int(datetime.now(timezone.utc).timestamp()*1000) - int(s[:-1])*3600*1000
    if s.endswith('d'): return int(datetime.now(timezone.utc).timestamp()*1000) - int(s[:-1])*86400*1000
    if s.endswith('m'): return int(datetime.now(timezone.utc).timestamp()*1000) - int(s[:-1])*60*1000
    return int(datetime.fromisoformat(s).timestamp()*1000)


def fetch_from_server(target: str, since_ms: int | None) -> tuple[dict, list[dict]]:
    """SSH to VM and dump target metadata + probe rows as CSV. Returns (target_row, probes)."""
    where_extra = f" AND p.sent_at_ms >= {since_ms}" if since_ms else ''
    target_quoted = target.replace("'", "''")
    sql = f"""
    .mode csv
    .headers on
    SELECT id, jid, display_name, account_id, added_at_ms FROM targets
      WHERE display_name = '{target_quoted}' OR jid = '{target_quoted}'
        OR jid LIKE '{target_quoted}@%' LIMIT 1;
    """
    r = subprocess.run(
        ['gcloud', 'compute', 'ssh', VM_NAME, '--zone', ZONE, '--quiet',
         '--command', f"sqlite3 -csv -header {DB_PATH} \"SELECT id, jid, display_name, account_id, added_at_ms FROM targets WHERE display_name='{target_quoted}' OR jid='{target_quoted}' OR jid LIKE '{target_quoted}@%' LIMIT 1\""],
        capture_output=True, text=True, check=False,
    )
    if r.returncode != 0 or not r.stdout.strip():
        sys.exit(f"could not resolve target '{target}': {r.stderr or '(no match)'}")
    target_rows = list(csv.DictReader(r.stdout.strip().splitlines()))
    if not target_rows:
        sys.exit(f"no target found for '{target}'")
    target_row = target_rows[0]
    target_id = target_row['id']
    probe_query = (
        f"SELECT id, probe_msg_id, sent_at_ms, ack_at_ms, rtt_ms, ack_type, ack_jid, timed_out "
        f"FROM probe_events WHERE target_id={target_id}{where_extra} ORDER BY sent_at_ms ASC"
    )
    r2 = subprocess.run(
        ['gcloud', 'compute', 'ssh', VM_NAME, '--zone', ZONE, '--quiet',
         '--command', f"sqlite3 -csv -header {DB_PATH} \"{probe_query}\""],
        capture_output=True, text=True, check=False,
    )
    if r2.returncode != 0:
        sys.exit(f"probe dump failed: {r2.stderr}")
    probes = list(csv.DictReader(r2.stdout.strip().splitlines()))
    return target_row, probes


def fetch_from_file(path: str) -> tuple[dict, list[dict]]:
    with open(path) as f:
        probes = list(csv.DictReader(f))
    return {'id': '?', 'jid': '?', 'display_name': Path(path).stem, 'account_id': '?', 'added_at_ms': '0'}, probes


def classify_devices(probes: list[dict]) -> dict[str, dict]:
    """Group acks by ack_jid, compute per-device RTT signature, label phone/laptop."""
    by_jid: dict[str, list[int]] = defaultdict(list)
    types_by_jid: dict[str, Counter] = defaultdict(Counter)
    for p in probes:
        if p['ack_jid'] and p['rtt_ms']:
            by_jid[p['ack_jid']].append(int(p['rtt_ms']))
            types_by_jid[p['ack_jid']][p['ack_type']] += 1
    devices = {}
    for jid, rtts in by_jid.items():
        if len(rtts) < 5: continue
        median = statistics.median(rtts)
        p10 = statistics.quantiles(rtts, n=10)[0] if len(rtts) >= 10 else min(rtts)
        kind = 'laptop' if median < 800 else ('phone' if median > 1500 else 'mid')
        devices[jid] = {
            'jid': jid, 'kind': kind, 'count': len(rtts),
            'median': median, 'mean': statistics.mean(rtts), 'p10': p10,
            'min': min(rtts), 'max': max(rtts),
            'ack_types': dict(types_by_jid[jid]),
        }
    return devices


def phone_state_breakdown(phone_probes: list[dict], baseline_ms: float) -> list[tuple[str, int, float]]:
    """For each phone state band, return (label, n, fraction)."""
    counts = Counter()
    total = 0
    for p in phone_probes:
        if not p['rtt_ms']: continue
        adj = int(p['rtt_ms']) - baseline_ms
        for label, lo, hi in PHONE_STATE_BANDS:
            if lo <= adj < hi:
                counts[label] += 1
                break
        total += 1
    return [(label, counts[label], counts[label]/total if total else 0) for label, _, _ in PHONE_STATE_BANDS]


def per_minute_classify(probes: list[dict], laptop_jid: str | None, phone_jid: str | None) -> dict:
    """Bucket probes per UTC minute, classify each minute as LAPTOP/PHONE/BOTH/OFFLINE/None."""
    buckets: dict[datetime, dict] = {}
    for p in probes:
        dt = datetime.fromtimestamp(int(p['sent_at_ms'])/1000, tz=timezone.utc).replace(second=0, microsecond=0)
        if dt not in buckets:
            buckets[dt] = {'L': 0, 'P': 0, 'T': 0}
        if p['timed_out'] == '1':
            buckets[dt]['T'] += 1
        elif p['ack_jid'] == laptop_jid:
            buckets[dt]['L'] += 1
        elif p['ack_jid'] == phone_jid:
            buckets[dt]['P'] += 1
    classified = []
    for dt in sorted(buckets):
        d = buckets[dt]
        if d['L'] >= 2 and d['P'] >= 2: s = 'BOTH'
        elif d['L'] >= 2 and d['P'] == 0: s = 'LAPTOP'
        elif d['P'] >= 2 and d['L'] == 0: s = 'PHONE'
        elif d['L'] == 0 and d['P'] == 0 and d['T'] >= 2: s = 'OFFLINE'
        else: s = None
        classified.append((dt, s, d))
    return classified


def smooth_and_coalesce(classified: list) -> list[tuple]:
    """Smooth tiny BOTH blips into surrounding state, then coalesce contiguous minutes."""
    def surrounded_by(idx, target):
        L = sum(1 for j in range(max(0,idx-4), min(len(classified),idx+5)) if classified[j][1] == 'LAPTOP')
        P = sum(1 for j in range(max(0,idx-4), min(len(classified),idx+5)) if classified[j][1] == 'PHONE')
        return (L > P) if target == 'LAPTOP' else (P > L)

    smoothed = []
    for i, (t, s, d) in enumerate(classified):
        if s == 'BOTH':
            if surrounded_by(i, 'LAPTOP'): smoothed.append((t, 'LAPTOP', True))
            elif surrounded_by(i, 'PHONE'): smoothed.append((t, 'PHONE', True))
            else: smoothed.append((t, 'BOTH', False))
        else:
            smoothed.append((t, s, False))

    # absorb 1-2 min PHONE inserts inside LAPTOP runs (and vice versa)
    cleaned = []
    i = 0
    while i < len(smoothed):
        if cleaned and cleaned[-1][1] in ('LAPTOP', 'PHONE') and smoothed[i][1] not in (None, cleaned[-1][1]):
            j = i
            while j < len(smoothed) and smoothed[j][1] == smoothed[i][1]:
                j += 1
            run_len = j - i
            if run_len <= 2 and j < len(smoothed) and smoothed[j][1] == cleaned[-1][1]:
                for k in range(i, j):
                    cleaned.append((smoothed[k][0], cleaned[-1][1], True))
                i = j
                continue
        cleaned.append(smoothed[i])
        i += 1

    # coalesce
    runs = []
    cur_state = None; cur_start = None; prev = None; touches = 0
    for t, s, is_touch in cleaned:
        if s is None: continue
        if cur_state is None:
            cur_state = s; cur_start = t; prev = t; touches = 1 if is_touch else 0
        elif s == cur_state and (t - prev).total_seconds() <= 120:
            prev = t
            if is_touch: touches += 1
        else:
            runs.append((cur_start, prev + timedelta(minutes=1), cur_state, touches))
            cur_state = s; cur_start = t; prev = t; touches = 1 if is_touch else 0
    if cur_state is not None:
        runs.append((cur_start, prev + timedelta(minutes=1), cur_state, touches))
    return runs


def render_devices(devices: dict, target_name: str):
    print(f"\n  DEVICES seen for {target_name}")
    print(f"  {'-'*54}")
    print(f"  {'kind':<10} {'jid':<28} {'n':>6} {'med':>6} {'p10':>5}  ack_types")
    for d in sorted(devices.values(), key=lambda x: x['median']):
        types = ', '.join(f"{k}:{v}" for k, v in sorted(d['ack_types'].items(), key=lambda x:-x[1]))
        print(f"  {d['kind']:<10} {d['jid']:<28} {d['count']:>6,} {d['median']:>4.0f}ms {d['p10']:>3.0f}ms  {types}")


def render_phone_states(breakdown: list[tuple], baseline: float, total: int):
    print(f"\n  PHONE state distribution")
    print(f"  (RTT thresholds adjusted by phone baseline = {baseline:.0f}ms)")
    print(f"  {'-'*54}")
    for label, n, frac in breakdown:
        secs = n / 2  # 2Hz probing
        bar = '#' * int(frac*100*0.5)
        print(f"  {label:<14} {n:>5}  {frac*100:5.1f}%  ({secs:.0f}s probed)  {bar}")


def render_timeline(runs: list, tz_offset_hours: int, target_name: str):
    tz = timedelta(hours=tz_offset_hours)
    print()
    print('  ' + '+' + '-'*56 + '+')
    print(f"  |  {target_name:<52}  |")
    print(f"  |  WhatsApp presence timeline  (UTC{tz_offset_hours:+d}){' '*(30 - (5 if abs(tz_offset_hours)<10 else 6))}|")
    print('  ' + '+' + '-'*56 + '+')

    days = defaultdict(list)
    for s, e, st, touches in runs:
        local_s = s + tz
        days[local_s.date()].append((local_s, e + tz, st, touches))

    for day, day_runs in sorted(days.items()):
        print(f"\n  {day.strftime('%A, %d %B %Y').upper()}")
        print(f"  {'-'*54}")
        print(f"  {'time':<13} {'duration':>9}   what was happening")
        for s, e, st, touches in day_runs:
            mins = round((e - s).total_seconds() / 60)
            dur = f"{mins//60}h {mins%60:02d}min" if mins >= 60 else f"{mins} min"
            time_str = f"{s.strftime('%H:%M')}-{e.strftime('%H:%M')}"
            suffix = f"  (phone checked {touches}x)" if touches >= 2 and st == 'LAPTOP' else ''
            print(f"  {time_str:<13} {dur:>9}   {LABEL[st]}{suffix}")

    totals = defaultdict(float)
    for s, e, st, _ in runs:
        totals[st] += (e - s).total_seconds() / 60
    grand = sum(totals.values())

    print()
    print(f"  {'='*54}")
    print(f"  TOTAL OBSERVED")
    print(f"  {'='*54}")
    for st in ['LAPTOP', 'PHONE', 'BOTH', 'OFFLINE']:
        if totals[st] == 0: continue
        m = totals[st]; pct = 100*m/grand
        h, mn = int(m//60), int(m%60)
        dur = f"{h}h {mn:02d}min" if h else f"{int(m)} min"
        bar = '#' * int(pct*0.4)
        print(f"  {LABEL[st]:<32} {dur:>9}   {pct:5.1f}%  {bar}")
    print(f"\n  observed across {grand/60:.1f}h")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('target', help='target display_name, jid, or phone number prefix')
    p.add_argument('--since', help='lookback like "24h", "3d", or ISO datetime')
    p.add_argument('--tz', type=int, default=2, help='timezone offset hours (default 2 for NL CEST)')
    p.add_argument('--mode', choices=['timeline', 'devices', 'phone-states', 'all'], default='timeline')
    p.add_argument('--source', choices=['server', 'file'], default='server')
    p.add_argument('--file', help='CSV file (when --source=file)')
    args = p.parse_args()

    since_ms = parse_since(args.since)

    if args.source == 'file':
        if not args.file: sys.exit('--file required when --source=file')
        target_row, probes = fetch_from_file(args.file)
    else:
        target_row, probes = fetch_from_server(args.target, since_ms)

    if not probes:
        sys.exit(f"no probes for target '{args.target}'")

    target_name = target_row.get('display_name') or target_row['jid'].split('@')[0]
    devices = classify_devices(probes)
    laptop_jid = next((j for j, d in devices.items() if d['kind'] == 'laptop'), None)
    phone_jid  = next((j for j, d in devices.items() if d['kind'] == 'phone'),  None)

    if args.mode in ('devices', 'all'):
        render_devices(devices, target_name)

    if args.mode in ('phone-states', 'all') and phone_jid:
        phone_probes = [p for p in probes if p['ack_jid'] == phone_jid]
        baseline = devices[phone_jid]['p10']
        breakdown = phone_state_breakdown(phone_probes, baseline)
        render_phone_states(breakdown, baseline, len(phone_probes))

    if args.mode in ('timeline', 'all'):
        classified = per_minute_classify(probes, laptop_jid, phone_jid)
        runs = smooth_and_coalesce(classified)
        if not runs:
            print("\n  no classifiable activity windows found.")
        else:
            render_timeline(runs, args.tz, target_name)


if __name__ == '__main__':
    main()
