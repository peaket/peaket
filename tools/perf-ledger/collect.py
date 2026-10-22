"""측정 1회의 산출물을 perf-ledger/runs/<run-id>/에 모은다. 규칙: docs/perf-ledger.md §2·§3.

사용 예:
  python tools/perf-ledger/collect.py --run-id 2026-11-02-k1-v0-local-10k --kpi K1 --version v0 \
    --profile local-10k --users 10000 --rps 20000 --duration 600 --warmup 120 \
    --scenario peaket-loadtest/k1-entry.js --k6-summary ./summary.json \
    --prom-url http://localhost:9090 --start 2026-11-02T10:00:00Z --end 2026-11-02T10:10:00Z \
    --queries tools/perf-ledger/queries.example.txt --infra-file ./infra.txt --invariants ./invariants.csv
  python tools/perf-ledger/collect.py --selftest
"""
import argparse
import csv
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledgerlib as L  # noqa: E402


def log(lines, msg):
    print(msg)
    lines.append(f'{L.iso_utc(time.time())} {msg}')


def git_commit(cwd):
    try:
        out = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=cwd, capture_output=True, text=True, timeout=10)
        return out.stdout.strip() if out.returncode == 0 else None
    except Exception:
        return None


def read_queries(path):
    qs = []
    with io.open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            name, q = line.split('=', 1)
            qs.append((name.strip(), q.strip()))
    return qs


def export_prometheus(prom_url, queries, start, end, step, out_dir, lines):
    os.makedirs(out_dir, exist_ok=True)
    for name, q in queries:
        params = urllib.parse.urlencode({'query': q, 'start': start, 'end': end, 'step': step})
        url = prom_url.rstrip('/') + '/api/v1/query_range?' + params
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = json.load(r)
        except Exception as e:  # 네트워크·쿼리 오류는 기록하고 계속
            log(lines, f'prometheus {name}: 실패 {type(e).__name__}: {e}')
            continue
        results = (data.get('data') or {}).get('result') or []
        path = os.path.join(out_dir, name + '.csv')
        n = 0
        with io.open(path, 'w', encoding='utf-8', newline='') as f:
            w = csv.writer(f)
            w.writerow(['ts', 'value', 'labels'])
            for series in results:
                labels = json.dumps(series.get('metric', {}), ensure_ascii=False, sort_keys=True)
                for ts, v in series.get('values', []):
                    w.writerow([ts, v, labels])
                    n += 1
        log(lines, f'prometheus {name}: {len(results)} 시계열, {n} 점 → metrics/{name}.csv')


def copy_into(src, run_dir, dest_name=None, lines=None):
    if not src:
        return None
    if not os.path.exists(src):
        log(lines, f'첨부 없음: {src}')
        return None
    dest = os.path.join(run_dir, dest_name or os.path.basename(src))
    if os.path.isdir(src):
        shutil.copytree(src, dest, dirs_exist_ok=True)
    else:
        shutil.copy2(src, dest)
    log(lines, f'첨부: {src} → {os.path.relpath(dest, run_dir)}')
    return os.path.relpath(dest, run_dir).replace('\\', '/')


def write_sums(run_dir):
    entries = []
    for base, _, files in os.walk(run_dir):
        for fn in sorted(files):
            if fn == 'SHA256SUMS':
                continue
            p = os.path.join(base, fn)
            h = hashlib.sha256()
            with open(p, 'rb') as f:
                for chunk in iter(lambda: f.read(1 << 20), b''):
                    h.update(chunk)
            entries.append((h.hexdigest(), os.path.relpath(p, run_dir).replace('\\', '/')))
    with io.open(os.path.join(run_dir, 'SHA256SUMS'), 'w', encoding='utf-8', newline='\n') as f:
        for digest, rel in sorted(entries, key=lambda e: e[1]):
            f.write(f'{digest}  {rel}\n')
    return len(entries)


