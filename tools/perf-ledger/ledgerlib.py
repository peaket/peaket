"""성능 장부 도구 공통 함수(표준 라이브러리만)."""
import csv
import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import subprocess
import sys

try:  # Windows cp949 콘솔에서 기호 때문에 죽지 않도록
    sys.stdout.reconfigure(errors='replace')
except (AttributeError, ValueError):
    pass

RUNS = os.path.join('docs', 'perf-ledger', 'runs')
TIMESTAMPS = os.path.join('docs', 'perf-ledger', 'timestamps')  # 하루 해시 묶음과 OpenTimestamps 증명(docs/perf-ledger.md §9)
LEDGER_DOC = os.path.join('docs', 'perf-ledger.md')
# Git이 아니라 S3 원본 버킷에 두는 큰 원본(docs/perf-ledger.md §2.1·§9, 기술 검토 낮음-056)
RAW_DIRS = ('metrics/', 'traces/', 'grafana/')
RAW_FILES = ('stdout.log', 'invariants-detail.ndjson')  # 불변식 위반 행도 큰 원본이다(§2.1)


def is_raw(rel):
    """실행 폴더 안 상대 경로가 S3 원본 버킷에 두는 큰 원본인지."""
    rel = rel.replace('\\', '/')
    return rel in RAW_FILES or rel.startswith(RAW_DIRS)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


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
        value = float(s)
    except ValueError:
        pass
    else:
        if not math.isfinite(value):   # nan·inf는 모든 비교를 빠져나간다
            raise ValueError(f'시각이 유한한 값이 아니다: {s}')
        return value
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


def _no_constant(name):
    raise ValueError(f'JSON 바깥 값 {name}은 받지 않는다')


def load_json_strict(path):
    """사람이 쓰는 입력 파일용: 파이썬 json이 기본으로 받는 NaN·Infinity를 거부한다(범위 검사를 빠져나가지 않게)."""
    with io.open(path, encoding='utf-8') as f:
        return json.load(f, parse_constant=_no_constant)


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


def _after_warmup(points, warmup_s, start_ts):
    if not points:
        return []
    cut = (start_ts or points[0][0]) + (warmup_s or 0)
    vals = [v for t, v in points if t >= cut and not math.isnan(v)]
    return vals or [v for _, v in points if not math.isnan(v)]


def mean_after_warmup(points, warmup_s, start_ts):
    vals = _after_warmup(points, warmup_s, start_ts)
    return sum(vals) / len(vals) if vals else None


def percentile(vals, q):
    """가장 가까운 순위 방식의 백분위(q는 0~1): 정렬한 값의 ceil(q × n)번째."""
    if not vals:
        return None
    s = sorted(vals)
    return s[max(0, min(len(s) - 1, math.ceil(q * len(s)) - 1))]


def metrics_summary(run_dir, start_ts, warmup_s):
    """metrics/<이름>.csv마다 예열을 뺀 구간의 p50·p99·최대·평균(docs/perf-ledger.md §2.1 metrics-summary.json).

    시계열이 여럿이면 첫 시계열만 쓴다(charts.py와 같다). 시계열 수와 첫 시계열의 라벨을 함께 적는다.
    """
    out = {}
    mdir = os.path.join(run_dir, 'metrics')
    if not os.path.isdir(mdir):
        return out
    for fn in sorted(os.listdir(mdir)):
        if not fn.endswith('.csv'):
            continue
        series, first, pts = [], None, []
        with io.open(os.path.join(mdir, fn), encoding='utf-8', newline='') as f:
            for r in csv.DictReader(f):
                labels = r.get('labels', '')
                if labels not in series:
                    series.append(labels)
                if first is None:
                    first = labels
                if labels != first:
                    continue
                try:
                    pts.append((float(r['ts']), float(r['value'])))
                except (KeyError, ValueError):
                    continue
        vals = _after_warmup(pts, warmup_s, start_ts)
        out[fn[:-4]] = {'points': len(vals), 'series': len(series), 'labels': first,
                        'p50': percentile(vals, 0.5), 'p99': percentile(vals, 0.99),
                        'max': max(vals) if vals else None, 'mean': (sum(vals) / len(vals)) if vals else None}
    return out


def read_metrics_summary(root, run_id):
    path = os.path.join(root, RUNS, run_id, 'metrics-summary.json')
    return load_json(path) if os.path.exists(path) else {}


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
    if k > 200:
        # 어긴 수가 많으면 항을 다 더하지 않고 불완전 베타로 계산한다: P(X ≤ k) = I_{1-p}(n-k, k+1)
        return betainc(n - k, k + 1, 1 - p)
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


def cp_lower(k, n, alpha=0.05):
    """Clopper-Pearson 단측 (1-alpha) 하한. k=0이면 0이다."""
    if not n:
        return None
    return 0.0 if k <= 0 else 1 - cp_upper(n - k, n, alpha)


# --- 비율·백분위 목표의 판정(docs/planning/02 §3.1 원칙 6, docs/perf-ledger.md §2.2 `checks`·§7, 기술 검토 중간-002) ---

class CheckInputError(ValueError):
    """`--checks` 파일이 형식에 맞지 않는다. 측정 폴더를 만들기 전에 거부한다."""


class HistogramUncountable(CheckInputError):
    """측정 창 안에서 파드가 끝나거나 다시 시작해(사라진 시계열·카운터 되돌아감) 서버 히스토그램을 셀 수 없다.
    collect.py는 종료 코드 3으로 끝내고, 실행 도구는 그때만 그 점검을 빼고 다시 남긴다(BSL-090 2차 리뷰)."""


CHECK_NAME = re.compile(r'^[A-Za-z0-9_.-]{1,64}$')
METRIC_NAME = re.compile(r'^[a-zA-Z_:][a-zA-Z0-9_:]*$')
# 라벨 선택자는 중괄호 안의 `이름="값"`을 쉼표로 이은 것만 받는다(조회 식을 끝내거나 다른 식을 잇지 못하게).
# 값 안의 중괄호는 경로 틀(`/v1/queues/{eventId}/entries`)이라 받고, 따옴표·역빗금·줄바꿈은 받지 않는다
LABEL_MATCH = re.compile(r'^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*(=|!=|=~|!~)\s*"[^"\\\n]*"\s*(,\s*[a-zA-Z_][a-zA-Z0-9_]*\s*(=|!=|=~|!~)\s*"[^"\\\n]*"\s*)*$')


def min_trials(allowed, alpha=0.05):
    """어긴 수가 0일 때 상한이 허용 비율 이하가 되는 최소 시행 수(99.9%면 2,995, p99면 299, p95면 59)."""
    return math.ceil(math.log(alpha) / math.log1p(-allowed) - 1e-9)


def judge_check(name, allowed, trials, violations, target=None):
    """점검 한 줄의 판정. 최소 시행 수 미달은 observed, 상한이 허용 비율 이하면 pass, 아니면 fail."""
    up = cp_upper(violations, trials)
    need = min_trials(allowed)
    result = 'observed' if trials < need else ('pass' if up <= allowed else 'fail')
    out = {'name': name, 'allowed': allowed, 'trials': trials, 'violations': violations,
           'cp_upper': round(up, 6) if up is not None else None, 'min_trials': need, 'result': result}
    if target:
        out['target'] = target
    return out


