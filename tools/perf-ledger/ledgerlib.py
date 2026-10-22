"""성능 장부 도구 공통 함수(표준 라이브러리만)."""
import csv
import datetime as dt
import io
import json
import math
import os
import re
import sys

try:  # Windows cp949 콘솔에서 기호 때문에 죽지 않도록
    sys.stdout.reconfigure(errors='replace')
except (AttributeError, ValueError):
    pass

RUNS = os.path.join('perf-ledger', 'runs')
LEDGER_DOC = os.path.join('docs', 'perf-ledger.md')


def find_root(start=None):
    """docs/perf-ledger.md가 있는 폴더를 위로 올라가며 찾는다."""
    d = os.path.abspath(start or os.getcwd())
    while True:
        if os.path.exists(os.path.join(d, LEDGER_DOC)):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise SystemExit('저장소 루트(docs/perf-ledger.md가 있는 폴더)를 찾지 못했습니다. --root로 지정하세요.')
        d = parent


def parse_time(s):
    """ISO 8601(끝의 Z 허용) 또는 epoch 초 → epoch 초(float)."""
    if s is None:
        return None
    s = str(s).strip()
    try:
        return float(s)
    except ValueError:
        pass
    if s.endswith('Z'):
        s = s[:-1] + '+00:00'
    t = dt.datetime.fromisoformat(s)
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t.timestamp()


def iso_utc(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def load_json(path):
    with io.open(path, encoding='utf-8') as f:
        return json.load(f)


def load_manifest(root, run_id):
    return load_json(os.path.join(root, RUNS, run_id, 'manifest.json'))


def k6_metrics(summary):
    """k6 요약(handleSummary 형식과 --summary-export 형식 모두)에서 핵심 수치를 뽑는다."""
    m = (summary or {}).get('metrics', {}) or {}

    def vals(name):
        v = m.get(name) or {}
        return v.get('values', v) if isinstance(v, dict) else {}

    d = vals('http_req_duration')
    f = vals('http_req_failed')
    r = vals('http_reqs')
    drop = vals('dropped_iterations')
    out = {
        'p50_ms': d.get('med', d.get('p(50)')),
        'p95_ms': d.get('p(95)'),
        'p99_ms': d.get('p(99)'),
        'error_rate': f.get('rate', f.get('value')),
        'requests': r.get('count'),
        'rps': r.get('rate'),
        'dropped_iterations': drop.get('count', drop.get('value', 0)) or 0,
    }
    return out


def read_metric_csv(root, run_id, name):
    """metrics/<name>.csv → [(ts, value)] (첫 시계열만)."""
    path = os.path.join(root, RUNS, run_id, 'metrics', name + '.csv')
    if not os.path.exists(path):
        return []
    rows = []
    with io.open(path, encoding='utf-8', newline='') as f:
        rd = csv.DictReader(f)
        first_labels = None
        for r in rd:
            if first_labels is None:
                first_labels = r.get('labels', '')
            if r.get('labels', '') != first_labels:
                continue
            try:
                rows.append((float(r['ts']), float(r['value'])))
            except (KeyError, ValueError):
                continue
    return rows


def mean_after_warmup(points, warmup_s, start_ts):
    if not points:
        return None
    cut = (start_ts or points[0][0]) + (warmup_s or 0)
    vals = [v for t, v in points if t >= cut and not math.isnan(v)]
    if not vals:
        vals = [v for _, v in points if not math.isnan(v)]
    return sum(vals) / len(vals) if vals else None


# ---------------- K6(봇 탐지) 통계, ADR-0039·0048 ----------------
K6_TARGET_DETECTION = 0.95   # 1·2단계 등급마다 점추정. 3단계는 목표 없음(ADR-0048)
K6_TARGET_FP_UPPER = 0.005   # 사람 오탐률의 단측 95% 상한
K6_PENALTY_MULTIPLE = 50     # 부정판매 과징금 상한: 판매금액의 50배(공연법 §4의4)


def wilson(k, n, z=1.96):
    """Wilson 점수 구간(양측, 기본 95%). n이 0이면 None."""
    if not n:
        return None
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, centre - half), min(1.0, centre + half))


