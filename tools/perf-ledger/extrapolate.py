"""100만 외삽 계산(MSR-010, docs/verification.md §3.3·§3.4, 계획 docs/review/plans/F-08-2.md 6.2·6.5·7.2). 표준 라이브러리만.

  python tools/perf-ledger/extrapolate.py [--root <저장소>] origin --runs RUN... --version v0|v1 [--admit-per-second 28] [--tolerance 0.1] --out origin.json [--md origin.md]
  python tools/perf-ledger/extrapolate.py [--root <저장소>] entry --scale entry-scale.json --redis-r 490800 --target 200000 [--factor-limit 4] --out entry.json [--md entry.md]

- origin: 장부 실행마다 예상 원 서버 요청(v1 식 또는 v0 식)과 잰 origin_rps(예열 뺀 평균, charts.py scale과 같은 읽기)의 비를 내고,
  유효한 세 규모(1천·1만·10만)가 모두 허용 폭 안이면 100만 값을 '외삽(설계 식)'으로 적는다. 무효 실행은 계산에서 빼고 표에는 남긴다.
  유효한 규모가 셋에 모자라면 판정하지 않는다(통과로 세지 않는다).
- entry: 진입 설계 식 min(N × X₁, R), 필요한 대수 ⌈목표 ÷ X₁⌉, 외삽 배수(필요한 대수 ÷ 잰 최대 대수)와 표시(§3.3). X₁·잰 최대 대수는
  loadtest/runner/entry-scale.mjs report의 entry-scale.json에서 읽는다(x1Design이 있으면 1 vCPU X₁로 그것을 쓴다).
정본 값(캐시 수명 1초, 폴링 주기, ±10%, 배수 4)은 상수로 두고 자리를 주석으로 단다. 값을 바꾸려면 정본부터 고친다.
"""
import argparse
import io
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledgerlib as L  # noqa: E402

# §3.4 'v1 설계 식': 파일은 1,000명당 1개, 캐시 수명은 채택 전 기본 1초(queue-admission §4 '거리별 TTL' 채택 전 기본은 모든 구간 1초)
SEGMENT_SIZE = 1000
CACHE_TTL_S = 1.0
# §3.4 'v0 식'·queue-admission §4 폴링 주기 표: 예상 대기 1분 이내 0.5초, 1~5분 5초, 그 밖 20초
POLL_TABLE = ((60, 0.5), (300, 5.0), (None, 20.0))
# §3.4 '판정': ±10% [가정, 6.1.1에서 확정]
TOLERANCE = 0.1
# §3.3: 외삽 배수 문턱 4 [가정, 6.1.1에서 확정]
FACTOR_LIMIT = 4.0
# §3.10 K1 행: 입장 초당 28명
ADMIT_PER_S = 28
SCALES_NEEDED = 3
TARGET_USERS = 1000000


def v1_origin_expected(users, segment_size=SEGMENT_SIZE, ttl_s=CACHE_TTL_S):
    """v1 원 서버의 대기 상태 파일 응답 ≈ Σ(활성 파일 ÷ 캐시 수명) = ⌈users ÷ segment_size⌉ ÷ ttl_s(§3.4)."""
    if users is None or users <= 0:
        raise ValueError(f'사용자 수는 양수다: {users}')
    return math.ceil(users / segment_size) / ttl_s


def v0_origin_expected(users, admit_per_s, table=POLL_TABLE):
    """v0 원 서버 요청 ≈ Σ(구간 인원 ÷ 구간 폴링 주기)(§3.4). 구간 인원은 한 시점의 대기열에서 예상 대기(앞 인원 ÷ 입장 속도)로 나눈다:
    1분 이내 = admit × 60명, 1~5분 = admit × 240명, 나머지. 10만 명·28명/s면 1,680 ÷ 0.5 + 6,720 ÷ 5 + 91,600 ÷ 20 ≈ 9,284/s(정본 '약 9,300')."""
    if users is None or users <= 0 or admit_per_s is None or admit_per_s <= 0:
        raise ValueError('사용자 수와 입장 속도는 양수다')
    total, prev, left = 0.0, 0, users
    for max_eta, interval in table:
        size = left if max_eta is None else min(left, admit_per_s * max_eta - prev)
        size = max(0, size)
        total += size / interval
        left -= size
        if max_eta is not None:
            prev = admit_per_s * max_eta
        if left <= 0:
            break
    return total