def _finite_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_count(v):
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def parse_checks(doc):
    """`--checks` JSON → (점검 정의 목록, 대조 정의). 모르는 키·범위 밖 값은 CheckInputError."""
    if not isinstance(doc, dict) or set(doc) - {'checks', 'crosscheck'} or not isinstance(doc.get('checks'), list):
        raise CheckInputError('맨 위는 checks(목록)와 crosscheck만 둔다')
    if not doc['checks']:
        raise CheckInputError('checks가 비었다(점검이 없으면 --checks를 주지 않는다)')
    seen, out = set(), []
    for i, c in enumerate(doc['checks']):
        where = f'checks[{i}]'
        if not isinstance(c, dict):
            raise CheckInputError(f'{where}: 객체가 아니다')
        extra = set(c) - {'name', 'target', 'allowed', 'trials', 'violations', 'histogram'}
        if extra:
            raise CheckInputError(f'{where}: 모르는 키 {sorted(extra)}')
        name = c.get('name')
        if not isinstance(name, str) or not CHECK_NAME.match(name) or name in seen:
            raise CheckInputError(f'{where}: 이름은 영문·숫자·_.- 64자 이하이고 겹치지 않는다')
        seen.add(name)
        allowed = c.get('allowed')
        if not _finite_number(allowed) or not 0 < allowed < 1:
            raise CheckInputError(f'{name}: allowed는 0과 1 사이다')
        if c.get('target') is not None and not isinstance(c['target'], str):
            raise CheckInputError(f'{name}: target은 글이다')
        has_counts = 'trials' in c or 'violations' in c
        if has_counts == ('histogram' in c):
            raise CheckInputError(f'{name}: trials·violations와 histogram 가운데 하나만 준다')
        if has_counts:
            n, k = c.get('trials'), c.get('violations')
            if not _is_count(n) or not _is_count(k) or n == 0 or k > n:
                raise CheckInputError(f'{name}: trials는 1 이상 정수, violations는 0 이상이고 trials 이하인 정수다')
        else:
            h = c['histogram']
            if not isinstance(h, dict) or set(h) - {'metric', 'match', 'le'}:
                raise CheckInputError(f'{name}: histogram은 metric·match·le만 둔다')
            if not isinstance(h.get('metric'), str) or not METRIC_NAME.match(h['metric']):
                raise CheckInputError(f'{name}: histogram.metric이 지표 이름이 아니다')
            if not isinstance(h.get('match'), str) or not LABEL_MATCH.match(h['match']):
                raise CheckInputError(f'{name}: histogram.match는 이름="값"을 쉼표로 이은 라벨 선택자다')
            le = h.get('le')
            if not _finite_number(le) or le <= 0:
                raise CheckInputError(f'{name}: histogram.le는 양수(초)다')
        out.append(c)
    cross = doc.get('crosscheck')
    if cross is not None:
        if not isinstance(cross, dict) or set(cross) - {'check', 'target_ms', 'k6_metric'}:
            raise CheckInputError('crosscheck는 check·target_ms·k6_metric만 둔다')
        ref = next((c for c in out if c['name'] == cross.get('check')), None)
        if ref is None or 'histogram' not in ref:
            raise CheckInputError('crosscheck.check는 histogram 점검의 이름이다')
        # 목표는 그 점검의 기준값 칸이다. 따로 적으면 같은 값이어야 한다(두 기준을 섞어 '측정 지점 의심'을 판단하지 않게)
        target = ref['histogram']['le'] * 1000
        t = cross.get('target_ms', target)
        if not _finite_number(t) or abs(t - target) > 1e-6 * max(1.0, target):
            raise CheckInputError(f'crosscheck.target_ms({t})가 점검 {ref["name"]}의 기준값 칸({target}ms)과 다르다')
        # 같은 창·같은 경로가 되게 시나리오가 측정 구간·경로 요청에 단 태그의 하위 지표를 적는다(기본값을 두지 않는다)
        if not isinstance(cross.get('k6_metric'), str) or not cross['k6_metric']:
            raise CheckInputError('crosscheck.k6_metric(측정 구간·경로의 k6 하위 지표 이름)이 필요하다')
        cross = {**cross, 'target_ms': target}
    return out, cross


# 측정 창의 칸 개수는 창 끝과 창 시작의 카운터 합의 차이로 센다. increase()는 창 안에서 처음 나타난 시계열(측정 중에
# 뜬 파드)의 첫 표본을 세지 않고 외삽으로 소수를 만들어, 느린 요청이 몰리는 막 뜬 파드 몫을 빠뜨린다(새 맥락 리뷰).
# 창 시작에 없던 시계열은 0부터 센다. 창 안에서 사라진 시계열과 카운터 되돌아감은 셀 수 없어 거부한다.
def _sel(h):
    return f'{h["metric"]}_bucket{{{h["match"]}}}'


def hist_sum_query(h):
    return f'sum by (le) ({_sel(h)})'


LOOKBACK_S = 300  # Prometheus 조회 유예(기본 5분). 창 시작의 합은 이만큼 앞의 표본까지 쓴다


def hist_lost_query(h, window_s):
    """창 끝에서 부른다: 창 안에 표본이 있었는데 끝에 없는 시계열 수(창 시작에 있다 사라진 것과 창 안에서 생겼다 사라진 것 모두)."""
    return f'count(last_over_time({_sel(h)}[{int(window_s)}s]) unless {_sel(h)})'


def hist_resets_query(h, window_s):
    """창 끝에서 부른다: 카운터 되돌아감(프로세스 재시작) 수. 창 시작의 합이 쓰는 앞 표본과 창 안 첫 표본 사이의
    재시작도 보도록 조회 유예만큼 앞에서부터 본다(예열 중의 재시작도 잡혀 거부되지만 안전한 쪽이다)."""
    return f'sum(resets({_sel(h)}[{int(window_s) + LOOKBACK_S}s]))'


def scalar_of(result):
    """sum·count 즉시 조회 결과 → 수(결과가 없으면 0)."""
    return sum(float(s['value'][1]) for s in result or [])


def hist_buckets(result, need_inf=True):
    """sum by (le) 즉시 조회 결과 → [(le, 개수)] le 오름차순. 같은 경계를 다르게 적은 칸('1'·'1.0')은 합친다."""
    acc = {}
    for s in result or []:
        le = (s.get('metric') or {}).get('le')
        if le is None:
            continue
        b = math.inf if le in ('+Inf', 'Inf') else float(le)
        acc[b] = acc.get(b, 0.0) + float(s['value'][1])
    out = sorted((b, round(v)) for b, v in acc.items())
    if need_inf and (not out or out[-1][0] != math.inf):
        raise CheckInputError('히스토그램에 +Inf 칸이 없다(지표 이름·선택자를 확인한다)')
    return out


def hist_window(start, end):
    """창 끝 칸 − 창 시작 칸(시작에 없는 칸은 0). 줄어든 칸이 있으면 셀 수 없다. 누적 개수가 거꾸로 가면 앞 칸 값으로 맞춘다
    (Prometheus histogram_quantile과 같은 처리)."""
    s = dict(start)
    out, prev = [], 0
    for b, c in end:
        d = c - s.pop(b, 0)
        if d < 0:
            raise CheckInputError(f'칸 {b}의 카운터가 창 안에서 되돌아갔다(재시작). 셀 수 없다')
        prev = max(prev, d)
        out.append((b, prev))
    if s:
        raise CheckInputError(f'창 시작에만 있는 칸 {sorted(s)}이 있다(사라진 시계열). 셀 수 없다')
    return out


def hist_counts(buckets, le):
    """(시행 수, 기준값을 넘은 수). 기준값과 같은 칸 경계가 없으면 CheckInputError(ADR-0077: 칸 경계를 기준값에 맞춘다)."""
    n = buckets[-1][1]
    at = next((c for b, c in buckets if abs(b - le) <= 1e-9 * max(1.0, le)), None)
    if at is None:
        raise CheckInputError(f'기준값 {le}초와 같은 칸 경계가 없다(있는 칸: {[b for b, _ in buckets[:-1]]})')
    return n, max(0, n - at)


def hist_quantile(q, buckets):
    """Prometheus histogram_quantile과 같은 선형 보간(초). 개수가 없으면 None."""
    n = buckets[-1][1]
    if n <= 0:
        return None
    rank = q * n
    prev_le, prev_c = 0.0, 0
    for le, c in buckets:
        if c >= rank:
            if le == math.inf:
                return prev_le
            if c == prev_c:
                return le
            return prev_le + (le - prev_le) * (rank - prev_c) / (c - prev_c)
        prev_le, prev_c = le, c
    return prev_le


def verdict_from_checks(checks):
    """점검 결과 → 판정. 하나라도 fail이면 fail, observed가 있으면 None(미판정), 모두 pass면 pass."""
    results = [c['result'] for c in checks]
    if 'fail' in results:
        return 'fail'
    return None if 'observed' in results else 'pass'


def observed_notes(checks):
    return [f'{c["name"]}: 관측값(시행 {c["trials"]}번, 최소 시행 수 미달)' for c in checks if c['result'] == 'observed']