def _binom_cdf(k, n, p):
    if p <= 0:
        return 1.0
    if p >= 1:
        return 1.0 if k >= n else 0.0
    lp, lq, lg = math.log(p), math.log1p(-p), math.lgamma
    s = 0.0
    for i in range(k + 1):
        s += math.exp(lg(n + 1) - lg(i + 1) - lg(n - i + 1) + i * lp + (n - i) * lq)
    return min(1.0, s)


def cp_upper(k, n, alpha=0.05):
    """Clopper-Pearson 단측 (1-alpha) 상한. k=0이면 1-alpha^(1/n)."""
    if not n:
        return None
    if k >= n:
        return 1.0
    if k == 0:
        return 1 - alpha ** (1.0 / n)
    lo, hi = k / n, 1.0
    for _ in range(100):
        mid = (lo + hi) / 2
        if _binom_cdf(k, n, mid) > alpha:
            lo = mid
        else:
            hi = mid
    return hi


def tier_level(tier):
    """등급 이름 '<유형>-L<단계>'(예: volume-L1)에서 단계 1~3을 꺼낸다. 형식이 다르면 None."""
    m = re.search(r'-L([123])$', tier or '')
    return int(m.group(1)) if m else None


def k6_plan_parse(text):
    """사전 등록 계획 'N:C'(판정용 사람 표본 수:합격 오탐 수) → dict. 오탐 C건의 상한이 0.5%를 넘으면 ValueError."""
    try:
        n, c = (int(x) for x in str(text).split(':'))
    except ValueError:
        raise ValueError(f'K6 계획 형식은 N:C다: {text}')
    up = cp_upper(c, n)
    if up is None or up > K6_TARGET_FP_UPPER:
        raise ValueError(f'계획 {n}:{c}는 오탐 {c}건일 때 상한이 0.5%를 넘는다')
    return {'holdout_n': n, 'max_fp': c, 'upper95_at_max_fp': round(up, 5)}


def k6_eval_from_confusion(path, plan=None):
    """confusion.csv(tier,round,label,predicted,count[,stratum]) → 등급·라운드별 탐지율, 등급별 하락폭, 사람 오탐 상한.

    label·predicted는 bot 또는 human. 사람 행의 tier는 '-'로 둔다. 사람 행 중 stratum이 빈 행만 합계에 쓰고,
    stratum이 있는 행은 층별 집계에만 쓴다(한 세션이 여러 층에 속할 수 있다). 3단계 등급은 탐지율 목표가 없다.
    plan(k6_plan_parse 결과)이 있으면 마지막 라운드 사람 합계로 PASS·FAIL·INSUFFICIENT를 낸다(ADR-0048).
    """
    bots, humans, strata = {}, {}, {}
    with io.open(path, encoding='utf-8', newline='') as f:
        for r in csv.DictReader(f):
            label = (r.get('label') or '').strip().lower()
            pred = (r.get('predicted') or '').strip().lower()
            rnd = int(float(r.get('round') or 1))
            cnt = int(float(r.get('count') or 0))
            hit = cnt if pred == 'bot' else 0
            if label == 'bot':
                b = bots.setdefault(((r.get('tier') or '').strip(), rnd), [0, 0])
                b[0] += cnt
                b[1] += hit
            elif label == 'human':
                stratum = (r.get('stratum') or '').strip()
                h = strata.setdefault((rnd, stratum), [0, 0]) if stratum else humans.setdefault(rnd, [0, 0])
                h[0] += cnt
                h[1] += hit
    out = {'targets': {'detection': K6_TARGET_DETECTION, 'fp_upper95': K6_TARGET_FP_UPPER},
           'bots': [], 'tier_drops': [], 'humans': [], 'human_strata': [], 'plan': plan, 'plan_verdict': None}
    for (tier, rnd), (n, k) in sorted(bots.items(), key=lambda x: (x[0][1], x[0][0])):
        if not n:
            continue
        lo, hi = wilson(k, n)
        level = tier_level(tier)
        out['bots'].append({'tier': tier, 'level': level, 'round': rnd, 'n': n, 'detected': k, 'rate': round(k / n, 5),
                            'wilson95': [round(lo, 5), round(hi, 5)],
                            'meets_target': None if level == 3 else k / n >= K6_TARGET_DETECTION})
    by_tier = {}
    for b in out['bots']:
        by_tier.setdefault(b['tier'], []).append(b)
    for tier, rows in sorted(by_tier.items()):
        if len(rows) >= 2:
            first = min(rows, key=lambda b: b['round'])
            last = max(rows, key=lambda b: b['round'])
            out['tier_drops'].append({'tier': tier, 'from_round': first['round'], 'to_round': last['round'],
                                      'drop_pp': round((first['rate'] - last['rate']) * 100, 2)})
    for rnd, (n, k) in sorted(humans.items()):
        if not n:
            continue
        up = cp_upper(k, n)
        out['humans'].append({'round': rnd, 'n': n, 'false_pos': k, 'rate': round(k / n, 5),
                              'upper95_one_sided': round(up, 5), 'meets_target': up <= K6_TARGET_FP_UPPER})
    for (rnd, stratum), (n, k) in sorted(strata.items()):
        out['human_strata'].append({'round': rnd, 'stratum': stratum, 'n': n, 'false_pos': k})
    if plan and out['humans']:
        h = out['humans'][-1]
        if h['n'] < plan['holdout_n']:
            out['plan_verdict'] = 'INSUFFICIENT'
        else:
            ok = h['false_pos'] <= plan['max_fp'] and h['upper95_one_sided'] <= K6_TARGET_FP_UPPER
            out['plan_verdict'] = 'PASS' if ok else 'FAIL'
            if h['n'] != plan['holdout_n']:
                out['plan_note'] = '사람 표본 수가 사전 등록과 다르다'
    return out