def ratio_verdict(measured, expected, tol=TOLERANCE):
    """잰 값 ÷ 예상 값의 비와 허용 폭 안인지(|비 − 1| ≤ tol). 값이 없으면 둘 다 None(통과로 세지 않는다)."""
    if measured is None or expected is None or expected <= 0:
        return {'ratio': None, 'within': None}
    ratio = measured / expected
    return {'ratio': ratio, 'within': abs(ratio - 1) <= tol + 1e-12}


def entry_design(x1, r, target, n_measured_max, factor_limit=FACTOR_LIMIT):
    """진입 설계 식(§3.3): 필요한 대수 ⌈target ÷ X₁⌉, 용량 min(필요 대수 × X₁, R), 외삽 배수 = 필요 대수 ÷ 잰 최대 대수.
    표시: 배수가 문턱을 넘으면 '외삽(측정 범위의 N배 초과)', 아니면 '외삽(설계 식)'. R이 목표보다 작으면 'R이 상한'을 앞에 붙인다."""
    if not x1 or x1 <= 0 or not n_measured_max or n_measured_max <= 0:
        raise ValueError('X₁과 잰 최대 대수는 양수다')
    n_required = math.ceil(target / x1 - 1e-12)
    factor = n_required / n_measured_max
    capacity = min(n_required * x1, r)
    label = f'외삽(측정 범위의 {factor_limit:g}배 초과)' if factor > factor_limit + 1e-12 else '외삽(설계 식)'
    r_cap = r < target
    if r_cap:
        label = f'R이 상한(R {r:g} < 목표 {target:g}, 대수와 상관없이 R이 진입 용량이다, §3.3); {label}'
    return {'x1': x1, 'r': r, 'target': target, 'n_required': n_required, 'n_measured_max': n_measured_max,
            'extrapolation_factor': factor, 'factor_limit': factor_limit, 'capacity': capacity, 'r_is_cap': r_cap, 'label': label}


def measured_origin(root, run_id, manifest):
    """잰 origin_rps: metrics/origin_rps.csv의 예열 뺀 평균, 없으면 metrics-summary.json의 평균(charts.py scale과 같다)."""
    scale = manifest.get('scale') or {}
    start = L.parse_time(manifest.get('started_at')) if manifest.get('started_at') else None
    rps = L.mean_after_warmup(L.read_metric_csv(root, run_id, 'origin_rps'), scale.get('warmup_s'), start)
    if rps is None:
        rps = (L.read_metrics_summary(root, run_id).get('origin_rps') or {}).get('mean')
    return rps


def origin(root, runs, version, admit_per_s=ADMIT_PER_S, tol=TOLERANCE):
    points = []
    for rid in runs:
        m = L.load_manifest(root, rid)
        users = (m.get('scale') or {}).get('users')
        valid = m.get('valid') is not False
        expected = None
        if users:
            expected = v1_origin_expected(users) if version == 'v1' else v0_origin_expected(users, admit_per_s)
        measured = measured_origin(root, rid, m)
        v = ratio_verdict(measured, expected, tol) if valid else {'ratio': (measured / expected) if (measured is not None and expected) else None, 'within': None}
        points.append({'run_id': rid, 'users': users, 'measured': measured, 'expected': expected, 'ratio': v['ratio'],
                       'within': v['within'] if valid else None, 'valid': valid, 'invalid_reason': m.get('invalid_reason')})
    used = [p for p in points if p['valid'] and p['within'] is not None]
    scales = sorted({p['users'] for p in used})
    million = v1_origin_expected(TARGET_USERS) if version == 'v1' else v0_origin_expected(TARGET_USERS, admit_per_s)
    if len(scales) < SCALES_NEEDED:
        verdict = f'판정하지 않음(유효한 규모 {len(scales)}개: 세 규모가 모자란다, docs/verification.md §3.4·계획 F-08-2 6.2)'
        out_million = None
    elif all(p['within'] for p in used):
        verdict = f'외삽(설계 식): 세 규모 모두 ±{tol * 100:g}% 안, 100만 명 원 서버 요청 {million:g}/s({version} 식)'
        out_million = million
    else:
        bad = ', '.join(f'{p["run_id"]} 비 {p["ratio"]:.3f}' for p in used if not p['within'])
        verdict = f'설계 식 밖: 식을 쓰지 않고 원인을 찾는다(±{tol * 100:g}% 밖 {bad}, docs/verification.md §3.4)'
        out_million = None
    return {'version': version, 'tolerance': tol, 'admit_per_s': admit_per_s if version == 'v0' else None, 'points': points,
            'scales': scales, 'verdict': verdict, 'million': out_million}