def collect(a, root):
    lines = []
    run_dir = os.path.join(root, L.RUNS, a.run_id)
    if os.path.exists(run_dir) and not a.force:
        raise SystemExit(f'이미 있는 측정 폴더입니다: {run_dir} (--force로 덮어쓰기)')
    os.makedirs(run_dir, exist_ok=True)
    log(lines, f'측정 폴더: {run_dir}')

    k6 = None
    if a.k6_summary:
        rel = copy_into(a.k6_summary, run_dir, 'k6-summary.json', lines)
        if rel:
            k6 = L.k6_metrics(L.load_json(os.path.join(run_dir, 'k6-summary.json')))
            log(lines, f'k6: p99={k6["p99_ms"]} ms, 오류율={k6["error_rate"]}, 요청={k6["requests"]}, 못 보낸 반복={k6["dropped_iterations"]}')

    start = L.parse_time(a.start) if a.start else None
    end = L.parse_time(a.end) if a.end else None
    if a.prom_url and a.queries and start and end:
        export_prometheus(a.prom_url, read_queries(a.queries), start, end, a.step, os.path.join(run_dir, 'metrics'), lines)
    elif a.prom_url:
        log(lines, 'prometheus: --queries, --start, --end가 모두 있어야 내보냅니다. 건너뜀')

    attachments = {}
    for key, src, name in [('infra', a.infra_file, 'infra.txt'), ('invariants', a.invariants, 'invariants.csv'),
                           ('cost', a.cost_file, 'cost.csv'), ('timeline', a.timeline, 'timeline.csv')]:
        rel = copy_into(src, run_dir, name, lines)
        if rel:
            attachments[key] = rel
    for extra in a.extra or []:
        rel = copy_into(extra, run_dir, None, lines)
        if rel:
            attachments.setdefault('extra', []).append(rel)

    k6_plan = L.k6_plan_parse(a.k6_plan) if getattr(a, 'k6_plan', None) else None
    k6_eval = None
    if getattr(a, 'confusion', None):
        rel = copy_into(a.confusion, run_dir, 'confusion.csv', lines)
        if rel:
            attachments['confusion'] = rel
            k6_eval = L.k6_eval_from_confusion(os.path.join(run_dir, 'confusion.csv'), k6_plan)
            log(lines, f'K6 평가: {L.k6_summary(k6_eval)}')
    k6_cost = None
    if getattr(a, 'bot_cost', None) and getattr(a, 'bot_prices', None):
        rel = copy_into(a.bot_cost, run_dir, 'bot_cost.csv', lines)
        relp = copy_into(a.bot_prices, run_dir, 'bot_prices.json', lines)
        if rel and relp:
            attachments['bot_cost'], attachments['bot_prices'] = rel, relp
            k6_cost = L.k6_cost(os.path.join(run_dir, 'bot_cost.csv'),
                                L.load_json(os.path.join(run_dir, 'bot_prices.json')), a.exchange_rate)
            log(lines, f'K6 1장당 획득 비용: {L.k6_summary(None, k6_cost)}')

    valid, reason = True, None
    if k6 and (k6['dropped_iterations'] or 0) > 0:
        valid, reason = False, f'발생기 병목: dropped_iterations={k6["dropped_iterations"]}'
    if a.invalid_reason:
        valid, reason = False, a.invalid_reason

    manifest = {
        'run_id': a.run_id,
        'kpi': a.kpi,
        'version': a.version,
        'profile': a.profile,
        'scale': {'users': a.users, 'arrival_rps': a.rps, 'duration_s': a.duration, 'warmup_s': a.warmup},
        'scenario': {'path': a.scenario, 'args': a.scenario_args, 'open_model': not a.closed_model},
        'commit': {'code': a.commit or git_commit(root), 'docs': None},
        'generator': {'description': a.generator, 'dropped_iterations': (k6 or {}).get('dropped_iterations')},
        'started_at': L.iso_utc(start) if start else None,
        'ended_at': L.iso_utc(end) if end else None,
        'region': a.region,
        'cost_krw': a.cost_krw,
        'exchange_rate': a.exchange_rate,
        'k6': k6,
        'k6_eval': k6_eval,
        'k6_plan': k6_plan,
        'k6_cost': k6_cost,
        'attachments': attachments,
        'valid': valid,
        'invalid_reason': reason,
        'verdict': a.verdict,
        'notes': a.notes,
        'collected_at': L.iso_utc(time.time()),
        'tool': 'tools/perf-ledger/collect.py',
    }
    with io.open(os.path.join(run_dir, 'manifest.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    log(lines, 'manifest.json 작성')
    with io.open(os.path.join(run_dir, 'stdout.log'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')
    n = write_sums(run_dir)
    print(f'SHA256SUMS: {n}개 파일. valid={valid}' + (f' ({reason})' if reason else ''))
    return manifest


def selftest():
    """임시 폴더에서 수집 → 색인 → 그래프 전체 흐름을 확인한다."""
    import index as IDX
    import charts as CH
    tmp = tempfile.mkdtemp(prefix='perf-ledger-selftest-')
    os.makedirs(os.path.join(tmp, 'docs'))
    with io.open(os.path.join(tmp, L.LEDGER_DOC), 'w', encoding='utf-8') as f:
        f.write('# test\n\n<!-- ledger:begin -->\n(old)\n<!-- ledger:end -->\n')
    fake = {'metrics': {'http_req_duration': {'values': {'med': 40.0, 'p(95)': 70.0, 'p(99)': 80.0}},
                        'http_req_failed': {'values': {'rate': 0.001}},
                        'http_reqs': {'values': {'count': 120000, 'rate': 20000.0}},
                        'dropped_iterations': {'values': {'count': 0}}}}
    runs = []
    for users, p99, rps in [(1000, 60.0, 990), (10000, 70.0, 1010), (100000, 80.0, 1000)]:
        fake['metrics']['http_req_duration']['values']['p(99)'] = p99
        sp = os.path.join(tmp, f'summary-{users}.json')
        with io.open(sp, 'w', encoding='utf-8') as f:
            json.dump(fake, f)
        run_id = f'2026-11-02-k1-v1-local-{users // 1000}k'
        a = argparse.Namespace(run_id=run_id, kpi='K1', version='v1', profile=f'local-{users // 1000}k', users=users, rps=20000,
                               duration=600, warmup=120, scenario='k1-entry.js', scenario_args=None, closed_model=False,
                               k6_summary=sp, prom_url=None, start='2026-11-02T10:00:00Z', end='2026-11-02T10:10:00Z', step=1,
                               queries=None, infra_file=None, invariants=None, cost_file=None, timeline=None, extra=None,
                               confusion=None, commit='selftest', generator='selftest', region='local', cost_krw=0,
                               exchange_rate=1400, verdict='pass', notes='selftest', invalid_reason=None, force=False)
        collect(a, tmp)
        mdir = os.path.join(tmp, L.RUNS, run_id, 'metrics')
        os.makedirs(mdir, exist_ok=True)
        t0 = L.parse_time('2026-11-02T10:00:00Z')
        with io.open(os.path.join(mdir, 'origin_rps.csv'), 'w', encoding='utf-8', newline='') as f:
            w = csv.writer(f); w.writerow(['ts', 'value', 'labels'])
            for i in range(600):
                w.writerow([t0 + i, rps + (i % 7), '{}'])
        runs.append(run_id)
    # K6(봇 탐지): 등급별 혼동 행렬, 사전 등록 계획, 층별 오탐, 1장당 획득 비용(ADR-0039·0048)
    conf = os.path.join(tmp, 'confusion.csv')
    with io.open(conf, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['tier', 'round', 'label', 'predicted', 'count', 'stratum'])
        w.writerows([['volume-L1', 1, 'bot', 'bot', 962, ''], ['volume-L1', 1, 'bot', 'human', 38, ''],
                     ['speed-L2', 1, 'bot', 'bot', 951, ''], ['speed-L2', 1, 'bot', 'human', 49, ''],
                     ['replay-L3', 1, 'bot', 'bot', 610, ''], ['replay-L3', 1, 'bot', 'human', 390, ''],
                     ['volume-L1', 3, 'bot', 'bot', 970, ''], ['volume-L1', 3, 'bot', 'human', 30, ''],
                     ['speed-L2', 3, 'bot', 'bot', 955, ''], ['speed-L2', 3, 'bot', 'human', 45, ''],
                     ['replay-L3', 3, 'bot', 'bot', 540, ''], ['replay-L3', 3, 'bot', 'human', 460, ''],
                     ['-', 3, 'human', 'human', 946, ''], ['-', 3, 'human', 'bot', 1, ''],
                     ['-', 3, 'human', 'human', 40, 'assistive'], ['-', 3, 'human', 'bot', 1, 'assistive']])
    bot_cost = os.path.join(tmp, 'bot_cost.csv')
    with io.open(bot_cost, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['tier', 'round', 'ids', 'proxy_gb', 'solves', 'ops_hours', 'infra_krw', 'tickets'])
        w.writerows([['volume-L1', 3, 200, 2, 0, 4, 0, 24], ['replay-L3', 3, 200, 10, 1000, 8, 0, 180]])
    bot_prices = os.path.join(tmp, 'bot_prices.json')
    with io.open(bot_prices, 'w', encoding='utf-8') as f:
        json.dump({'id_krw': 50000, 'proxy_usd_per_gb': 7.0, 'solve_usd_per_1k': 1.45, 'hour_krw': 10000, 'usd_krw': 1400,
                   'face_krw': 150000, 'premiums_krw': [200000, 900000], 'catch_probs': [0.01, 0.05]}, f)
    a = argparse.Namespace(run_id='2026-12-01-k6-v1-local-bot', kpi='K6', version='v1', profile='local-bot', users=None, rps=None,
                           duration=None, warmup=0, scenario='k6-bot-tiers.js', scenario_args=None, closed_model=False,
                           k6_summary=None, prom_url=None, start=None, end=None, step=1, queries=None, infra_file=None,
                           invariants=None, cost_file=None, timeline=None, extra=None, confusion=conf, commit='selftest',
                           generator='selftest', region='local', cost_krw=0, exchange_rate=1400, verdict='pass',
                           notes='selftest', invalid_reason=None, force=False, k6_plan='947:1', bot_cost=bot_cost,
                           bot_prices=bot_prices)
    man = collect(a, tmp)
    ev, kc = man['k6_eval'], man['k6_cost']
    b = {(x['tier'], x['round']): x for x in ev['bots']}
    assert abs(b[('volume-L1', 1)]['wilson95'][0] - 0.9483) < 0.002, ('Wilson 구간 오류', b[('volume-L1', 1)])
    assert b[('replay-L3', 1)]['level'] == 3 and b[('replay-L3', 1)]['meets_target'] is None, '3단계 목표 처리 오류'
    assert all(x['meets_target'] for x in ev['bots'] if x['level'] != 3), '1·2단계 목표 판정 오류'
    drops = {d['tier']: d['drop_pp'] for d in ev['tier_drops']}
    assert abs(drops['replay-L3'] - 7.0) < 1e-6 and abs(drops['speed-L2'] + 0.4) < 1e-6, ('하락폭 오류', drops)
    h = ev['humans'][-1]
    assert h['n'] == 947 and h['false_pos'] == 1 and h['upper95_one_sided'] <= 0.005, ('사람 합계 오류', h)
    assert ev['plan_verdict'] == 'PASS', ('계획 판정 오류', ev['plan_verdict'])
    assert ev['human_strata'] == [{'round': 3, 'stratum': 'assistive', 'n': 41, 'false_pos': 1}], ('층별 집계 오류', ev['human_strata'])
    assert L.k6_eval_from_confusion(conf, L.k6_plan_parse('1549:3'))['plan_verdict'] == 'INSUFFICIENT', '판정 보류 오류'
    try:
        L.k6_plan_parse('600:1')
        raise AssertionError('상한 0.5%를 넘는 계획을 받아들였다')
    except ValueError:
        pass
    assert abs(L.cp_upper(3, 1000) - 0.00775) < 3e-4, ('CP 상한 오류', L.cp_upper(3, 1000))
    kr = {(r['tier'], r['round']): r for r in kc['rows']}
    assert kr[('volume-L1', 3)]['per_ticket_krw'] == 419150, ('1장당 비용 오류', kr[('volume-L1', 3)])
    assert kr[('replay-L3', 3)]['per_ticket_krw'] == 56556, ('1장당 비용 오류', kr[('replay-L3', 3)])
    cs = {(x['premium_krw'], x['catch_prob']): x for x in kr[('replay-L3', 3)]['cases']}
    assert cs[(200000, 0.01)]['bot_profitable'] is False and cs[(900000, 0.01)]['bot_profitable'] is True, ('손익 오류', cs)
    IDX.rebuild(tmp)
    doc = io.open(os.path.join(tmp, L.LEDGER_DOC), encoding='utf-8').read()
    assert '2026-11-02-k1-v1-local-10k' in doc and '(old)' not in doc, '색인 실패'
    assert '오탐 1/947' in doc and '계획 통과' in doc and '1장당 최저 56,556원' in doc, 'K6 요약 색인 실패'
    out = os.path.join(tmp, 'scale.svg')
    CH.chart_scale(tmp, runs, out)
    assert os.path.getsize(out) > 500, '그래프 실패'
    CH.chart_before_after(tmp, [('K1', runs[0], runs[2])], 'p99', os.path.join(tmp, 'ba.svg'))
    CH.chart_timeline(tmp, runs[1], ['origin_rps'], os.path.join(tmp, 'tl.svg'))
    print(f'selftest OK: {tmp}')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--selftest', action='store_true')
    p.add_argument('--root', help='저장소 루트(기본: 자동 탐색)')
    p.add_argument('--run-id'); p.add_argument('--kpi'); p.add_argument('--version', dest='version'); p.add_argument('--profile')
    p.add_argument('--users', type=int); p.add_argument('--rps', type=float); p.add_argument('--duration', type=int); p.add_argument('--warmup', type=int, default=0)
    p.add_argument('--scenario'); p.add_argument('--scenario-args'); p.add_argument('--closed-model', action='store_true', help='열린 모델이 아니면 표시')
    p.add_argument('--k6-summary'); p.add_argument('--prom-url'); p.add_argument('--start'); p.add_argument('--end'); p.add_argument('--step', type=int, default=1); p.add_argument('--queries')
    p.add_argument('--infra-file'); p.add_argument('--invariants'); p.add_argument('--cost-file'); p.add_argument('--timeline'); p.add_argument('--extra', action='append')
    p.add_argument('--confusion', help='K6: tier,round,label,predicted,count[,stratum] 형식의 혼동 행렬 CSV(ADR-0039·0048)')
    p.add_argument('--k6-plan', help='K6: 사전 등록한 판정용 사람 표본 N:C(예: 947:1, ADR-0048)')
    p.add_argument('--bot-cost', help='K6: tier,round,ids,proxy_gb,solves,ops_hours,infra_krw,tickets 형식의 CSV(ADR-0048)')
    p.add_argument('--bot-prices', help='K6: 1장당 획득 비용 단가 JSON(docs/perf-ledger.md §10.5)')
    p.add_argument('--commit'); p.add_argument('--generator'); p.add_argument('--region', default='local'); p.add_argument('--cost-krw', type=float); p.add_argument('--exchange-rate', type=float)
    p.add_argument('--verdict', choices=['pass', 'fail', 'baseline']); p.add_argument('--notes'); p.add_argument('--invalid-reason'); p.add_argument('--force', action='store_true')
    a = p.parse_args()
    if a.selftest:
        selftest(); return
    for req in ('run_id', 'kpi', 'version', 'profile'):
        if not getattr(a, req):
            p.error(f'--{req.replace("_", "-")} 가 필요합니다')
    root = a.root or L.find_root()
    collect(a, root)


if __name__ == '__main__':
    main()
