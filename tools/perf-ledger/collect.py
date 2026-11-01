"""측정 1회의 산출물을 perf-ledger/runs/<run-id>/에 모은다. 규칙: docs/perf-ledger.md §2·§3, K6(봇 탐지)는 §10.

사용 예:
  python tools/perf-ledger/collect.py --run-id 2026-11-02-k1-v0-local-10k --kpi K1 --version v0 \
    --profile local-10k --users 10000 --rps 20000 --duration 600 --warmup 120 \
    --scenario loadtest/k1-entry.js --k6-summary ./summary.json \
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


def upload_object(local_path, uri):
    """파일 하나를 S3에 올린다(AWS CLI `aws s3 cp`). 성공이면 None, 실패면 이유."""
    try:
        out = subprocess.run(['aws', 's3', 'cp', local_path, uri, '--only-show-errors'], capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.SubprocessError) as e:
        return f'{type(e).__name__}: {e}'
    return None if out.returncode == 0 else (out.stderr or out.stdout).strip()[:300]


def read_sums(run_dir):
    path = os.path.join(run_dir, 'SHA256SUMS')
    sums = {}
    if os.path.exists(path):
        with io.open(path, encoding='utf-8') as f:
            for line in f:
                digest, _, rel = line.rstrip('\n').partition('  ')
                if rel:
                    sums[rel] = digest
    return sums


def upload_raw(run_dir, raw_uri):
    """큰 원본(metrics/·traces/·grafana/·stdout.log)을 gzip으로 묶어 raw_uri 아래 `<경로>.gz`로 올린다(§2.1·§9).

    올리기 전에 SHA256SUMS의 해시(압축 전 원본)와 맞는지 보고, 모두 올라가면 폴더의 원본을 지운다(Git에는 해시만 남는다).
    하나라도 실패하면 아무것도 지우지 않고 실패 목록을 돌려준다.
    """
    import gzip
    sums = read_sums(run_dir)
    raws = []
    for base, _, files in os.walk(run_dir):
        for fn in sorted(files):
            p = os.path.join(base, fn)
            rel = os.path.relpath(p, run_dir).replace('\\', '/')
            if L.is_raw(rel):
                raws.append((rel, p))
    bad = [rel for rel, p in raws if sums.get(rel) != L.sha256_file(p)]
    if bad:
        return 0, [f'{rel}: SHA256SUMS와 해시가 다르거나 목록에 없다' for rel in bad]
    failures = []
    with tempfile.TemporaryDirectory(prefix='perf-ledger-raw-') as tmp:
        for rel, p in raws:
            gz = os.path.join(tmp, rel.replace('/', '__') + '.gz')
            with open(p, 'rb') as src, open(gz, 'wb') as raw_out:
                with gzip.GzipFile(filename='', mode='wb', fileobj=raw_out, mtime=0) as dst:
                    shutil.copyfileobj(src, dst)
            err = upload_object(gz, raw_uri + rel + '.gz')
            if err:
                failures.append(f'{rel}: {err}')
    if failures:
        return 0, failures
    for rel, p in raws:
        os.remove(p)
    for d in L.RAW_DIRS:
        top = os.path.join(run_dir, d.rstrip('/'))
        for base, dirs, files in os.walk(top, topdown=False):
            if not os.listdir(base):
                os.rmdir(base)
    return len(raws), []


def k6_inputs(a):
    """K6 입력을 측정 폴더를 만들기 전에 읽고 서로 맞는지 확인한다. 어긋나면 폴더를 만들지 않고 실행을 거부한다.

    돌려주는 값: (k6_plan, k6_eval, 사람 단위 집계, 봇 끝 결과 집계). human_sessions.csv는 여기서 읽기만 하고
    측정 폴더에 복사하지 않는다(개인 단위 자료, ADR-0112).
    """
    k6_plan = L.k6_plan_parse(a.k6_plan) if getattr(a, 'k6_plan', None) else None
    conf = getattr(a, 'confusion', None)
    hs, bo = getattr(a, 'human_sessions', None), getattr(a, 'bot_outcomes', None)
    try:
        for opt, path in (('--human-sessions', hs), ('--bot-outcomes', bo)):
            if not path:
                continue
            if not conf or not os.path.exists(conf):
                raise L.K6InputError(f'{opt}는 --confusion 파일과 함께 써야 한다')
            if not os.path.exists(path):
                raise L.K6InputError(f'{opt} 파일이 없다: {path}')
        k6_eval = L.k6_eval_from_confusion(conf, k6_plan) if conf and os.path.exists(conf) else None
        units = L.k6_human_units(hs, k6_eval, k6_plan) if hs else None
        outcomes = L.k6_bot_outcomes(bo, k6_eval) if bo else None
    except L.K6InputError as e:
        raise SystemExit(f'실행 거부(판정하지 않음, docs/perf-ledger.md §10.5): {e}')
    return k6_plan, k6_eval, units, outcomes


def collect(a, root):
    lines = []
    run_dir = os.path.join(root, L.RUNS, a.run_id)
    if os.path.exists(run_dir) and not a.force:
        raise SystemExit(f'이미 있는 측정 폴더입니다: {run_dir} (--force로 덮어쓰기)')
    k6_plan, k6_eval_pre, k6_units, k6_outcomes = k6_inputs(a)
    os.makedirs(run_dir, exist_ok=True)
    log(lines, f'측정 폴더: {run_dir}')

    k6 = None
    if a.k6_summary:
        rel = copy_into(a.k6_summary, run_dir, 'k6-summary.json', lines)
        if rel:
            k6 = L.k6_metrics(L.load_json(os.path.join(run_dir, 'k6-summary.json')))
            log(lines, f'k6: p99={k6["p99_ms"]} ms, 오류율={k6["error_rate"]}, 요청={k6["requests"]}, 못 보낸 반복={k6["dropped_iterations"]}')

    # k6가 아닌 측정 도구(loadtest/poc)의 요약: 그 안의 bench 칸(p99_ms·error_rate·requests·dropped)을 장부 칸으로 쓴다
    bench = None
    if getattr(a, 'bench_summary', None):
        rel = copy_into(a.bench_summary, run_dir, 'bench-summary.json', lines)
        if rel:
            b = (L.load_json(os.path.join(run_dir, 'bench-summary.json')) or {}).get('bench') or {}
            bench = {k: b.get(k) for k in ('p99_ms', 'error_rate', 'requests', 'dropped')}
            log(lines, f'측정 도구: p99={bench["p99_ms"]} ms, 오류율={bench["error_rate"]}, 요청={bench["requests"]}, 못 보낸 요청={bench["dropped"]}')

    start = L.parse_time(a.start) if a.start else None
    end = L.parse_time(a.end) if a.end else None
    if a.prom_url and a.queries and start and end:
        export_prometheus(a.prom_url, read_queries(a.queries), start, end, a.step, os.path.join(run_dir, 'metrics'), lines)
    elif a.prom_url:
        log(lines, 'prometheus: --queries, --start, --end가 모두 있어야 내보냅니다. 건너뜀')

    attachments = {}
    if bench is not None:
        attachments['bench'] = 'bench-summary.json'
    for key, src, name in [('infra', a.infra_file, 'infra.txt'), ('invariants', a.invariants, 'invariants.csv'),
                           ('cost', a.cost_file, 'cost.csv'), ('timeline', a.timeline, 'timeline.csv')]:
        rel = copy_into(src, run_dir, name, lines)
        if rel:
            attachments[key] = rel
    for extra in a.extra or []:
        rel = copy_into(extra, run_dir, None, lines)
        if rel:
            attachments.setdefault('extra', []).append(rel)

    k6_eval = None
    notes = a.notes
    if getattr(a, 'confusion', None):
        rel = copy_into(a.confusion, run_dir, 'confusion.csv', lines)
        if rel:
            attachments['confusion'] = rel
            k6_eval = k6_eval_pre
            log(lines, f'K6 평가: {L.k6_summary(k6_eval)}')
    if k6_eval is not None and k6_units:
        k6_eval.update(k6_units)
        u, icc = k6_units['human_units'], k6_units['human_icc']
        icc_s = f'ICC {icc["icc"]}(단측 95% 상한 {icc["upper95_one_sided"]}, {icc["people"]}명)' if icc else '사람 안 상관 계산 불가(세션 2개 이상인 사람 2명 미만)'
        log(lines, f'K6 사람 단위(ADR-0112): 참가자 {u["participants"]}명, 판정 세션 {u["judge_sessions"]}개, '
                   f'참고 세션 {u["ref_sessions"]}개, 사람당 세션 수 {k6_units["sessions_per_person"]}, {icc_s}. '
                   f'human_sessions.csv는 복사하지 않음')
    if k6_eval is not None and k6_outcomes:
        rel = copy_into(a.bot_outcomes, run_dir, 'bot_outcomes.csv', lines)
        if rel:
            attachments['bot_outcomes'] = rel
        k6_eval.update(k6_outcomes)
        note = L.bot_share_note(k6_outcomes.get('bot_share_est'))
        if note:
            notes = f'{notes}; {note}' if notes else note
            log(lines, f'K6 {note}')
    k6_cost = None
    if getattr(a, 'bot_cost', None) and getattr(a, 'bot_prices', None):
        rel = copy_into(a.bot_cost, run_dir, 'bot_cost.csv', lines)
        relp = copy_into(a.bot_prices, run_dir, 'bot_prices.json', lines)
        if rel and relp:
            attachments['bot_cost'], attachments['bot_prices'] = rel, relp
            k6_cost = L.k6_cost(os.path.join(run_dir, 'bot_cost.csv'),
                                L.load_json(os.path.join(run_dir, 'bot_prices.json')), a.exchange_rate)
            log(lines, f'K6 1장당 획득 비용: {L.k6_summary(None, k6_cost)}')

    msum = L.metrics_summary(run_dir, start, a.warmup)
    if msum:
        with io.open(os.path.join(run_dir, 'metrics-summary.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(msum, f, ensure_ascii=False, indent=2)
        log(lines, f'metrics-summary.json: {len(msum)}개 쿼리 식별자(예열 뺀 p50·p99·최대·평균)')
    raw_bucket = getattr(a, 'raw_bucket', None)
    raw_uri = f'{raw_bucket.rstrip("/")}/runs/{a.run_id}/' if raw_bucket else None
    if not raw_uri:
        log(lines, '원본 버킷(--raw-bucket)이 없어 큰 원본(metrics/·traces/·grafana/·stdout.log)이 폴더에 남는다. '
                   'Git에는 작은 파일만 넣는다(docs/perf-ledger.md §2.1)')
    redis_tls = getattr(a, 'redis_tls', None)
    redis_tls = None if redis_tls is None else str(redis_tls).lower() == 'true'
    paired_run = getattr(a, 'paired_run', None)
    if redis_tls is not None and not paired_run:
        log(lines, 'Redis TLS 짝 실행(--paired-run)이 없다. TLS 켬·끔을 한 번씩 재어 짝을 적는다(docs/verification.md §3.5 7번)')
    if redis_tls is False and a.verdict in ('pass', 'fail'):
        log(lines, 'TLS를 끈 실행이다. 판정은 TLS를 켠 짝 실행으로 한다(docs/perf-ledger.md §2.2)')

    valid, reason = True, None
    if k6 and (k6['dropped_iterations'] or 0) > 0:
        valid, reason = False, f'발생기 병목: dropped_iterations={k6["dropped_iterations"]}'
    if bench and (bench['dropped'] or 0) > 0:
        valid, reason = False, f'발생기 병목: 못 보낸 요청={bench["dropped"]}'
    if a.invalid_reason:
        valid, reason = False, a.invalid_reason

    manifest = {
        'run_id': a.run_id,
        'kpi': a.kpi,
        'version': a.version,
        'profile': a.profile,
        'scale': {'users': a.users, 'arrival_rps': a.rps, 'duration_s': a.duration, 'warmup_s': a.warmup},
        'scenario': {'path': a.scenario, 'args': a.scenario_args, 'open_model': not a.closed_model},
        # 코드와 문서가 peaket 한 저장소라 커밋 하나가 둘 다 가리킨다. docs 칸은 비워 둔다(ADR-0165).
        'commit': {'code': a.commit or git_commit(root), 'docs': None},
        'raw_uri': raw_uri,
        'redis_tls': redis_tls,
        'paired_run': paired_run,
        'generator': {'description': a.generator, 'dropped_iterations': (k6 or {}).get('dropped_iterations', (bench or {}).get('dropped'))},
        'started_at': L.iso_utc(start) if start else None,
        'ended_at': L.iso_utc(end) if end else None,
        'region': a.region,
        'cost_krw': a.cost_krw,
        'exchange_rate': a.exchange_rate,
        'k6': k6,
        'bench': bench,
        'k6_eval': k6_eval,
        'k6_plan': k6_plan,
        'k6_cost': k6_cost,
        'attachments': attachments,
        'valid': valid,
        'invalid_reason': reason,
        'verdict': a.verdict,
        'notes': notes,
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
    if raw_uri:
        finish_raw(run_dir, raw_uri, a.run_id)
    return manifest


def finish_raw(run_dir, raw_uri, run_id):
    done, failures = upload_raw(run_dir, raw_uri)
    if failures:
        raise SystemExit('원본 올리기 실패(폴더의 원본은 지우지 않았다). 고친 뒤 '
                         f'`collect.py --upload-raw {run_id}`로 다시 올린다:\n  ' + '\n  '.join(failures))
    print(f'원본 {done}개를 {raw_uri}에 gzip으로 올리고 폴더에서 지웠다(해시는 SHA256SUMS)')


def upload_raw_again(root, run_id):
    """올리기에 실패한 실행의 원본을 다시 올린다(--upload-raw)."""
    run_dir = os.path.join(root, L.RUNS, run_id)
    raw_uri = L.load_manifest(root, run_id).get('raw_uri')
    if not raw_uri:
        raise SystemExit(f'{run_id}의 manifest에 raw_uri가 없다(--raw-bucket으로 수집한 실행만 다시 올린다)')
    finish_raw(run_dir, raw_uri, run_id)


def selftest_human_sessions(path, n=947, extra_judge=None, drop=(), ref_only=None):
    """V-T25용 합성 human_sessions.csv. 1~400번 참가자는 참고 세션을 0~4개 더 낸다(5번은 2개, 판정 세션이 오탐).

    위험 점수 = 0.3 + 0.1 × 사람 효과 + 0.1 × 세션 잡음이라 참값 ICC는 0.5다.
    extra_judge: 판정 세션을 하나 더 주는 참가자, drop: 빼는 참가자, ref_only: 참고 세션만 내는 참가자.
    """
    import random
    rng = random.Random(20261028)
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(L.HUMAN_SESSION_COLUMNS)
        for i in range(1, n + 1):
            code = f'P{i:04d}'
            u = rng.gauss(0, 1)
            nref = 2 if i == 5 else (i % 5 if i <= 400 else 0)
            site = f'S{i % 40:02d}' if i % 10 == 0 else ''
            stratum = 'assistive' if i <= 41 else ('device-ios' if i % 3 == 0 else '')
            scores = [round(0.3 + 0.1 * u + 0.1 * rng.gauss(0, 1), 4) for _ in range(nref + 1)]
            if code == ref_only:
                w.writerow([code, site, 'ref', 'device-android', 1, 'human', scores[0]])
            if code in drop:
                continue
            w.writerow([code, site, 'judge', stratum, 3, 'bot' if i == 5 else 'human', scores[0]])
            for j in range(nref):
                w.writerow([code, site, 'ref', 'network-mobile' if j % 2 else 'device-android', 1 + j % 3,
                            'bot' if (i == 5 and j == 0) else 'human', scores[j + 1]])
            if code == extra_judge:
                w.writerow([code, site, 'judge', '', 3, 'human', 0.3])


def selftest_bot_outcomes(conf, path):
    """confusion.csv의 봇 판정 수를 풀이 성공률 0·0.5·0.95로 나눈 합성 bot_outcomes.csv(기술 검토 중간-104)."""
    det = {}
    with io.open(conf, encoding='utf-8', newline='') as f:
        for r in csv.DictReader(f):
            if r['label'] == 'bot' and r['predicted'] == 'bot':
                det[(r['tier'], r['round'])] = int(r['count'])
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(L.BOT_OUTCOME_COLUMNS)
        for (tier, rnd), d in sorted(det.items()):
            parts = [d - 2 * (d // 3), d // 3, d // 3]
            for s, sess, di in zip((0, 0.5, 0.95), (334, 333, 333), parts):
                vpass = {0: 0, 0.5: di // 20, 0.95: di // 5}[s]
                w.writerow([tier, rnd, s, sess, di, di // 2, vpass, sess - di + vpass])


def selftest_raw_and_stamp(tmp, IDX, CH):
    """원본 버킷 나눠 두기, metrics-summary.json, Redis TLS 짝 칸, 하루 해시 고정(낮음-056·072)을 확인한다.

    S3와 OpenTimestamps는 부르지 않고, 올리기는 임시 폴더(가짜 버킷)로, `ots`는 가짜 함수로 바꿔 끼운다.
    """
    import gzip
    g = globals()
    bucket = os.path.join(tmp, 'fake-bucket')
    state = {'fail': False}

    def fake_upload(local, uri):
        if state['fail']:
            return '가짜 실패'
        dest = os.path.join(bucket, uri[len('s3://'):].replace('/', os.sep))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(local, dest)
        return None

    def fake_export(prom_url, queries, start, end, step, out_dir, lines):
        os.makedirs(out_dir, exist_ok=True)
        with io.open(os.path.join(out_dir, 'origin_rps.csv'), 'w', encoding='utf-8', newline='') as f:
            w = csv.writer(f)
            w.writerow(['ts', 'value', 'labels'])
            for i in range(600):
                w.writerow([start + i, 1000 + (i % 7) + (500 if i == 590 else 0), '{}'])

    queries = os.path.join(tmp, 'queries.txt')
    io.open(queries, 'w', encoding='utf-8').write('origin_rps=sum(rate(x[1m]))\n')
    saved = g['upload_object'], g['export_prometheus']
    g['upload_object'], g['export_prometheus'] = fake_upload, fake_export
    try:
        def raw_args(run_id, **kw):
            base = dict(run_id=run_id, kpi='K1', version='v1', profile='local-10k', users=10000, rps=20000, duration=600,
                        warmup=120, scenario='k1-entry.js', scenario_args=None, closed_model=False, k6_summary=None,
                        prom_url='http://selftest', start='2026-11-02T10:00:00Z', end='2026-11-02T10:10:00Z', step=1,
                        queries=queries, infra_file=None, invariants=None, cost_file=None, timeline=None, extra=None,
                        confusion=None, commit='selftest', generator='selftest', region='local', cost_krw=0,
                        exchange_rate=1400, verdict='pass', notes='selftest', invalid_reason=None, force=False,
                        raw_bucket='s3://selftest-raw', redis_tls='true', paired_run='2026-11-02-k1-v1-local-10k-notls')
            base.update(kw)
            return argparse.Namespace(**base)

        rid = '2026-11-02-k1-v1-local-10k-raw'
        man = collect(raw_args(rid), tmp)
        run_dir = os.path.join(tmp, L.RUNS, rid)
        assert man['raw_uri'] == f's3://selftest-raw/runs/{rid}/', ('raw_uri 오류', man['raw_uri'])
        assert man['redis_tls'] is True and man['paired_run'].endswith('-notls'), 'redis_tls·paired_run 오류'
        vals = [1000 + (i % 7) + (500 if i == 590 else 0) for i in range(120, 600)]
        ms = L.load_json(os.path.join(run_dir, 'metrics-summary.json'))['origin_rps']
        assert ms['points'] == 480 and ms['max'] == max(vals) == 1502 and abs(ms['mean'] - sum(vals) / 480) < 1e-9, ('지표 요약 오류', ms)
        assert ms['p50'] == sorted(vals)[239] and ms['p99'] == sorted(vals)[475], ('백분위 오류', ms)
        assert not os.path.exists(os.path.join(run_dir, 'metrics')) and not os.path.exists(os.path.join(run_dir, 'stdout.log')), \
            '올린 원본이 폴더에 남았다'
        sums = read_sums(run_dir)
        for rel in ('metrics/origin_rps.csv', 'stdout.log'):
            obj = os.path.join(bucket, 'selftest-raw', 'runs', rid, *rel.split('/')) + '.gz'
            with gzip.open(obj, 'rb') as f:
                assert hashlib.sha256(f.read()).hexdigest() == sums[rel], f'{rel}: 버킷 원본과 SHA256SUMS가 다르다'
        assert (L.read_metrics_summary(tmp, rid).get('origin_rps') or {}).get('mean'), '요약 평균 읽기 실패'
        CH.chart_scale(tmp, [rid], os.path.join(tmp, 'scale-raw.svg'))
        # 올리기 실패: 원본을 지우지 않고 거부, --upload-raw로 다시 올린다
        rid2 = rid + '-retry'
        state['fail'] = True
        try:
            collect(raw_args(rid2, redis_tls='false', paired_run=None, verdict='baseline'), tmp)
            raise AssertionError('올리기 실패를 넘겼다')
        except SystemExit as e:
            assert '--upload-raw' in str(e), str(e)
        assert os.path.exists(os.path.join(tmp, L.RUNS, rid2, 'stdout.log')), '실패했는데 원본을 지웠다'
        state['fail'] = False
        upload_raw_again(tmp, rid2)
        assert not os.path.exists(os.path.join(tmp, L.RUNS, rid2, 'stdout.log')), '다시 올린 뒤 원본이 남았다'
        assert L.load_manifest(tmp, rid2)['redis_tls'] is False, 'redis_tls false 오류'
    finally:
        g['upload_object'], g['export_prometheus'] = saved
    # 하루 해시 묶음과 OpenTimestamps(가짜 ots)
    calls = []

    def fake_ots(args):
        calls.append(args[0])
        if args[0] == 'stamp':
            io.open(args[1] + '.ots', 'wb').write(b'fake-ots')
        return None

    saved_ots = IDX.run_ots
    IDX.run_ots = fake_ots
    try:
        path = IDX.stamp(tmp, '2026-11-02')
        lines = io.open(path, encoding='utf-8').read().splitlines()
        assert len(lines) == 5 and os.path.exists(path + '.ots'), ('하루 묶음 오류', lines)
        first_run = lines[0].split('  ')[1].split('/')[1]
        assert lines[0].split('  ')[0] == L.sha256_file(os.path.join(tmp, L.RUNS, first_run, 'SHA256SUMS')), '묶음 해시 오류'
        assert IDX.stamp(tmp, '2026-11-02') == path and calls.count('stamp') == 1, '같은 날 다시 고정했다'
        assert IDX.stamp(tmp, '2026-12-31') is None, '빈 날 처리 오류'
        assert IDX.upgrade(tmp) == (1, []), '증명 갱신 오류'
        sp = os.path.join(tmp, L.RUNS, first_run, 'SHA256SUMS')
        keep = io.open(sp, encoding='utf-8', newline='').read()
        io.open(sp, 'a', encoding='utf-8', newline='\n').write('0' * 64 + '  extra.txt\n')
        try:
            IDX.stamp(tmp, '2026-11-02')
            raise AssertionError('고정 뒤 바뀐 해시를 넘겼다')
        except SystemExit as e:
            assert '이미 고정' in str(e), str(e)
        io.open(sp, 'w', encoding='utf-8', newline='').write(keep)
    finally:
        IDX.run_ots = saved_ots


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
    hs = os.path.join(tmp, 'human_sessions.csv')
    selftest_human_sessions(hs)
    outcomes = os.path.join(tmp, 'bot_outcomes.csv')
    selftest_bot_outcomes(conf, outcomes)

    def k6_args(run_id, **kw):
        base = dict(run_id=run_id, kpi='K6', version='v1', profile='local-bot', users=None, rps=None,
                    duration=None, warmup=0, scenario='k6-bot-tiers.js', scenario_args=None, closed_model=False,
                    k6_summary=None, prom_url=None, start=None, end=None, step=1, queries=None, infra_file=None,
                    invariants=None, cost_file=None, timeline=None, extra=None, confusion=conf, commit='selftest',
                    generator='selftest', region='local', cost_krw=0, exchange_rate=1400, verdict='pass',
                    notes='selftest', invalid_reason=None, force=False, k6_plan='947:1', bot_cost=bot_cost,
                    bot_prices=bot_prices, human_sessions=hs, bot_outcomes=outcomes)
        base.update(kw)
        return argparse.Namespace(**base)

    # V-T25 ①: 참가자 947명이 판정 세션 하나씩(참고 세션 포함) → 판정하고 사람 단위 집계를 남긴다
    man = collect(k6_args('2026-12-01-k6-v1-local-bot'), tmp)
    ev, kc = man['k6_eval'], man['k6_cost']
    run_dir = os.path.join(tmp, L.RUNS, '2026-12-01-k6-v1-local-bot')
    assert ev['human_units']['participants'] == 947 and ev['human_units']['judge_sessions'] == 947, ('사람 단위 오류', ev['human_units'])
    assert ev['sessions_per_person'] == {'1': 626, '2': 80, '3': 81, '4': 80, '5': 80}, ('사람당 세션 수 오류', ev['sessions_per_person'])
    icc = ev['human_icc']
    assert icc['people'] == 321 and 0.35 < icc['icc'] < icc['upper95_one_sided'] < 0.75, ('사람 안 상관 오류', icc)
    assert ev['judged_fp_refs'] == {'people': 1, 'ref_sessions': 2, 'ref_false_pos': 1}, ('오탐 사람의 참고 세션 오류', ev['judged_fp_refs'])
    assert {'round': 1, 'stratum': 'device-android', 'n': 321, 'false_pos': 1} in ev['ref_strata'], ('참고 층별 오류', ev['ref_strata'])
    assert not os.path.exists(os.path.join(run_dir, 'human_sessions.csv')), '사람 세션 파일이 측정 폴더에 복사됐다'
    for base, _, files in os.walk(run_dir):
        for fn in files:
            text = io.open(os.path.join(base, fn), encoding='utf-8', errors='replace').read()
            assert 'human_sessions.csv  ' not in text and 'P0005' not in text, ('가명 코드나 사람 세션 파일이 남았다', fn)
    # V-T25 ②·③과 판정 세션이 없는 참가자: 판정하지 않고 실행을 거부한다(측정 폴더도 만들지 않는다)
    conf946 = os.path.join(tmp, 'confusion-946.csv')
    with io.open(conf, encoding='utf-8') as f:
        body = f.read().replace('-,3,human,human,946,', '-,3,human,human,945,')
    with io.open(conf946, 'w', encoding='utf-8', newline='') as f:
        f.write(body)
    cases = [('two-judges', dict(extra_judge='P0001', drop={'P0947'}), conf, '판정 세션이 둘 이상'),
             ('946-judges', dict(drop={'P0947'}), conf946, 'N=947'),
             ('no-judge', dict(drop={'P0947'}, ref_only='P0947'), conf, '판정 세션이 없는')]
    for name, opts, cpath, expect in cases:
        bad = os.path.join(tmp, f'human_sessions-{name}.csv')
        selftest_human_sessions(bad, **opts)
        rid = f'2026-12-01-k6-v1-local-bot-{name}'
        try:
            collect(k6_args(rid, confusion=cpath, human_sessions=bad, bot_outcomes=None), tmp)
            raise AssertionError(f'{name}: 실행을 거부하지 않았다')
        except SystemExit as e:
            assert expect in str(e), (name, str(e))
        assert not os.path.exists(os.path.join(tmp, L.RUNS, rid)), f'{name}: 거부했는데 측정 폴더가 생겼다'
    # 기술 검토 중간-104: 추가 검증 통과율, 끝에서 끝까지의 봇 성공률, 봇 점유율 추정
    vp = {(x['tier'], x['round'], x['solve_rate']): x for x in ev['verify_pass']}
    assert vp[('volume-L1', 3, 0.95)]['verify_passed'] == 64 and vp[('volume-L1', 3, 0.0)]['wilson95'][0] == 0.0, ('통과율 오류', vp)
    e2e = {(x['tier'], x['round'], x['solve_rate']): x for x in ev['e2e_success']}
    assert e2e[('replay-L3', 3, 0.0)]['admitted'] == 334 - 180, ('끝 성공률 오류', e2e[('replay-L3', 3, 0.0)])
    est = {x['solve_rate']: x for x in ev['bot_share_est']['by_solve_rate']}
    assert abs(ev['bot_share_est']['detection_rate'] - 0.9625) < 1e-9, ('탐지율 d 오류', ev['bot_share_est'])
    assert abs(est[0.0]['bot_share'] - 18750 / 516250) < 1e-5, ('봇 점유율(r=0) 오류', est[0.0])
    r95 = 127 / 641
    p95 = 500000 * 0.0375 + 500000 * 0.9625 * r95
    assert abs(est[0.95]['bot_share'] - p95 / (p95 + 497500)) < 1e-5, ('봇 점유율(r>0) 오류', est[0.95])
    assert '봇 점유율 추정' in man['notes'] and 'bot_outcomes' in man['attachments'], ('notes·첨부 오류', man['notes'])
    rows = list(csv.DictReader(io.open(outcomes, encoding='utf-8', newline='')))
    for name, edit, expect in [('detected', ('detected', 1), 'confusion.csv 봇 판정 수'),
                               ('blocked', ('blocked', 10 ** 4), 'blocked + verify_passed'),
                               ('admitted', ('admitted', 10 ** 4), 'admitted')]:
        bad = os.path.join(tmp, f'bot_outcomes-{name}.csv')
        with io.open(bad, 'w', encoding='utf-8', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(L.BOT_OUTCOME_COLUMNS))
            w.writeheader()
            for i, r in enumerate(rows):
                r = dict(r)
                if i == 0:
                    r[edit[0]] = int(r[edit[0]]) + edit[1]
                w.writerow(r)
        rid = f'2026-12-01-k6-v1-local-bot-outcome-{name}'
        try:
            collect(k6_args(rid, bot_outcomes=bad), tmp)
            raise AssertionError(f'봇 끝 결과 {name}: 실행을 거부하지 않았다')
        except SystemExit as e:
            assert expect in str(e), (name, str(e))
        assert not os.path.exists(os.path.join(tmp, L.RUNS, rid)), f'봇 끝 결과 {name}: 측정 폴더가 생겼다'
    g = [[9, 2, 5, 8], [6, 1, 3, 2], [8, 4, 6, 8], [7, 1, 2, 6], [10, 5, 6, 9], [6, 2, 4, 7]]  # Shrout·Fleiss(1979) 예제
    sf = L.icc1(g, alpha=0.025)
    assert abs(sf['icc'] - 0.166) < 1e-3 and abs(sf['upper_one_sided'] - 0.72) < 0.01, ('ICC(1) 계산 오류', sf)
    assert abs(L.f_ppf(0.95, 5, 10) - 3.3258) < 1e-3 and abs(L.f_ppf(0.99, 10, 10) - 4.8491) < 1e-3, 'F 분위수 오류'
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
    selftest_raw_and_stamp(tmp, IDX, CH)
    # k6가 아닌 측정 도구의 요약(wbs 0.5.1 PoC): p99·오류율·요청 수를 장부 칸에, 못 보낸 요청이 있으면 무효
    def bench_args(run_id, path):
        return argparse.Namespace(run_id=run_id, kpi='NFR-001', version='v1', profile='local-poc', users=None, rps=200000,
                                  duration=60, warmup=15, scenario='loadtest/poc/bench/src/rate.mjs', scenario_args='--op incr',
                                  closed_model=False, k6_summary=None, bench_summary=path, prom_url=None, start=None, end=None,
                                  step=1, queries=None, infra_file=None, invariants=None, cost_file=None, timeline=None, extra=None,
                                  confusion=None, commit='selftest', generator='selftest', region='local', cost_krw=0,
                                  exchange_rate=1400, verdict='pass', notes='selftest', invalid_reason=None, force=False,
                                  redis_tls='true', paired_run='2026-11-02-incr-v1-local-poc-notls')
    for rid, dropped in [('2026-11-02-incr-v1-local-poc', 0), ('2026-11-02-incr-v1-local-poc-dropped', 3)]:
        bp = os.path.join(tmp, f'bench-{dropped}.json')
        with io.open(bp, 'w', encoding='utf-8') as f:
            json.dump({'test': 'INCR-single-key', 'bench': {'p99_ms': 4.25, 'error_rate': 0.0, 'requests': 15000000, 'dropped': dropped}}, f)
        bm = collect(bench_args(rid, bp), tmp)
        assert bm['bench'] == {'p99_ms': 4.25, 'error_rate': 0.0, 'requests': 15000000, 'dropped': dropped}, ('측정 도구 요약 오류', bm['bench'])
        assert bm['attachments'].get('bench') == 'bench-summary.json', ('측정 도구 요약 첨부 오류', bm['attachments'])
        assert bm['generator']['dropped_iterations'] == dropped, ('못 보낸 요청 오류', bm['generator'])
        assert bm['valid'] is (dropped == 0), ('못 보낸 요청이 있는데 유효로 적었다', bm['valid'])
    IDX.rebuild(tmp)
    doc = io.open(os.path.join(tmp, L.LEDGER_DOC), encoding='utf-8').read()
    row = [ln for ln in doc.splitlines() if '| 2026-11-02-incr-v1-local-poc |' in ln]
    assert row and '| 4.25 |' in row[0] and '| 0.0% |' in row[0], ('측정 도구 요약 색인 실패', row)
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
    p.add_argument('--k6-summary'); p.add_argument('--bench-summary', help='k6가 아닌 측정 도구의 결과 JSON(bench 칸: p99_ms·error_rate·requests·dropped)'); p.add_argument('--prom-url'); p.add_argument('--start'); p.add_argument('--end'); p.add_argument('--step', type=int, default=1); p.add_argument('--queries')
    p.add_argument('--infra-file'); p.add_argument('--invariants'); p.add_argument('--cost-file'); p.add_argument('--timeline'); p.add_argument('--extra', action='append')
    p.add_argument('--confusion', help='K6: tier,round,label,predicted,count[,stratum] 형식의 혼동 행렬 CSV(ADR-0039·0048)')
    p.add_argument('--k6-plan', help='K6: 사전 등록 계획 N:C. N은 판정 세션을 낸 사람 수, C는 합격 오탐 수(예: 947:1, ADR-0048·0112)')
    p.add_argument('--human-sessions', help='K6: participant,site,role,stratum,round,predicted,score 형식의 사람 세션 CSV. '
                                            '확인과 집계에만 쓰고 측정 폴더에 복사하지 않는다(ADR-0112)')
    p.add_argument('--bot-outcomes', help='K6: tier,round,solve_rate,sessions,detected,blocked,verify_passed,admitted 형식의 '
                                          '봇 끝 결과 CSV(docs/perf-ledger.md §10.5, 기술 검토 중간-104)')
    p.add_argument('--bot-cost', help='K6: tier,round,ids,proxy_gb,solves,ops_hours,infra_krw,tickets 형식의 CSV(ADR-0048)')
    p.add_argument('--bot-prices', help='K6: 1장당 획득 비용 단가 JSON(docs/perf-ledger.md §10.5)')
    p.add_argument('--raw-bucket', help='큰 원본을 둘 S3 원본 버킷(예: s3://peaket-perf-raw). raw_uri는 <버킷>/runs/<run-id>/ (docs/perf-ledger.md §2.1·§9)')
    p.add_argument('--upload-raw', metavar='RUN_ID', help='올리기에 실패한 실행의 큰 원본을 manifest의 raw_uri로 다시 올린다')
    p.add_argument('--redis-tls', choices=['true', 'false'], help='대기열·좌석 Redis 연결의 TLS 켬·끔(docs/perf-ledger.md §2.2)')
    p.add_argument('--paired-run', help='같은 조건으로 TLS를 반대로 잰 짝 실행의 run_id')
    p.add_argument('--commit'); p.add_argument('--generator'); p.add_argument('--region', default='local'); p.add_argument('--cost-krw', type=float); p.add_argument('--exchange-rate', type=float)
    p.add_argument('--verdict', choices=['pass', 'fail', 'baseline']); p.add_argument('--notes'); p.add_argument('--invalid-reason'); p.add_argument('--force', action='store_true')
    a = p.parse_args()
    if a.selftest:
        selftest(); return
    if a.upload_raw:
        upload_raw_again(a.root or L.find_root(), a.upload_raw); return
    if a.raw_bucket and not a.raw_bucket.startswith('s3://'):
        p.error('--raw-bucket은 s3://로 시작한다')
    for req in ('run_id', 'kpi', 'version', 'profile'):
        if not getattr(a, req):
            p.error(f'--{req.replace("_", "-")} 가 필요합니다')
    root = a.root or L.find_root()
    collect(a, root)


if __name__ == '__main__':
    main()