def origin_md(res):
    rows = ['| 실행 | 사용자 | 잰 origin_rps | 예상 | 비 | 판정 |', '| --- | --- | --- | --- | --- | --- |']
    for p in res['points']:
        judge = '무효(계산에서 뺌)' if not p['valid'] else ('안' if p['within'] else ('밖' if p['within'] is False else '값 없음'))
        f = lambda v, d=2: '-' if v is None else f'{v:.{d}f}'
        rows.append(f'| {p["run_id"]} | {p["users"]} | {f(p["measured"])} | {f(p["expected"])} | {f(p["ratio"], 3)} | {judge} |')
    return '\n'.join(rows) + f'\n\n판정: {res["verdict"]}\n'


def entry(scale_file, redis_r, target, factor_limit=FACTOR_LIMIT):
    s = L.load_json(scale_file) or {}
    x1 = s.get('x1Design') or s.get('x1')
    n_max = s.get('nMeasuredMax')
    prop = (s.get('proportionality') or {}).get('verdict')
    if not x1 or not n_max:
        return {'verdict': f'판정하지 않음(X₁ {x1}·잰 최대 대수 {n_max}이 없다)', 'proportionality': prop, 'design': None}
    d = entry_design(x1, redis_r, target, n_max, factor_limit)
    note = '' if prop and '까지 확인' in prop else '; 비례 전제 확인 못 함'
    return {'design': d, 'proportionality': prop, 'pod_cpus': s.get('podCpus'), 'x1_basis': 'x1Design(1 vCPU)' if s.get('x1Design') else 'x1(점의 몫)',
            'verdict': d['label'] + note}


def entry_md(res):
    d = res.get('design')
    if not d:
        return f'판정: {res["verdict"]}\n'
    return '\n'.join([
        '| X₁ | R | 목표 | 필요한 대수 | 잰 최대 대수 | 외삽 배수 | 용량 | 표시 |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
        f'| {d["x1"]:g} | {d["r"]:g} | {d["target"]:g} | {d["n_required"]} | {d["n_measured_max"]:g} | {d["extrapolation_factor"]:.2f} | {d["capacity"]:g} | {d["label"]} |',
        '', f'비례 판정: {res.get("proportionality") or "-"}', f'판정: {res["verdict"]}', ''])


def _write(path, text):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(text)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--root')
    sub = p.add_subparsers(dest='cmd', required=True)
    o = sub.add_parser('origin')
    o.add_argument('--runs', nargs='+', required=True)
    o.add_argument('--version', choices=['v0', 'v1'], required=True)
    o.add_argument('--admit-per-second', type=float, default=ADMIT_PER_S)
    o.add_argument('--tolerance', type=float, default=TOLERANCE)
    o.add_argument('--out', required=True)
    o.add_argument('--md')
    e = sub.add_parser('entry')
    e.add_argument('--scale', required=True)
    e.add_argument('--redis-r', type=float, required=True)
    e.add_argument('--target', type=float, default=200000)
    e.add_argument('--factor-limit', type=float, default=FACTOR_LIMIT)
    e.add_argument('--out', required=True)
    e.add_argument('--md')
    a = p.parse_args()
    if a.cmd == 'origin':
        root = a.root or L.find_root()
        res = origin(root, a.runs, a.version, a.admit_per_second, a.tolerance)
        md = origin_md(res)
    else:
        res = entry(a.scale, a.redis_r, a.target, a.factor_limit)
        md = entry_md(res)
    _write(a.out, json.dumps(res, ensure_ascii=False, indent=2) + '\n')
    if a.md:
        _write(a.md, md)
    print(md)
    print(f'결과 저장: {a.out}')


if __name__ == '__main__':
    main()