def k6_cost(path, prices, usd_krw=None):
    """bot_cost.csv(tier,round,ids,proxy_gb,solves,ops_hours,infra_krw,tickets)와 단가 → 1장당 획득 비용과 웃돈별 손익(ADR-0048).

    1장당 획득 비용 = (명의 수×명의 단가 + 프록시 GB×GB 단가 + 풀이 수/1000×1000건 단가 + 운영 시간×시간 단가
    + 인프라 비용) ÷ 얻은 장수. 기대 처벌 = 적발 확률 × 50 × (정가 + 웃돈). 손익 = 웃돈 − 1장당 획득 비용 − 기대 처벌.
    얻은 장수가 0이면 비용과 손익은 None이다.
    """
    fx = prices.get('usd_krw') or usd_krw
    if not fx:
        raise ValueError('환율이 필요하다(bot_prices.json의 usd_krw 또는 --exchange-rate)')
    face = prices.get('face_krw', 0)
    out = {'usd_krw': fx, 'rows': []}
    with io.open(path, encoding='utf-8', newline='') as f:
        for r in csv.DictReader(f):
            def num(key):
                return float(r.get(key) or 0)
            total = (num('ids') * prices['id_krw'] + num('proxy_gb') * prices['proxy_usd_per_gb'] * fx
                     + num('solves') / 1000 * prices['solve_usd_per_1k'] * fx
                     + num('ops_hours') * prices['hour_krw'] + num('infra_krw'))
            tickets = int(num('tickets'))
            per = total / tickets if tickets else None
            cases = []
            for prem in prices.get('premiums_krw', []):
                for p in prices.get('catch_probs', [0]):
                    pen = p * K6_PENALTY_MULTIPLE * (face + prem)
                    margin = None if per is None else prem - per - pen
                    cases.append({'premium_krw': prem, 'catch_prob': p, 'expected_penalty_krw': round(pen),
                                  'margin_krw': None if margin is None else round(margin),
                                  'bot_profitable': None if margin is None else margin > 0})
            tier = (r.get('tier') or '').strip()
            out['rows'].append({'tier': tier, 'level': tier_level(tier), 'round': int(num('round') or 1),
                                'total_krw': round(total), 'tickets': tickets,
                                'per_ticket_krw': None if per is None else round(per), 'cases': cases})
    return out