def betainc(a, b, x):
    """정규화한 불완전 베타 함수 I_x(a, b). 연분수(Lentz 방법)로 계산한다(표준 라이브러리만)."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0

    def cf(a, b, x):
        tiny, qab, qap, qam = 1e-300, a + b, a + 1, a - 1
        c, d = 1.0, 1 - qab * x / qap
        d = 1 / (d if abs(d) > tiny else tiny)
        h = d
        for m in range(1, 20001):
            m2 = 2 * m
            for aa in (m * (b - m) * x / ((qam + m2) * (a + m2)), -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))):
                d = 1 + aa * d
                d = 1 / (d if abs(d) > tiny else tiny)
                c = 1 + aa / c
                c = c if abs(c) > tiny else tiny
                h *= d * c
            if abs(d * c - 1) < 1e-15:
                break
        return h

    lbt = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log1p(-x)
    if x < (a + 1) / (a + b + 2):
        return math.exp(lbt) * cf(a, b, x) / a
    return 1 - math.exp(lbt) * cf(b, a, 1 - x) / b


def f_cdf(x, d1, d2):
    """F 분포(자유도 d1, d2)의 누적 확률 P(F ≤ x)."""
    if x <= 0:
        return 0.0
    return betainc(d1 / 2, d2 / 2, d1 * x / (d1 * x + d2))


def f_ppf(p, d1, d2):
    """F 분포의 p 분위수. 누적 확률을 이분법으로 맞춘다."""
    lo, hi = 0.0, 1.0
    while f_cdf(hi, d1, d2) < p and hi < 1e12:
        lo, hi = hi, hi * 2
    for _ in range(200):
        mid = (lo + hi) / 2
        if f_cdf(mid, d1, d2) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def icc1(groups, alpha=0.05):
    """일원 랜덤 효과 ICC(1)과 단측 (1-alpha) 상한(F 분포). groups = 사람마다 점수 목록. 2개 이상인 사람만 쓴다.

    ICC(1) = (MSB − MSW) ÷ (MSB + (k0 − 1)·MSW), k0 = (N − Σnᵢ² ÷ N) ÷ (g − 1)(사람마다 세션 수가 달라도 되는 꼴).
    상한은 F = MSB ÷ MSW에 F 분포의 (1-alpha) 분위수(자유도 N−g, g−1)를 곱한 F_U로 (F_U − 1) ÷ (F_U + k0 − 1)이다.
    사람이 2명보다 적거나 점수가 모두 같으면 None.
    """
    gs = [[float(v) for v in g] for g in groups if len(g) >= 2]
    g, n_all = len(gs), sum(len(x) for x in gs)
    if g < 2:
        return None
    grand = sum(sum(x) for x in gs) / n_all
    means = [sum(x) / len(x) for x in gs]
    ssb = sum(len(x) * (m - grand) ** 2 for x, m in zip(gs, means))
    ssw = sum((v - m) ** 2 for x, m in zip(gs, means) for v in x)
    df1, df2 = g - 1, n_all - g
    msb, msw = ssb / df1, ssw / df2
    k0 = (n_all - sum(len(x) ** 2 for x in gs) / n_all) / df1
    out = {'people': g, 'sessions': n_all, 'k0': round(k0, 4), 'df': [df1, df2], 'alpha_one_sided': alpha}
    if msw == 0:
        if msb == 0:
            return None
        out.update({'icc': 1.0, 'f': None, 'upper_one_sided': 1.0})
        return out
    f = msb / msw
    fu = f * f_ppf(1 - alpha, df2, df1)
    out.update({'icc': round((msb - msw) / (msb + (k0 - 1) * msw), 5), 'f': round(f, 4),
                'upper_one_sided': round((fu - 1) / (fu + k0 - 1), 5)})
    return out


def tier_level(tier):
    """등급 이름 '<유형>-L<단계>'(예: volume-L1)에서 단계 1~3을 꺼낸다. 형식이 다르면 None."""
    m = re.search(r'-L([123])$', tier or '')
    return int(m.group(1)) if m else None


def k6_plan_parse(text):
    """사전 등록 계획 'N:C'(판정 기록을 낸 사람 수:합격 오탐 수, ADR-0112) → dict. 오탐 C건의 상한이 0.5%를 넘으면 ValueError."""
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

    label·predicted는 bot 또는 human. 사람 행의 tier는 '-'로 두고 판정 기록만 센다(ADR-0112). 사람 행 중 stratum이 빈 행만 합계에 쓰고,
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
                out['plan_note'] = '판정 기록을 낸 사람 수가 사전 등록과 다르다'
    return out


class K6InputError(ValueError):
    """K6 입력 파일끼리 어긋나서 판정하지 않고 실행을 거부해야 할 때(docs/perf-ledger.md §10.5)."""


def _read_rows(path, columns, name, optional=None):
    """CSV를 읽는다. optional을 주면(빈 묶음이라도) columns와 optional 밖의 열을 거부한다."""
    with io.open(path, encoding='utf-8', newline='') as f:
        rd = csv.DictReader(f)
        fields = rd.fieldnames or []
        missing = [c for c in columns if c not in fields]
        if missing:
            raise K6InputError(f'{name}에 열이 없다: {", ".join(missing)}(필요한 열: {",".join(columns)})')
        if optional is not None:
            unknown = [c for c in fields if c not in columns and c not in optional]
            if unknown:
                raise K6InputError(f'{name}에 모르는 칸이 있다: {", ".join(unknown)}'
                                   '(입력한 글자 칸은 옮기지 않는다, docs/perf-ledger.md §10.5)')
        rows = list(rd)
    extra = [i for i, r in enumerate(rows, 2) if None in r]
    if extra:
        raise K6InputError(f'{name}에 머리글보다 칸이 많은 행이 {len(extra)}개 있다(처음 {extra[0]}행)')
    return rows


def _examples(codes, limit=3):
    codes = sorted(codes)
    return ', '.join(codes[:limit]) + (' 등' if len(codes) > limit else '')


K6_SOURCES = ('public', 'mock', 'live')
K6_SOURCE_LABELS = {'public': '공개 자료 기준', 'mock': '모의 사람(리허설)', 'live': '실제 사람 기준(출시 뒤)'}
K6_STRENGTHS = ('완화', '기본', '강화')   # 판정 강도 셋(docs/perf-ledger.md §10.2)
K6_JUDGED_STRENGTH = '기본'             # 합격 판정은 기본 강도로만 한다. 나머지는 민감도다(§10.2)
K6_SORT_MODES = ('shuffle', 'fcfs')     # 정렬 방식: 로비 셔플 또는 선착순(docs/features/bot-defense.md §4.4)
K6_BEHAVIOR_CRITERION_RATIO = 0.5       # BehaviorScore 혼자 기준 = 판정 기준값의 절반 [가정, ADR-0174 결정 2]
K6_POINTER_UNMEASURED = '포인터 칸 측정 못 함(이용 허락 없음)'
K6_REGISTRATIONS_DIR = 'docs/perf-ledger/registrations'
K6_DATASET_PINS = 'docs/perf-ledger/datasets.json'
K6_TEST_PIN_ENV = 'PEAKET_HUMAN_DATA_TEST_PIN'   # 시험에서만 켠다. 켜면 --dataset-pin이 합격을 막지 않고 manifest와 장부 표에 드러난다
K6_MAX_MISSING_RATIO_LIMIT = 0.05       # 사전 등록할 수 있는 값 없음 비율의 상한 [가정, ADR-0246]
K6_START_FUTURE_SKEW_S = 300            # 측정 시작이 지금보다 뒤여도 되는 여유 [가정, ADR-0246]
K6_VERIFY_RESULT = 'verify-result.json'
_VERIFY_KEYS = {'registration_hash', 'result', 'source_file_checked', 'verified_at', 'reason'}
K6_UNMEASURABLE_TEXT = {'ceiling': '점수기 기여가 기준에 못 미침', 'missing_values': '값 없음 비율 초과', 'no_values': '값 있는 판정 기록 없음',
                        'dataset_not_pinned': '자료 고정값 없음', 'dataset_pin_mismatch': '자료 고정값과 다름',
                        'dataset_pin_overridden': '자료 고정 파일을 인자로 바꿈'}
HUMAN_SESSION_COLUMNS = ('source', 'person', 'role', 'stratum', 'round', 'predicted', 'score')
HUMAN_SESSION_OPTIONAL = ('behavior_score',)   # mock만: 같은 기록의 BehaviorScore 혼자 위험 기여(ADR-0174 결정 4)
_REGISTRATION_KEYS = {'id', 'source', 'registered_at', 'salt', 'plan', 'dataset', 'seeds', 'conversion_rule', 'tune_n', 'behavior_rule',
                      'max_missing_ratio', 'judge_people_sha256', 'judge_records_sha256', 'tune_people_sha256', 'tool_commit', 'tool_sha256'}
_DATASET_KEYS = {'name', 'version', 'sha256', 'readme_sha256', 'attribution'}
_RULE_KEYS = {'strength', 'sort_mode', 'decision_threshold', 'weight', 'max_risk', 'public_max_risk'}
_HEX64 = re.compile(r'[0-9a-f]{64}')


def require_outside_git(path, what):
    """사람별 자료와 비공개 등록 파일은 어떤 Git 저장소 안에도 두지 않는다. 대상과 모든 상위 폴더에서 .git을 찾는다(ADR-0174 결정 7).

    콜론이 든 경로 요소는 Windows의 대체 스트림이라 파일 이름 검사를 빠져나갈 수 있어 거부하고, 실제 경로와 절대 경로를 둘 다 본다.
    .git 없는 베어 저장소는 찾지 못한다(ADR-0246 남는 한계).
    """
    if ':' in os.path.splitdrive(os.path.abspath(path))[1]:
        raise K6InputError(f'{what}의 경로 요소에 콜론이 있다: {path}')
    for start in {os.path.realpath(path), os.path.abspath(path)}:
        d = start
        while True:
            if os.path.exists(os.path.join(d, '.git')):
                raise K6InputError(f'{what}이 Git 저장소 안이다. 사람별 자료와 비공개 등록 파일은 저장소 밖에 둔다: {path}')
            parent = os.path.dirname(d)
            if parent == d:
                break
            d = parent


def required_time(value, what):
    """있어야 하는 시각을 유한한 epoch 초로 바꾼다. 없거나 시각이 아니면 거부한다."""
    try:
        t = parse_time(value)
    except (ValueError, OverflowError):
        t = None
    if t is None:
        raise K6InputError(f'{what}이 시각이 아니다')
    return t


def records_hash(salt, path):
    """기록 파일 내용의 소금 넣은 해시. 사람 목록이 같아도 요약 값을 고치면 달라진다."""
    h = hashlib.sha256((salt + '\n').encode('utf-8'))
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def registration_hash(reg):
    """소금을 포함한 비공개 등록 내용 전체의 해시(ADR-0246). 소금이 있어 공개 칸으로 비공개 값을 맞혀 볼 수 없다."""
    return hashlib.sha256(canonical_json(reg).encode('utf-8')).hexdigest()


def people_hash(salt, people):
    """판정용·조정용 사람 목록의 해시. 사람 코드가 짧아 소금을 함께 넣는다."""
    return hashlib.sha256('\n'.join([salt, *sorted(people)]).encode('utf-8')).hexdigest()


def tool_sha256():
    """변환·판정 도구 파일의 해시. 등록 뒤 도구가 바뀌면 다시 등록한다."""
    h = hashlib.sha256()
    here = os.path.dirname(os.path.abspath(__file__))
    for name in ('human_data.py', 'ledgerlib.py'):
        with open(os.path.join(here, name), 'rb') as f:
            h.update(f.read())
        h.update(b'\0')
    return h.hexdigest()


def behavior_rule(spec, source):
    """사전 등록한 강도·정렬 방식·기준값·가중치·최대 위험 값 → BehaviorScore 혼자 기준(ADR-0174 결정 2, ADR-0246).

    기준 = 그 강도의 판정 기준값 × 0.5 [가정]. public의 최대 기여는 공개 자료에 채워지는 칸만 있을 때의 최대 위험 값(public_max_risk)으로 낸다
    [가정, 실제 값은 BOT-170이 정한다]. 최대 기여가 기준보다 작으면 측정 무의미다. 이 값들은 비공개라(POL-006) 장부에 적지 않는다.
    """
    if not isinstance(spec, dict) or set(spec) != _RULE_KEYS:
        raise K6InputError(f'behavior_rule의 칸은 {",".join(sorted(_RULE_KEYS))}이다')
    if spec['strength'] not in K6_STRENGTHS:
        raise K6InputError(f'behavior_rule.strength는 {"·".join(K6_STRENGTHS)} 중 하나다')
    if spec['sort_mode'] not in K6_SORT_MODES:
        raise K6InputError(f'behavior_rule.sort_mode는 {"·".join(K6_SORT_MODES)} 중 하나다')
    for key, low_open in (('decision_threshold', True), ('weight', False), ('max_risk', True), ('public_max_risk', True)):
        v = spec[key]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 or (low_open and v == 0):
            raise K6InputError(f'behavior_rule.{key}가 범위 밖이다')
    if spec['public_max_risk'] > spec['max_risk']:
        raise K6InputError('behavior_rule.public_max_risk가 max_risk보다 크다')
    ceiling = spec['public_max_risk'] if source == 'public' else spec['max_risk']
    criterion = round(spec['decision_threshold'] * K6_BEHAVIOR_CRITERION_RATIO, 6)
    max_contribution = round(spec['weight'] * ceiling, 6)
    return {'strength': spec['strength'], 'sort_mode': spec['sort_mode'], 'criterion_ratio': K6_BEHAVIOR_CRITERION_RATIO, 'criterion': criterion,
            'ceiling': ceiling, 'max_contribution': max_contribution, 'unmeasurable': max_contribution < criterion, 'weight': spec['weight']}


def k6_load_registration(path):
    """비공개 등록 파일을 읽고 형식을 확인한다. 돌려주는 값: (등록 내용, BehaviorScore 혼자 기준, 소금을 포함한 등록 해시)."""
    require_outside_git(path, '--k6-registration')
    try:
        reg = load_json_strict(path)
    except (OSError, ValueError) as e:
        raise K6InputError(f'사전 등록 파일을 읽지 못했다: {e}')
    if not isinstance(reg, dict) or set(reg) != _REGISTRATION_KEYS:
        extra = sorted(set(reg) - _REGISTRATION_KEYS) if isinstance(reg, dict) else []
        raise K6InputError(f'사전 등록 파일의 칸이 규칙 밖이다{(": " + ",".join(extra)) if extra else ""}'
                           f'(필요한 칸: {",".join(sorted(_REGISTRATION_KEYS))})')
    if reg['source'] not in ('public', 'mock'):
        raise K6InputError('사전 등록의 원천은 public·mock이다')
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', str(reg['id'])) or reg['id'].startswith('.'):
        raise K6InputError('사전 등록 id가 규칙 밖이다')
    for key in ('salt', 'judge_people_sha256', 'judge_records_sha256', 'tune_people_sha256', 'tool_sha256'):
        if not _HEX64.fullmatch(str(reg[key])):
            raise K6InputError(f'{key}는 64자리 16진수다')
    if not reg['tool_commit'] or not isinstance(reg['tool_commit'], str):
        raise K6InputError('tool_commit이 비었다')
    if reg['tool_sha256'] != tool_sha256():
        raise K6InputError('도구(human_data.py·ledgerlib.py)가 등록 뒤 바뀌었다. 다시 등록한다')
    ds = reg['dataset']
    if not isinstance(ds, dict) or set(ds) != _DATASET_KEYS:
        raise K6InputError(f'dataset의 칸은 {",".join(sorted(_DATASET_KEYS))}이다')
    if not _HEX64.fullmatch(str(ds['sha256'])) or not ds['name'] or not ds['version']:
        raise K6InputError('dataset의 이름·판·해시(SHA-256)가 규칙 밖이다')
    if reg['source'] == 'public' and (not ds['attribution'] or not _HEX64.fullmatch(str(ds['readme_sha256'] or ''))):
        raise K6InputError('public은 출처 표시 문구와 자료 readme의 해시가 있어야 한다')
    seeds = reg['seeds']
    if not isinstance(seeds, dict) or set(seeds) != {'split', 'draw'} or not all(isinstance(v, int) and not isinstance(v, bool) for v in seeds.values()):
        raise K6InputError('seeds는 정수 split·draw다(조정용·판정용을 나눈 씨앗값과 뽑기 씨앗값)')
    if seeds['split'] == seeds['draw']:
        raise K6InputError('seeds의 split과 draw는 달라야 한다')
    if not reg['conversion_rule'] or not isinstance(reg['conversion_rule'], str) or isinstance(reg['tune_n'], bool) or not isinstance(reg['tune_n'], int) or reg['tune_n'] < 1:
        raise K6InputError('conversion_rule 또는 tune_n이 규칙 밖이다')
    m = reg['max_missing_ratio']
    if isinstance(m, bool) or not isinstance(m, (int, float)) or not 0 <= m <= K6_MAX_MISSING_RATIO_LIMIT:
        raise K6InputError(f'max_missing_ratio는 0과 {K6_MAX_MISSING_RATIO_LIMIT} 사이다')
    required_time(reg['registered_at'], 'registered_at')
    return reg, behavior_rule(reg['behavior_rule'], reg['source']), registration_hash(reg)


def k6_registration(path, source, plan, start=None):
    """--k6-registration을 읽고 명령줄과 맞는지 본다. 어긋나면 K6InputError로 실행을 거부한다(ADR-0174 결정 2·6, ADR-0246)."""
    reg, rule, reg_hash = k6_load_registration(path)
    if reg['source'] != source:
        raise K6InputError(f'사전 등록의 원천 {reg["source"]}이 --k6-source {source}와 다르다')
    p = reg['plan']
    if not isinstance(p, dict) or set(p) != {'n', 'c'} or (p['n'], p['c']) != (plan['holdout_n'], plan['max_fp']):
        raise K6InputError(f'사전 등록의 계획이 --k6-plan {plan["holdout_n"]}:{plan["max_fp"]}과 다르다')
    if start is not None and required_time(reg['registered_at'], 'registered_at') > required_time(start, '--start'):
        raise K6InputError('사전 등록 시각(registered_at)이 측정 시작(--start)보다 늦다')
    return reg, rule, reg_hash


def public_registration(reg, rule):
    """저장소에 커밋해 고정하는 공개 등록 파일의 내용. 기준값·가중치·최대 위험 값과 소금은 넣지 않는다(ADR-0246)."""
    return {'id': reg['id'], 'source': reg['source'], 'registered_at': reg['registered_at'], 'plan': reg['plan'], 'dataset': reg['dataset'],
            'seeds': reg['seeds'], 'conversion_rule': reg['conversion_rule'], 'tune_n': reg['tune_n'], 'strength': rule['strength'],
            'sort_mode': rule['sort_mode'], 'criterion_ratio': rule['criterion_ratio'], 'unmeasurable': rule['unmeasurable'],
            'max_missing_ratio': reg['max_missing_ratio'], 'tool_commit': reg['tool_commit'], 'registration_hash': registration_hash(reg)}


def k6_plan_fields(reg, rule, reg_hash):
    """manifest k6_plan에 더할 칸. 기준값·기여·가중치·최대 위험 값과 소금은 넣지 않는다(ADR-0246)."""
    return {'source': reg['source'], 'label': K6_SOURCE_LABELS[reg['source']], 'registration_id': reg['id'], 'dataset': reg['dataset'],
            'split_seed': reg['seeds'], 'conversion_rule': reg['conversion_rule'], 'tune_n': reg['tune_n'], 'max_missing_ratio': reg['max_missing_ratio'],
            'behavior_only_rule': {k: rule[k] for k in ('strength', 'sort_mode', 'criterion_ratio', 'unmeasurable')},
            'registered_at': reg['registered_at'], 'registration_hash': reg_hash, 'tool_commit': reg['tool_commit']}


def _git(root, args):
    try:
        out = subprocess.run(['git', '-C', root, *args], capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.decode('utf-8', 'replace') if out.returncode == 0 else None


def k6_check_registration_commit(root, reg, reg_hash, start):
    """공개 등록 파일이 측정 시작 전에 커밋돼 그 뒤 바뀌지 않았는지 git log로 본다(public만, ADR-0246)."""
    rel = f'{K6_REGISTRATIONS_DIR}/{reg["id"]}.json'
    if not os.path.exists(os.path.join(root, *rel.split('/'))):
        raise K6InputError(f'공개 등록 파일이 없다: {rel}(human_data.py publish-registration으로 쓰고 측정 전에 커밋한다)')
    log = _git(root, ['log', '--format=%H %ct', '--', rel])
    commits = [ln.split() for ln in (log or '').splitlines() if ln.strip()]
    if not commits:
        raise K6InputError(f'공개 등록 파일이 커밋되지 않았다: {rel}')
    if len(commits) > 1:
        raise K6InputError(f'공개 등록 파일이 첫 커밋 뒤 바뀌었다: {rel}')
    sha, when = commits[0]
    if int(when) >= required_time(start, '--start'):
        raise K6InputError(f'공개 등록 파일의 첫 커밋이 측정 시작(--start)보다 앞서지 않는다: {rel}')
    try:
        fixed = json.loads(_git(root, ['show', f'{sha}:{rel}']) or '')
    except ValueError:
        raise K6InputError(f'공개 등록 파일을 읽지 못했다: {rel}')
    if not isinstance(fixed, dict) or fixed.get('registration_hash') != reg_hash:
        raise K6InputError('비공개 등록 파일의 해시가 공개 등록 파일의 등록 해시와 다르다(등록 뒤 고쳤다)')


def k6_prior_runs(root, reg, run_id):
    """같은 자료(해시와 변환 규칙)의 이전 public 측정. 씨앗값·강도·정렬 방식을 바꿔도 같은 자료면 이전 측정이다(ADR-0246 결정 2).

    --force로 덮는 같은 run id는 뺀다. 항목에 씨앗값·강도·정렬 방식·판정을 함께 적어 장부 표에 보인다.
    """
    runs = os.path.join(root, RUNS)
    found = []
    for name in sorted(os.listdir(runs)) if os.path.isdir(runs) else []:
        path = os.path.join(runs, name, 'manifest.json')
        if name == run_id or not os.path.exists(path):
            continue
        try:
            manifest = load_json(path) or {}
        except ValueError:
            continue
        plan = manifest.get('k6_plan') or {}
        if plan.get('source') == 'public' and (plan.get('dataset') or {}).get('sha256') == reg['dataset']['sha256'] \
                and plan.get('conversion_rule') == reg['conversion_rule']:
            behavior = plan.get('behavior_only_rule') or {}
            found.append({'run_id': name, 'split_seed': plan.get('split_seed'), 'strength': behavior.get('strength'),
                          'sort_mode': behavior.get('sort_mode'), 'plan_verdict': (manifest.get('k6_eval') or {}).get('plan_verdict')})
    return found


def k6_verify_receipt(reg_path, reg_hash, required):
    """verify가 비공개 등록 파일 옆에 남긴 결과를 읽어 manifest에 적을 칸을 돌려준다. public은 원본까지 맞춘 성공 결과가 있어야 한다(ADR-0246 결정 3)."""
    path = os.path.join(os.path.dirname(os.path.abspath(reg_path)), K6_VERIFY_RESULT)
    if not os.path.exists(path):
        if required:
            raise K6InputError('verify를 돌린 결과가 없다(human_data.py verify --source-file로 원본에서 다시 계산한다)')
        return {'ran': False, 'result': None, 'source_file_checked': False, 'verified_at': None}
    try:
        doc = load_json_strict(path)
    except (OSError, ValueError) as e:
        raise K6InputError(f'verify 결과를 읽지 못했다: {e}')
    if not isinstance(doc, dict) or set(doc) != _VERIFY_KEYS:
        raise K6InputError('verify 결과의 칸이 규칙 밖이다')
    if doc['registration_hash'] != reg_hash:
        if required:
            raise K6InputError('verify 결과가 이 등록의 것이 아니다(등록 뒤 verify를 다시 돌린다)')
        return {'ran': False, 'result': None, 'source_file_checked': False, 'verified_at': None}
    if required and doc['result'] != 'ok':
        raise K6InputError('verify 결과가 실패다')
    if required and doc['source_file_checked'] is not True:
        raise K6InputError('verify가 원본(--source-file)까지 맞추지 않았다')
    return {'ran': True, 'result': doc['result'], 'source_file_checked': doc['source_file_checked'], 'verified_at': doc['verified_at']}


def k6_dataset_pin(root, reg, override=None):
    """저장소의 자료 고정 파일과 등록한 자료 해시를 견준다. 고정값은 첫 실제 측정 때 소유자 허락을 받아 넣는다(ADR-0246)."""
    out = {'path': 'override' if override else K6_DATASET_PINS, 'overridden': bool(override), 'test_env': os.environ.get(K6_TEST_PIN_ENV) == '1',
           'file_sha256': None, 'status': 'not_pinned'}
    path = override or os.path.join(root, *K6_DATASET_PINS.split('/'))
    exists = os.path.exists(path)
    if override:
        if not exists:
            return out
        with io.open(path, encoding='utf-8') as f:
            text = f.read()
    else:
        # 기본 고정 파일은 HEAD에서 읽는다. 작업 트리만 고쳐 합격을 낼 수 없게 한다(줄바꿈 차이는 보지 않는다)
        text = _git(root, ['show', f'HEAD:{K6_DATASET_PINS}'])
        if text is None and not exists:
            return out
        with io.open(path, encoding='utf-8', newline='') if exists else io.StringIO('') as f:
            working = f.read()
        if text is None or not exists or text.replace('\r\n', '\n') != working.replace('\r\n', '\n'):
            raise K6InputError(f'자료 고정 파일이 HEAD와 다르다({K6_DATASET_PINS}). 고친 값은 커밋한 뒤 쓴다')
    out['file_sha256'] = hashlib.sha256(text.encode('utf-8')).hexdigest()
    try:
        pins = json.loads(text, parse_constant=_no_constant)
    except ValueError as e:
        raise K6InputError(f'자료 고정 파일을 읽지 못했다: {e}')
    datasets = pins.get('datasets') if isinstance(pins, dict) else None
    entry = datasets.get(reg['dataset']['name']) if isinstance(datasets, dict) else None
    if not isinstance(entry, dict) or not entry.get('sha256') or not entry.get('readme_sha256'):
        return out
    same = entry['sha256'] == reg['dataset']['sha256'] and entry['readme_sha256'] == reg['dataset']['readme_sha256']
    out['status'] = 'matched' if same else 'mismatch'
    return out


def k6_apply_source(ev, reg, rule, units, pin):
    """원천 칸과 원천별 판정을 k6_eval에 적는다.

    mock은 REHEARSAL. public은 측정 무의미 사유(최대 기여 미달, 값 없음 비율 초과, 자료 고정값 없음·다름)가 있으면 UNMEASURABLE이고 오탐을 세지 않는다.
    강도가 기본이 아니면 SENSITIVITY로만 적고 합격으로 적지 않는다.
    """
    source = reg['source']
    ev.update({'human_source': source, 'human_label': K6_SOURCE_LABELS[source], 'dataset': reg['dataset'], 'split_seed': reg['seeds']})
    bo, hu = units['behavior_only'], units['human_units']
    reasons = ['ceiling'] if rule['unmeasurable'] else []
    if bo['missing_ratio'] is not None and bo['missing_ratio'] > reg['max_missing_ratio']:
        reasons.append('missing_values')
    if bo['judged'] == bo['missing']:   # 값 있는 판정 기록이 없으면 비율과 무관하게 잴 수 없다
        reasons.append('no_values')
    if pin and pin['overridden'] and not pin['test_env']:
        reasons.append('dataset_pin_overridden')   # 인자로 바꾼 고정 파일로는 합격을 낼 수 없다
    elif pin and pin['status'] != 'matched':
        reasons.append('dataset_not_pinned' if pin['status'] == 'not_pinned' else 'dataset_pin_mismatch')
    bo['unmeasurable'], bo['unmeasurable_reasons'] = bool(reasons), reasons
    if source == 'mock':
        ev['plan_verdict'] = 'REHEARSAL'
        for h in ev['humans']:
            h['meets_target'] = None
    elif reasons:
        ev['plan_verdict'] = 'UNMEASURABLE'
        ev['humans'], ev['human_strata'] = [], []
        bo['false_pos'], hu['judge_false_pos'], hu['ref_false_pos'] = None, None, None
        units['judged_fp_refs'], units['ref_strata'] = None, []
    elif rule['strength'] != K6_JUDGED_STRENGTH:
        ev['sensitivity_result'], ev['plan_verdict'] = ev['plan_verdict'], 'SENSITIVITY'
        for h in ev['humans']:
            h['meets_target'] = None


def k6_launch_detection(path, ev):
    """출시 첫 판(BehaviorScore 적용 가중치 0)의 혼동 행렬 → 등급·라운드별 탐지율. 합격 판정은 원래 가중치 판이 하므로 합격 칸을 두지 않는다(ADR-0174 결정 5)."""
    rows = k6_eval_from_confusion(path)['bots']
    main = {(b['tier'], b['round']): b['n'] for b in (ev or {}).get('bots', [])}
    launch = {(b['tier'], b['round']): b['n'] for b in rows}
    if main != launch:
        raise K6InputError('출시 첫 판의 등급·라운드별 봇 세션 수가 confusion.csv와 다르다(같은 합성 봇으로 잰다)')
    return [{k: v for k, v in b.items() if k != 'meets_target'} for b in rows]


FP_REVIEW_COLUMNS = ('batch', 'sampled', 'human', 'bot', 'unsure', 'population')
K6_REVIEW_MIN_SAMPLE = 200    # 묶음마다 최소 표본 [가정, ADR-0174 결정 3]
_ALPHA_BONFERRONI = 0.025     # 두 구간을 각각 단측 97.5%로 잡는다(본페로니 보정: 둘이 함께 맞을 확률이 95% 이상이 되게 나눠 잡는 방법)


def k6_live_fp(path, r2_deadline):
    """fp_review.csv(batch,sampled,human,bot,unsure,population) → 출시 뒤 실제 사람 기준 오탐 상한(docs/perf-ledger.md §10.6).

    둘째 묶음(shadow_challenge)의 판단 불가는 사람으로, 첫째 묶음(pass)의 판단 불가는 사람 아님으로 센다(오탐을 크게 보는 쪽).
    분자 = 둘째 묶음 전체 × 사람 비율 상한, 분모 = 첫째 묶음 전체 × 사람 비율 하한. 전수 검토인 묶음은 구간 없이 그 비율을 쓴다.
    """
    rows = _read_rows(path, FP_REVIEW_COLUMNS, 'fp_review.csv', optional=())
    problems, batches = [], {}
    for i, r in enumerate(rows, 2):
        name = (r.get('batch') or '').strip()
        if name not in ('pass', 'shadow_challenge') or name in batches:
            problems.append(f'{i}행: batch는 pass·shadow_challenge가 한 줄씩이다')
            continue
        try:
            vals = {c: int(r.get(c) or '') for c in FP_REVIEW_COLUMNS[1:]}
        except ValueError:
            problems.append(f'{i}행: 숫자가 아닌 칸이 있다')
            continue
        if min(vals.values()) < 0:
            problems.append(f'{i}행: 음수가 있다')
        batches[name] = vals
    for name in ('pass', 'shadow_challenge'):
        b = batches.get(name)
        if b is None:
            problems.append(f'{name} 묶음이 없다')
            continue
        if b['sampled'] > b['population']:
            problems.append(f'{name}: sampled({b["sampled"]}) > population({b["population"]})')
        if b['sampled'] < min(K6_REVIEW_MIN_SAMPLE, b['population']):
            problems.append(f'{name}: sampled({b["sampled"]})가 {K6_REVIEW_MIN_SAMPLE}건과 그 묶음 전체 가운데 작은 값보다 적다')
        if b['human'] + b['bot'] + b['unsure'] != b['sampled']:
            problems.append(f'{name}: human + bot + unsure가 sampled({b["sampled"]})와 다르다')
    if not problems and batches['pass']['population'] == 0:
        problems.append('pass 묶음 전체(population)가 0이라 분모가 없다')
    if problems:
        raise K6InputError('; '.join(problems))
    p, c = batches['pass'], batches['shadow_challenge']
    p_census, c_census = p['sampled'] == p['population'], c['sampled'] == c['population']
    c_humans = c['human'] + c['unsure']
    upper = (c_humans / c['sampled'] if c['sampled'] else 0.0) if c_census else cp_upper(c_humans, c['sampled'], _ALPHA_BONFERRONI)
    lower = (p['human'] / p['sampled']) if p_census else cp_lower(p['human'], p['sampled'], _ALPHA_BONFERRONI)
    numerator, denominator = c['population'] * upper, p['population'] * lower
    fp = min(1.0, numerator / denominator) if denominator else None
    return {'batches': {'pass': dict(p, census=p_census, human_rate_lower=round(lower, 6)),
                        'shadow_challenge': dict(c, census=c_census, human_rate_upper=round(upper, 6))},
            'numerator_upper': round(numerator, 4), 'denominator_lower': round(denominator, 4),
            'fp_upper95_one_sided': None if fp is None else round(fp, 8), 'target': K6_TARGET_FP_UPPER,
            'meets_target': fp is not None and fp <= K6_TARGET_FP_UPPER, 'r2_deadline': r2_deadline}


def _finite(text):
    value = float(text)
    if not math.isfinite(value):
        raise ValueError(text)
    return value


def k6_human_units(path, ev, plan, source, rule, reg):
    """human_sessions.csv(source,person,role,stratum,round,predicted,score[,behavior_score])로 사람 단위를 확인하고 집계한다(ADR-0112·0174·0245).

    확인(하나라도 어긋나면 K6InputError로 실행을 거부한다):
      ① 모든 행의 원천이 --k6-source와 같다(live는 이 파일을 쓰지 않는다). ② 모르는 칸·머리글보다 많은 칸이 없다(입력한 글자 칸 거부).
      ③ 사람마다 판정 기록(role=judge)이 꼭 하나다. ④ 판정 기록 수가 --k6-plan의 N과 같다.
      ⑤ 판정 기록 수와 그 오탐 수가 confusion.csv의 마지막 라운드 사람 합계(n, 오탐)와 같다.
      ⑥ public은 predicted가 사전 등록 기준과 맞고 사람 행이 한 라운드뿐이다. ⑦ 판정 사람 목록이 등록한 목록과 같다.
    score가 빈 public 행과 behavior_score가 빈 mock 행은 '값 없음'이다. 0으로 바꾸지 않고 따로 센다.
    집계(사람 코드는 내보내지 않는다): human_units, sessions_per_person, human_icc(기록 2개 이상인 사람의 점수로 낸 ICC(1)과 단측 95% 상한),
      ref_strata, judged_fp_refs, behavior_only(값 없음 수와 위험 값 50·90·99 백분위. 기준값은 적지 않는다).
    stratum은 한 기록이 여러 층에 속하면 ';'로 나눠 적는다.
    """
    rows = _read_rows(path, HUMAN_SESSION_COLUMNS, 'human_sessions.csv', optional=HUMAN_SESSION_OPTIONAL)
    problems, people = [], {}
    wrong_source = off_rule = 0
    for i, r in enumerate(rows, 2):
        if (r.get('source') or '').strip() != source:
            wrong_source += 1
            continue
        code = (r.get('person') or '').strip()
        role = (r.get('role') or '').strip().lower()
        pred = (r.get('predicted') or '').strip().lower()
        score = (r.get('score') or '').strip()
        behavior = (r.get('behavior_score') or '').strip()
        if not code or role not in ('judge', 'ref') or pred not in ('bot', 'human'):
            problems.append(f'{i}행: person이 비었거나 role(judge·ref)·predicted(bot·human)가 규칙 밖이다')
            continue
        try:
            val = _finite(score) if score else None
            bval = _finite(behavior) if behavior else None
            rnd = int(float(r.get('round') or 1))
        except (ValueError, OverflowError):
            problems.append(f'{i}행: score·behavior_score·round가 숫자가 아니다')
            continue
        if source == 'public':
            if bval is not None:
                problems.append(f'{i}행: public에는 behavior_score를 쓰지 않는다(score가 그 값이다)')
            if (pred == 'bot') != (val is not None and val >= rule['criterion']):
                off_rule += 1
        strata = [s.strip() for s in (r.get('stratum') or '').split(';') if s.strip()]
        people.setdefault(code, []).append({'role': role, 'fp': pred == 'bot', 'score': val, 'behavior': val if source == 'public' else bval,
                                            'round': rnd, 'strata': strata})
    if wrong_source:
        problems.append(f'원천 칸이 --k6-source {source}와 다른 행이 {wrong_source}개다(원천 칸은 public·mock만 받는다)')
    if off_rule:
        problems.append(f'predicted가 사전 등록한 기준과 어긋난 행이 {off_rule}개다')
    judges = {p: sum(1 for s in ss if s['role'] == 'judge') for p, ss in people.items()}
    many = [p for p, c in judges.items() if c > 1]
    none = [p for p, c in judges.items() if c == 0]
    if many:
        problems.append(f'판정 기록이 둘 이상인 사람 {len(many)}명({_examples(many)})')
    if none:
        problems.append(f'판정 기록이 없는 사람 {len(none)}명({_examples(none)})')
    n_judge = sum(judges.values())
    judge_fp = sum(1 for ss in people.values() for s in ss if s['role'] == 'judge' and s['fp'])
    if not plan:
        problems.append('--k6-plan N:C가 없어 판정 기록 수를 확인할 수 없다')
    elif n_judge != plan['holdout_n']:
        problems.append(f'판정 기록 {n_judge}개가 사전 등록한 N={plan["holdout_n"]}과 다르다')
    if people_hash(reg['salt'], [p for p, c in judges.items() if c]) != reg['judge_people_sha256']:
        problems.append('판정 사람 목록이 사전 등록한 목록과 다르다')
    humans = (ev or {}).get('humans') or []
    if not humans:
        problems.append('confusion.csv에 사람 합계 행(stratum이 빈 사람 행)이 없다')
    else:
        h = humans[-1]
        if (n_judge, judge_fp) != (h['n'], h['false_pos']):
            problems.append(f'판정 기록 {n_judge}개·오탐 {judge_fp}건이 confusion.csv 라운드 {h["round"]} 사람 합계 '
                            f'{h["n"]}개·오탐 {h["false_pos"]}건과 다르다')
    if source == 'public':
        file_rounds = {s['round'] for ss in people.values() for s in ss}
        conf_rounds = {h['round'] for h in humans} | {s['round'] for s in (ev or {}).get('human_strata', [])}
        if len(file_rounds) > 1 or len(conf_rounds) > 1 or file_rounds != conf_rounds:
            problems.append('public은 사람 행을 한 라운드만 받는다(human_sessions.csv와 confusion.csv가 같은 라운드 하나여야 한다)')
    if problems:
        raise K6InputError('; '.join(problems))
    refs = [s for ss in people.values() for s in ss if s['role'] == 'ref']
    per_person = {}
    for ss in people.values():
        per_person[len(ss)] = per_person.get(len(ss), 0) + 1
    strata = {}
    for s in refs:
        for name in s['strata']:
            c = strata.setdefault((s['round'], name), [0, 0])
            c[0] += 1
            c[1] += s['fp']
    fp_people = [ss for ss in people.values() if any(s['role'] == 'judge' and s['fp'] for s in ss)]
    fp_refs = [s for ss in fp_people for s in ss if s['role'] == 'ref']
    icc = icc1([[s['score'] for s in ss if s['score'] is not None] for ss in people.values()])
    if icc:
        icc['upper95_one_sided'] = icc.pop('upper_one_sided')
    contributions = [s['behavior'] for ss in people.values() for s in ss if s['role'] == 'judge' and s['behavior'] is not None]
    missing = n_judge - len(contributions)
    risks = [v / rule['weight'] for v in contributions] if rule['weight'] else []
    behavior_only = {'strength': rule['strength'], 'sort_mode': rule['sort_mode'], 'criterion_ratio': rule['criterion_ratio'],
                     'unmeasurable': rule['unmeasurable'], 'unmeasurable_reasons': [], 'judged': n_judge, 'missing': missing,
                     'missing_ratio': round(missing / n_judge, 6) if n_judge else None, 'max_missing_ratio': reg['max_missing_ratio'],
                     'false_pos': sum(1 for v in contributions if v >= rule['criterion']),
                     'risk_percentiles': {name: round(percentile(risks, q), 6) if risks else None for name, q in (('p50', 0.5), ('p90', 0.9), ('p99', 0.99))},
                     'pointer': K6_POINTER_UNMEASURED if source == 'public' else None}
    return {
        'human_units': {'people': len(people), 'judge_records': n_judge, 'ref_records': len(refs),
                        'judge_false_pos': judge_fp, 'ref_false_pos': sum(s['fp'] for s in refs),
                        'checks': {'one_judge_per_person': True, 'judge_records_equal_plan_n': True,
                                   'matches_confusion_last_round': True, 'judge_people_match_registration': True},
                        'source_copied': False},
        'sessions_per_person': {str(k): per_person[k] for k in sorted(per_person)},
        'human_icc': icc,
        'ref_strata': [{'round': rnd, 'stratum': name, 'n': n, 'false_pos': k} for (rnd, name), (n, k) in sorted(strata.items())],
        'judged_fp_refs': {'people': len(fp_people), 'ref_records': len(fp_refs), 'ref_false_pos': sum(s['fp'] for s in fp_refs)},
        'behavior_only': behavior_only,
    }


BOT_OUTCOME_COLUMNS = ('tier', 'round', 'solve_rate', 'sessions', 'detected', 'blocked', 'verify_passed', 'admitted')
K6_SCENARIO_BOTS = 500000     # docs/planning/01 §3.2 표준 시나리오: 진입 시도 100만 건 중 봇 50만
K6_SCENARIO_HUMANS = 500000   # 정상 이용자 50만. 오탐 0.5%를 빼면 49.75만이 통과한다


def k6_bot_outcomes(path, ev):
    """bot_outcomes.csv(tier,round,solve_rate,sessions,detected,blocked,verify_passed,admitted) → 추가 검증 통과율,
    끝에서 끝까지의 봇 성공률, 봇 점유율 추정(docs/perf-ledger.md §10.2·§10.5, 기술 검토 중간-104).

    확인(어긋나면 K6InputError로 실행을 거부한다): 같은 등급·라운드에서 풀이 성공률별 detected 합 = confusion.csv의 봇 판정 수,
    blocked + verify_passed ≤ detected, admitted ≤ sessions. 같은 등급·라운드·풀이 성공률 행이 여럿이면 더한다.
    verify_pass = verify_passed ÷ detected, e2e_success = admitted ÷ sessions(둘 다 Wilson 95% 구간).
    bot_share_est: 마지막 라운드 1·2단계 등급을 합친 탐지율 d와, 같은 등급을 합친 풀이 성공률별 통과율 r로
      통과 봇 = 50만 × (1 − d) + 50만 × d × r, 봇 점유율 = 통과 봇 ÷ (통과 봇 + 49.75만)(docs/planning/01 §3.2).
    """
    rows = _read_rows(path, BOT_OUTCOME_COLUMNS, 'bot_outcomes.csv')
    agg, problems = {}, []
    for i, r in enumerate(rows, 2):
        try:
            key = ((r.get('tier') or '').strip(), int(float(r.get('round') or 1)), float(r.get('solve_rate') or 0))
            vals = [int(float(r.get(c) or 0)) for c in BOT_OUTCOME_COLUMNS[3:]]
        except ValueError:
            problems.append(f'{i}행: 숫자가 아닌 칸이 있다')
            continue
        if min(vals) < 0:
            problems.append(f'{i}행: 음수가 있다')
        a = agg.setdefault(key, [0, 0, 0, 0, 0])
        for j, v in enumerate(vals):
            a[j] += v
    conf = {(b['tier'], b['round']): b['detected'] for b in (ev or {}).get('bots', [])}
    det = {}
    for (tier, rnd, s), (sess, d, blk, vp, adm) in sorted(agg.items()):
        det[(tier, rnd)] = det.get((tier, rnd), 0) + d
        if blk + vp > d:
            problems.append(f'{tier} 라운드 {rnd} 풀이 {s:g}: blocked + verify_passed({blk + vp}) > detected({d})')
        if adm > sess:
            problems.append(f'{tier} 라운드 {rnd} 풀이 {s:g}: admitted({adm}) > sessions({sess})')
    for key in sorted(set(det) | set(conf)):
        if det.get(key, 0) != conf.get(key, 0):
            problems.append(f'{key[0]} 라운드 {key[1]}: detected 합 {det.get(key, 0)}이 confusion.csv 봇 판정 수 {conf.get(key, 0)}와 다르다')
    if problems:
        raise K6InputError('; '.join(problems))

    def interval(k, n):
        w = wilson(k, n)
        return None if w is None else [round(w[0], 5), round(w[1], 5)]

    out = {'verify_pass': [], 'e2e_success': [], 'bot_share_est': None}
    order = sorted(agg.items(), key=lambda x: (x[0][1], x[0][0], x[0][2]))
    for (tier, rnd, s), (sess, d, blk, vp, adm) in order:
        base = {'tier': tier, 'level': tier_level(tier), 'round': rnd, 'solve_rate': s}
        out['verify_pass'].append(dict(base, detected=d, blocked=blk, verify_passed=vp,
                                       rate=round(vp / d, 5) if d else None, wilson95=interval(vp, d)))
        out['e2e_success'].append(dict(base, sessions=sess, admitted=adm,
                                       rate=round(adm / sess, 5) if sess else None, wilson95=interval(adm, sess)))
    bots = [b for b in (ev or {}).get('bots', []) if b.get('level') in (1, 2)]
    if bots:
        last = max(b['round'] for b in (ev or {}).get('bots', []))
        scored = [b for b in bots if b['round'] == last]
        n, k = sum(b['n'] for b in scored), sum(b['detected'] for b in scored)
        if n:
            d_rate = k / n
            humans_passing = round(K6_SCENARIO_HUMANS * (1 - K6_TARGET_FP_UPPER))
            keys = {(b['tier'], b['round']) for b in scored}
            per_rate = []
            for s in sorted({key[2] for key in agg if (key[0], key[1]) in keys}):
                dd = sum(v[1] for key, v in agg.items() if (key[0], key[1]) in keys and key[2] == s)
                vv = sum(v[3] for key, v in agg.items() if (key[0], key[1]) in keys and key[2] == s)
                r_rate = vv / dd if dd else 0.0
                passing = K6_SCENARIO_BOTS * (1 - d_rate) + K6_SCENARIO_BOTS * d_rate * r_rate
                per_rate.append({'solve_rate': s, 'verify_pass': round(r_rate, 5),
                                 'bot_share': round(passing / (passing + humans_passing), 5)})
            out['bot_share_est'] = {'round': last, 'tiers': sorted(t for t, _ in keys), 'detection_rate': round(d_rate, 5),
                                    'scenario': {'bots': K6_SCENARIO_BOTS, 'humans_passing': humans_passing},
                                    'by_solve_rate': per_rate}
    return out


def bot_share_note(est):
    """manifest notes에 붙일 봇 점유율 추정 한 줄(docs/perf-ledger.md §10.2)."""
    if not est or not est.get('by_solve_rate'):
        return None
    parts = ', '.join('풀이 %g%% %.2f%%' % (x['solve_rate'] * 100, x['bot_share'] * 100) for x in est['by_solve_rate'])
    return '봇 점유율 추정(docs/planning/01 §3.2, 라운드 %d 1·2단계 탐지율 %.1f%%): %s' % (est['round'], est['detection_rate'] * 100, parts)


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
    label = K6_SOURCE_LABELS.get((ev or {}).get('human_source'))
    tag = f'{label} ' if label else ''
    if ev and ev.get('humans'):
        h = ev['humans'][-1]
        s = tag + '오탐 %d/%d명, 상한 %.2f%%' % (h['false_pos'], h['n'], h['upper95_one_sided'] * 100)
        if ev.get('plan_verdict'):
            s += ', 계획 ' + {'PASS': '통과', 'FAIL': '실패', 'INSUFFICIENT': '판정 보류', 'REHEARSAL': '리허설', 'SENSITIVITY': '민감도'}[ev['plan_verdict']]
        parts.append(s)
    bo = (ev or {}).get('behavior_only') or {}
    if ev and ev.get('plan_verdict') == 'UNMEASURABLE':
        reasons = '·'.join(K6_UNMEASURABLE_TEXT[r] for r in bo.get('unmeasurable_reasons', []))
        parts.append(tag + f'측정 무의미({reasons or "사유 없음"})')
    if bo.get('strength'):
        parts.append(f'강도 {bo["strength"]}·정렬 {bo["sort_mode"]}')
    plan = (ev or {}).get('plan') or {}
    if plan.get('remeasure'):
        parts.append('재측정')
    if plan.get('sensitivity_before'):
        parts.append('민감도 선행')
    if plan.get('prior_runs'):
        parts.append('이전 측정 ' + ', '.join('%s(%s·%s·씨앗 %s/%s)' % (p['run_id'], p['strength'], p['sort_mode'], (p['split_seed'] or {}).get('split'), (p['split_seed'] or {}).get('draw'))
                                               for p in plan['prior_runs']))
    if (plan.get('dataset_pin') or {}).get('test_env'):
        parts.append('시험용 자료 고정')
    live = (ev or {}).get('live_fp')
    if live and live.get('fp_upper95_one_sided') is not None:
        parts.append(tag + '오탐 상한 %.2f%%' % (live['fp_upper95_one_sided'] * 100))
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
