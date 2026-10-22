"""perf-ledger/runs/ 원본에서 SVG 그래프를 만든다(표준 라이브러리만).

  python tools/perf-ledger/charts.py scale --runs RUN... --out perf-ledger/charts/scale.svg
  python tools/perf-ledger/charts.py before-after --pairs K1=RUN_V0:RUN_V1 ... --metric p99|error_rate --out FILE
  python tools/perf-ledger/charts.py timeline --run RUN --series origin_rps,p99_ms,error_rate --out FILE
  python tools/perf-ledger/charts.py usl --points usl.csv --target 200000 --out perf-ledger/charts/usl.svg
"""
import argparse
import csv
import io
import json
import math
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledgerlib as L  # noqa: E402


def _save(svg, out):
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    io.open(out, 'w', encoding='utf-8', newline='\n').write(svg.render())
    print(f'그래프 저장: {out}')


def chart_scale(root, runs, out):
    """비례 불변 곡선: 가로축 사용자 수(로그), 세로축 원 서버 RPS와 p99."""
    pts_rps, pts_p99 = [], []
    for r in runs:
        m = L.load_manifest(root, r)
        users = (m.get('scale') or {}).get('users')
        if not users:
            continue
        start = L.parse_time(m.get('started_at')) if m.get('started_at') else None
        rps = L.mean_after_warmup(L.read_metric_csv(root, r, 'origin_rps'), (m.get('scale') or {}).get('warmup_s'), start)
        p99 = (m.get('k6') or {}).get('p99_ms')
        pts_rps.append((users, rps))
        pts_p99.append((users, p99))
    title = '비례 불변 곡선: ' + ', '.join(runs)[:110]
    svg = L.Svg(900, 620, title)
    L.panel(svg, 80, 50, 780, 220, [('원 서버 초당 요청', pts_rps)], '동시 대기 사용자 수(로그 눈금)', '초당 요청', logx=True)
    L.panel(svg, 80, 340, 780, 220, [('p99(ms)', pts_p99)], '동시 대기 사용자 수(로그 눈금)', 'ms', logx=True)
    _save(svg, out)


def chart_before_after(root, pairs, metric, out):
    """KPI별 v0·v1 막대. pairs = [(label, run_v0, run_v1)]."""
    key = {'p99': 'p99_ms', 'error_rate': 'error_rate'}[metric]
    labels, v0, v1 = [], [], []
    for i, (label, a, b) in enumerate(pairs):
        ka = (L.load_manifest(root, a).get('k6') or {}).get(key)
        kb = (L.load_manifest(root, b).get('k6') or {}).get(key)
        if metric == 'error_rate':
            ka = None if ka is None else ka * 100
            kb = None if kb is None else kb * 100
        labels.append(label); v0.append((i, ka)); v1.append((i, kb))
    unit = 'ms' if metric == 'p99' else '%'
    svg = L.Svg(900, 400, f'전후 비교({metric}): ' + ', '.join(f'{l}' for l in labels))
    L.panel(svg, 80, 50, 780, 280, [('v0', v0), ('v1', v1)], 'KPI', unit, kind='bar', xlabels=labels)
    _save(svg, out)


def chart_timeline(root, run, series, out):
    """metrics/<name>.csv를 시간축으로 패널마다 그린다."""
    m = L.load_manifest(root, run)
    start = L.parse_time(m.get('started_at')) if m.get('started_at') else None
    n = len(series)
    svg = L.Svg(900, 60 + 240 * n, f'시간선: {run}')
    for i, name in enumerate(series):
        pts = L.read_metric_csv(root, run, name)
        t0 = start if start else (pts[0][0] if pts else 0)
        rel = [((t - t0), v) for t, v in pts]
        L.panel(svg, 80, 50 + 240 * i, 780, 170, [(name, rel)], '시작 후 초', name)
    _save(svg, out)


def usl_fit(points):
    """USL 적합(docs/verification.md §3.3). points = [(N, X)]이고 N=1 점이 있어야 한다.

    C(N) = X(N)/X(1)일 때 N/C(N) - 1 = a(N-1) + bN(N-1)을 원점을 지나는 최소제곱으로 푼다.
    반환: (gamma=X(1), alpha, beta).
    """
    ones = [x for n, x in points if n == 1]
    if not ones:
        sys.exit('USL: N=1 측정(X(1))이 필요합니다.')
    gamma = statistics.median(ones)
    s11 = s12 = s22 = s1y = s2y = 0.0
    for n, x in points:
        if n == 1:
            continue
        y = n / (x / gamma) - 1
        a1, a2 = n - 1, n * (n - 1)
        s11 += a1 * a1; s12 += a1 * a2; s22 += a2 * a2; s1y += a1 * y; s2y += a2 * y
    det = s11 * s22 - s12 * s12
    if abs(det) < 1e-12:
        sys.exit('USL: N=1 밖에 서로 다른 N이 2개 이상 필요합니다.')
    return gamma, (s1y * s22 - s2y * s12) / det, (s11 * s2y - s12 * s1y) / det


def usl_x(n, gamma, alpha, beta):
    return gamma * n / (1 + alpha * (n - 1) + beta * n * (n - 1))


def usl_required_n(target, gamma, alpha, beta):
    """X(N) >= target이 되는 가장 작은 N(실수). 닿지 않으면 None."""
    a = target * beta
    b = target * alpha - target * beta - gamma
    c = target * (1 - alpha)
    if abs(a) < 1e-15:
        return c / -b if b < 0 else None
    d = b * b - 4 * a * c
    if d < 0:
        return None
    roots = sorted(r for r in ((-b - math.sqrt(d)) / (2 * a), (-b + math.sqrt(d)) / (2 * a)) if r > 0)
    return roots[0] if roots else None