def k6_summary(ev, cost=None):
    """장부 표용 한 줄 요약: 마지막 라운드의 1·2단계 최저 탐지율, 3단계 실측, 사람 오탐과 계획 판정, 1장당 최저 비용."""
    parts = []
    if ev and ev.get('bots'):
        last = max(b['round'] for b in ev['bots'])
        rows = [b for b in ev['bots'] if b['round'] == last]
        scored = [b for b in rows if b.get('level') != 3]
        if scored:
            worst = min(scored, key=lambda b: b['rate'])
            parts.append('라운드 %d 최저 탐지 %s %.1f%%' % (last, worst['tier'], worst['rate'] * 100))
        l3 = [b for b in rows if b.get('level') == 3]
        if l3:
            w3 = min(l3, key=lambda b: b['rate'])
            parts.append('3단계 %s %.1f%%(목표 없음)' % (w3['tier'], w3['rate'] * 100))
    if ev and ev.get('humans'):
        h = ev['humans'][-1]
        s = '오탐 %d/%d, 상한 %.2f%%' % (h['false_pos'], h['n'], h['upper95_one_sided'] * 100)
        if ev.get('plan_verdict'):
            s += ', 계획 ' + {'PASS': '통과', 'FAIL': '실패', 'INSUFFICIENT': '판정 보류'}[ev['plan_verdict']]
        parts.append(s)
    if cost and cost.get('rows'):
        last = max(r['round'] for r in cost['rows'])
        vals = [r['per_ticket_krw'] for r in cost['rows'] if r['round'] == last and r['per_ticket_krw'] is not None]
        if vals:
            parts.append('1장당 최저 %s원' % format(min(vals), ','))
    return ', '.join(parts) or None


def fmt_num(x, digits=0):
    if x is None:
        return '-'
    if digits == 0:
        return f'{x:,.0f}'
    return f'{x:,.{digits}f}'


def fmt_pct(x):
    return '-' if x is None else f'{x * 100:.1f}%'