def chart_usl(points_file, target, out):
    """진입 서버 대수별 처리량에 USL을 맞추고 목표 처리량에 필요한 대수를 계산한다."""
    pts = []
    with io.open(points_file, encoding='utf-8', newline='') as fh:
        for r in csv.DictReader(fh):
            if (r.get('n') or '').strip() and (r.get('throughput') or '').strip():
                pts.append((float(r['n']), float(r['throughput'])))
    if len({n for n, _ in pts}) < 6:
        print('경고: 서로 다른 N이 6개보다 적습니다(Gunther는 6점 이상을 권한다).')
    gamma, alpha, beta = usl_fit(pts)
    xs = [x for _, x in pts]
    mean = sum(xs) / len(xs)
    ss_tot = sum((x - mean) ** 2 for x in xs)
    ss_res = sum((x - usl_x(n, gamma, alpha, beta)) ** 2 for n, x in pts)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else None
    n_meas = max(n for n, _ in pts)
    n_peak = math.sqrt((1 - alpha) / beta) if beta > 0 and alpha < 1 else None
    n_req = usl_required_n(target, gamma, alpha, beta) if target else None
    factor = n_req / n_meas if n_req else None
    res = {'gamma': gamma, 'alpha': alpha, 'beta': beta, 'r2': r2, 'n_measured_max': n_meas,
           'n_peak': n_peak, 'x_peak': usl_x(n_peak, gamma, alpha, beta) if n_peak else None,
           'target': target, 'n_required': n_req, 'n_required_ceil': math.ceil(n_req) if n_req else None,
           'extrapolation_factor': factor, 'points': [{'n': n, 'throughput': x} for n, x in pts]}
    print(f'USL: X(1)={gamma:g}, alpha={alpha:.5f}, beta={beta:.6f}, R2={r2 if r2 is None else round(r2, 4)}')
    if n_peak:
        print(f'정점: N={n_peak:.1f}, X={res["x_peak"]:.0f}')
    if target:
        if n_req:
            print(f'목표 {target:g}: 필요한 N={math.ceil(n_req)}(실수 {n_req:.2f}), 외삽 배수 {factor:.1f}배(측정 최대 N={n_meas:g})')
        else:
            print(f'목표 {target:g}: 이 곡선으로는 닿지 않음(서버를 늘려도 안 되는 공유 자원이 있음)')
    x_end = max(n_meas, n_req or 0, n_peak if n_peak and n_peak < 20 * n_meas else 0) * 1.1
    logx = x_end > 20 * n_meas

    def ns(a, b, k=60):
        if b <= a:
            return []
        if logx:
            la, lb = math.log10(a), math.log10(b)
            return [10 ** (la + (lb - la) * i / k) for i in range(k + 1)]
        return [a + (b - a) * i / k for i in range(k + 1)]
    fit_in = [(n, usl_x(n, gamma, alpha, beta)) for n in ns(1, n_meas)]
    fit_out = [(n, usl_x(n, gamma, alpha, beta)) for n in ns(n_meas, x_end)]
    series = [('측정', pts), ('USL 적합(측정 범위)', fit_in), ('USL 외삽', fit_out)]
    styles = [{'line': False}, {'markers': False, 'color': 1}, {'markers': False, 'dash': '6 4', 'color': 1}]
    guides = [('x', n_meas, f'측정 최대 N={n_meas:g}')]
    if target:
        guides.append(('y', target, f'목표 {target:g}'))
    title = f'USL 확장 곡선: alpha={alpha:.4f}, beta={beta:.5f}' + (f', 필요 N={math.ceil(n_req)}' if n_req else '')
    svg = L.Svg(900, 440, title)
    L.panel(svg, 80, 50, 780, 320, series, '서버 대수 N' + (' (로그 눈금)' if logx else ''), '초당 처리량(SLO 안)',
            logx=logx, styles=styles, guides=guides)
    _save(svg, out)
    jout = os.path.splitext(out)[0] + '.json'
    io.open(jout, 'w', encoding='utf-8', newline='\n').write(json.dumps(res, ensure_ascii=False, indent=2) + '\n')
    print(f'결과 저장: {jout}')
    return res


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--root')
    sub = p.add_subparsers(dest='cmd', required=True)
    s1 = sub.add_parser('scale'); s1.add_argument('--runs', nargs='+', required=True); s1.add_argument('--out', required=True)
    s2 = sub.add_parser('before-after'); s2.add_argument('--pairs', nargs='+', required=True, help='KPI=RUN_V0:RUN_V1'); s2.add_argument('--metric', choices=['p99', 'error_rate'], default='p99'); s2.add_argument('--out', required=True)
    s3 = sub.add_parser('timeline'); s3.add_argument('--run', required=True); s3.add_argument('--series', default='origin_rps,p99_ms,error_rate'); s3.add_argument('--out', required=True)
    s4 = sub.add_parser('usl'); s4.add_argument('--points', required=True, help='열: n,throughput[,run_id]'); s4.add_argument('--target', type=float); s4.add_argument('--out', required=True)
    a = p.parse_args()
    if a.cmd == 'usl':
        chart_usl(a.points, a.target, a.out)
        return
    root = a.root or L.find_root()
    if a.cmd == 'scale':
        chart_scale(root, a.runs, a.out)
    elif a.cmd == 'before-after':
        pairs = []
        for item in a.pairs:
            label, rest = item.split('=', 1)
            r0, r1 = rest.split(':', 1)
            pairs.append((label, r0, r1))
        chart_before_after(root, pairs, a.metric, a.out)
    else:
        chart_timeline(root, a.run, [s.strip() for s in a.series.split(',') if s.strip()], a.out)


if __name__ == '__main__':
    main()