# ---------------- SVG ----------------
class Svg:
    def __init__(self, w, h, title=''):
        self.w, self.h = w, h
        self.parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="sans-serif" font-size="12">',
                      f'<rect x="0" y="0" width="{w}" height="{h}" fill="#ffffff"/>']
        if title:
            self.text(w / 2, 20, title, size=15, anchor='middle', weight='bold')

    def text(self, x, y, s, size=12, anchor='start', weight='normal', fill='#222', rotate=None):
        s = s.replace('&', '&amp;').replace('<', '&lt;')
        tr = f' transform="rotate({rotate} {x} {y})"' if rotate else ''
        self.parts.append(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" text-anchor="{anchor}" font-weight="{weight}" fill="{fill}"{tr}>{s}</text>')

    def line(self, x1, y1, x2, y2, stroke='#999', width=1, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ''
        self.parts.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{stroke}" stroke-width="{width}"{d}/>')

    def polyline(self, pts, stroke, width=2, dash=None):
        s = ' '.join(f'{x:.1f},{y:.1f}' for x, y in pts)
        d = f' stroke-dasharray="{dash}"' if dash else ''
        self.parts.append(f'<polyline points="{s}" fill="none" stroke="{stroke}" stroke-width="{width}"{d}/>')

    def circle(self, x, y, r, fill):
        self.parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="{fill}"/>')

    def rect(self, x, y, w, h, fill):
        self.parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" fill="{fill}"/>')

    def render(self):
        return '\n'.join(self.parts + ['</svg>'])


COLORS = ['#4338CA', '#A3207E', '#0F766E', '#B45309', '#1D4ED8', '#6B7280']


def nice_ticks(lo, hi, n=5):
    if hi <= lo:
        hi = lo + 1
    span = hi - lo
    raw = span / n
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        step = m * mag
        if span / step <= n + 1:
            break
    start = math.floor(lo / step) * step
    ticks = []
    t = start
    while t <= hi + step * 0.5:
        ticks.append(round(t, 10))
        t += step
    return ticks


def panel(svg, x0, y0, w, h, series, xlabel, ylabel, logx=False, kind='line', xlabels=None, styles=None, guides=None):
    """series = [(name, [(x, y)...])]. kind: line | bar. bar는 x를 카테고리 인덱스로 본다.

    styles: 계열마다 {'markers': bool, 'dash': '6 4', 'color': 계열 번호} (line만, 없으면 기존 모양).
    guides: [('x' | 'y', 값, 이름)] 점선 기준선(line만).
    """
    svg.rect(x0, y0, w, h, '#f8fafc')
    allx = [x for _, pts in series for x, _ in pts]
    ally = [y for _, pts in series for _, y in pts if y is not None]
    guides = guides or []
    ally += [v for axis, v, _ in guides if axis == 'y']
    if not allx or not ally:
        svg.text(x0 + w / 2, y0 + h / 2, '데이터 없음', anchor='middle', fill='#999')
        return
    ymin, ymax = 0.0, max(ally) * 1.1 if max(ally) > 0 else 1.0
    yticks = nice_ticks(ymin, ymax)
    ymax = yticks[-1]
    if kind == 'bar':
        xmin, xmax = -0.5, len(xlabels or []) - 0.5
    else:
        xmin, xmax = min(allx), max(allx)
        if logx:
            xmin, xmax = math.log10(max(xmin, 1)), math.log10(max(xmax, 1))
        if xmax == xmin:
            xmax = xmin + 1

    def X(x):
        v = math.log10(max(x, 1)) if (logx and kind != 'bar') else x
        return x0 + (v - xmin) / (xmax - xmin) * w

    def Y(y):
        return y0 + h - (y - ymin) / (ymax - ymin) * h

    def lab(v):
        return fmt_num(v, 0 if float(v).is_integer() else 2)

    for t in yticks:
        svg.line(x0, Y(t), x0 + w, Y(t), stroke='#e2e8f0')
        svg.text(x0 - 6, Y(t) + 4, lab(t), anchor='end', size=10)
    svg.line(x0, y0, x0, y0 + h, stroke='#64748b')
    svg.line(x0, y0 + h, x0 + w, y0 + h, stroke='#64748b')
    if kind == 'bar':
        n = len(series)
        bw = w / max(len(xlabels), 1) / (n + 1)
        for i, (name, pts) in enumerate(series):
            for x, y in pts:
                bx = X(x) - bw * n / 2 + i * bw
                svg.rect(bx, Y(y), bw * 0.9, y0 + h - Y(y), COLORS[i % len(COLORS)])
                svg.text(bx + bw * 0.45, Y(y) - 4, lab(y), anchor='middle', size=10)
        for i, name in enumerate(xlabels or []):
            svg.text(X(i), y0 + h + 16, name, anchor='middle', size=11)
    else:
        xs = sorted(set(allx))
        if len(xs) <= 8:
            at = xs
        elif logx:  # 점이 많으면 10의 거듭제곱 자리만
            at = [10 ** k for k in range(int(math.floor(xmin)), int(math.ceil(xmax)) + 1) if xmin - 1e-9 <= k <= xmax + 1e-9]
        else:
            at = [t for t in nice_ticks(min(allx), max(allx), 6) if min(allx) <= t <= max(allx)]
        for xv in at:
            svg.line(X(xv), y0 + h, X(xv), y0 + h + 4, stroke='#64748b')
            svg.text(X(xv), y0 + h + 16, lab(xv), anchor='middle', size=10)
        for i, (name, pts) in enumerate(series):
            st = (styles[i] if styles and i < len(styles) else None) or {}
            pts = sorted((p for p in pts if p[1] is not None), key=lambda p: p[0])
            c = COLORS[st.get('color', i) % len(COLORS)]
            if st.get('line', True):
                svg.polyline([(X(x), Y(y)) for x, y in pts], c, dash=st.get('dash'))
            if st.get('markers', True):
                for x, y in pts:
                    svg.circle(X(x), Y(y), 3, c)
        for axis, v, name in guides:
            if axis == 'y':
                svg.line(x0, Y(v), x0 + w, Y(v), stroke='#B45309', width=1, dash='6 4')
                svg.text(x0 + w - 4, Y(v) - 4, name, anchor='end', size=10, fill='#B45309')
            elif xmin <= (math.log10(max(v, 1)) if logx else v) <= xmax:
                svg.line(X(v), y0, X(v), y0 + h, stroke='#64748b', width=1, dash='3 3')
                svg.text(X(v) + 4, y0 + 30, name, size=10, fill='#475569')
    # legend
    lx = x0 + 8
    for i, (name, _) in enumerate(series):
        st = (styles[i] if styles and i < len(styles) else None) or {}
        svg.rect(lx, y0 + 8, 10, 10, COLORS[st.get('color', i) % len(COLORS)])
        svg.text(lx + 14, y0 + 17, name, size=11)
        lx += 14 + 7 * len(name) + 16
    svg.text(x0 + w / 2, y0 + h + 34, xlabel, anchor='middle', size=11, fill='#475569')
    svg.text(x0 - 44, y0 + h / 2, ylabel, anchor='middle', size=11, fill='#475569', rotate=-90)
