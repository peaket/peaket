"""PEAKET 문서 점검: ID 참조, 표, 펜스, 경로, REST 경로 규칙, 절 번호 참조, 작업 흔적, 마커, WBS 일치, 기획 버전.

사용법: python tools/doc-check/check_all.py [--strict] [--json] [--coverage] [--markers-out FILE]
종료 코드: 0 = 오류 없음, 1 = 오류 있음(--strict면 경고도 오류로 봄), 2 = 실행 실패.
표준 라이브러리만 쓴다(Python 3.10 이상). 규칙과 예외는 tools/doc-check/README.md.
"""
import argparse
import collections
import csv
import io
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCAN_EXT = ('.md', '.yaml', '.json', '.csv')
SKIP_DIRS = {'archive', 'tools', '.git', 'node_modules'}
ID_KINDS = ('FR', 'NFR', 'POL', 'SCR', 'CMP', 'ADR')
MARKERS = ('[가정', '[충돌', '[보완')
# 존재하지 않아도 되는 경로: 외부 URL 안의 경로 문자열이라 오탐(review R-10),
# 없앤 문서인데 고치지 않는 지난 기록(ADR 본문, review의 지난 행)이 가리키는 경로(ADR-0090, review R-105)
ALLOW_PATHS = {'docs/software-architecture.md', 'docs/arc42.md'}


class Report:
    def __init__(self):
        self.errors = []
        self.warnings = []
        self.info = collections.OrderedDict()

    def err(self, check, where, msg):
        self.errors.append({'check': check, 'where': where, 'msg': msg})

    def warn(self, check, where, msg):
        self.warnings.append({'check': check, 'where': where, 'msg': msg})


def rel(p):
    return os.path.relpath(p, ROOT).replace(os.sep, '/')


def load_files():
    texts = collections.OrderedDict()
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = sorted(d for d in dn if d not in SKIP_DIRS and not d.startswith('.'))
        for f in sorted(fn):
            if f.endswith(SCAN_EXT):
                p = os.path.join(dp, f)
                with io.open(p, encoding='utf-8') as fh:
                    texts[rel(p)] = fh.read()
    return texts


def strip_fences(text):
    """펜스 블록 안의 줄을 빈 줄로 바꾼 사본(줄 번호 유지)."""
    out, inside, marker = [], False, None
    for line in text.split('\n'):
        s = line.strip()
        if not inside and (s.startswith('```') or s.startswith('~~~')):
            inside, marker = True, s[:3]
            out.append('')
            continue
        if inside and s.startswith(marker):
            inside = False
            out.append('')
            continue
        out.append('' if inside else line)
    return out


# ---------- 1. ID 정의와 참조 ----------
def check_ids(texts, rep):
    t = texts
    need = ['planning/02-requirements.md', 'planning/03-policies-glossary.md', 'planning/04-ia-flows-screens.md', 'design/d2-design-system.md']
    for n in need:
        if n not in t:
            rep.err('ids', n, '정의 파일 없음')
            return {}
    defs = {
        'FR': re.findall(r'^\| (FR-\d{3}) \|', t[need[0]], re.M),
        'NFR': re.findall(r'^\| (NFR-\d{3}) \|', t[need[0]], re.M),
        'POL': re.findall(r'^\| (POL-\d{3}) \|', t[need[1]], re.M),
        'SCR': re.findall(r'^\| (SCR-\d{3}) \|', t[need[2]], re.M),
        'CMP': re.findall(r'^\| (CMP-\d{3}) \|', t[need[3]], re.M),
    }
    adr_dir = os.path.join(ROOT, 'docs', 'adr')
    defs['ADR'] = ['ADR-' + f[:4] for f in sorted(os.listdir(adr_dir)) if re.match(r'\d{4}-.*\.md$', f)]
    sets = {}
    for k, v in defs.items():
        dup = [x for x, c in collections.Counter(v).items() if c > 1]
        for d in dup:
            rep.err('ids', k, '중복 정의 %s' % d)
        sets[k] = set(v)
    ref_re = re.compile(r'\b(FR|NFR|POL|SCR|CMP)-(\d{3})\b|\b(ADR)-(\d{4})\b')
    for f, text in t.items():
        for n, line in enumerate(text.split('\n'), 1):
            for m in ref_re.finditer(line):
                tok = m.group(0)
                if tok not in sets[tok.split('-')[0]]:
                    rep.err('ids', '%s:%d' % (f, n), '정의 없는 ID %s' % tok)
    rep.info['ids'] = {k: len(sets[k]) for k in ID_KINDS}
    return sets


# ---------- 2. 표 열 수, 3. 펜스 ----------
def check_tables_fences(texts, rep):
    for f, text in texts.items():
        if not f.endswith('.md'):
            continue
        fences = sum(1 for l in text.split('\n') if l.strip().startswith(('```', '~~~')))
        if fences % 2:
            rep.err('fences', f, '펜스 수가 홀수(%d)' % fences)
        lines = strip_fences(text)
        i = 0
        while i < len(lines):
            if lines[i].startswith('|'):
                j, counts = i, []
                while j < len(lines) and lines[j].startswith('|'):
                    row = re.sub(r'`[^`]*`', '', lines[j]).replace('\\|', '')
                    counts.append(row.count('|'))
                    j += 1
                if len(set(counts)) > 1:
                    rep.err('tables', '%s:%d' % (f, i + 1), '행마다 열 수가 다름 %s' % counts)
                i = j
            else:
                i += 1


# ---------- 4. 파일 경로 ----------
def check_paths(texts, rep):
    path_re = re.compile(r'(?<![\w/.-])((?:docs|planning|design|review|wbs|runbooks|tools)/[\w\-/.]+\.(?:md|yaml|json|csv|py))')
    for f, text in texts.items():
        for n, line in enumerate(text.split('\n'), 1):
            for m in path_re.finditer(line):
                p = m.group(1)
                if os.path.exists(os.path.join(ROOT, p)) or p in ALLOW_PATHS:
                    continue
                if '예정' in line:
                    rep.warn('paths', '%s:%d' % (f, n), '예정 문서 %s' % p)
                else:
                    rep.err('paths', '%s:%d' % (f, n), '없는 경로 %s' % p)


# ---------- 4의2. REST 경로 규칙과 문서의 경로 참조(docs/api/guidelines.md §10, ADR-0081) ----------
API_NAMESPACES = {'partner', 'ops', 'scanner', 'identity', 'shop', 'auth', 'compliance', 'webhooks'}
API_VERBS = {'get', 'create', 'update', 'delete', 'approve', 'reject', 'accept', 'withdraw', 'extend', 'revert', 'resend',
             'confirm', 'complete', 'pause', 'resume', 'revoke', 'start', 'refresh', 'login', 'logout', 'export', 'import',
             'lookup', 'suggest', 'preverify', 'separate', 'return', 'cancel'}
# 규칙의 예외(guidelines §10 '예외'): 경로 → 이유
API_EXCEPTIONS = {'/graphql': 'GraphQL(REST 밖)', '/v1/scanner/token': 'RFC 8628 토큰 엔드포인트',
                  '/v1/search': '전역 검색', '/v1/search/suggestions': '전역 검색의 하위'}
API_PLURAL_EXEMPT = {'staff'}  # 집합 명사
# 문서가 이름을 대도 openapi에 없어도 되는 경로 접두사: 이유
API_REF_ALLOW = {'/v1/payments/': '토스페이먼츠 API(외부)', '/v1/transactions': '토스페이먼츠 API(외부)',
                 '/v1/proto/': '프로토타입 전용 가짜 API', '/v1/forensics/': 'ADR-0080 2단계 초안'}


def api_paths(texts):
    spec = texts.get('docs/api/openapi.yaml', '')
    body = spec.split('\npaths:\n', 1)[-1].split('\nwebhooks:\n', 1)[0]
    paths = re.findall(r'^  (/[^:\s]*):\s*$', body, re.M)
    ops = len(re.findall(r'^    (?:get|post|put|patch|delete):', body, re.M))
    return paths, ops


def check_api(texts, rep):
    paths, ops = api_paths(texts)
    rep.info['api'] = {'paths': len(paths), 'operations': ops}
    for p in paths:
        if p in API_EXCEPTIONS:
            continue
        where = 'docs/api/openapi.yaml %s' % p
        if p.endswith('/') or '//' in p:
            rep.err('api', where, '끝 슬래시나 빈 단계')
        segs = [s for s in p.split('/')[1:] if s and s != 'v1']
        depth, prev = 0, None  # prev: None·ns·coll·single·id
        for i, s in enumerate(segs):
            if s.startswith('{') or s == 'me':
                prev = 'id'
                continue
            base = s[:-5] if s.endswith('.json') else s
            if base in API_NAMESPACES and prev in (None, 'ns'):
                prev = 'ns'
                continue
            if not re.match(r'^[a-z][a-z0-9-]*$', base):
                rep.err('api', where, '소문자·하이픈이 아닌 단어 %s' % s)
            if base.split('-')[0] in API_VERBS and base != 'separate-account':
                rep.err('api', where, '동사로 읽히는 단어 %s' % s)
            if prev == 'coll':
                rep.err('api', where, 'ID 자리의 고정 단어 %s' % s)
            depth += 1
            nxt = segs[i + 1] if i + 1 < len(segs) else ''
            if nxt.startswith('{') or nxt == 'me':
                if not base.endswith('s') and base not in API_PLURAL_EXEMPT:
                    rep.err('api', where, 'ID 앞의 단수 이름 %s' % s)
                prev = 'coll'
            else:
                # 복수 이름(컬렉션) 바로 뒤에 고정 단어가 오면 ID 자리를 차지한다(`/orders/search`)
                prev = 'coll' if base.endswith('s') and nxt else 'single'
        if depth > 2:
            rep.err('api', where, '깊이 %d단계(2단계까지)' % depth)
    norm = lambda q: re.sub(r'\{[^}]+\}', '{}', q)
    spec = {norm(q) for q in paths}
    ref_re = re.compile(r'\b(?:GET|POST|PUT|PATCH|DELETE)(?:·(?:GET|POST|PUT|PATCH|DELETE))*\s+`?(?:https://[a-z.-]+…)?(/v1/[A-Za-z0-9{}_.\-/]+)')
    for f, text in texts.items():
        if f.startswith(('docs/adr/', 'review/')) or f == 'docs/api/openapi.yaml':
            continue  # ADR 본문·검토 기록은 이력이라 옛 경로를 둔다(ADR-0081 대응표)
        for n, line in enumerate(text.split('\n'), 1):
            if '예전' in line or '옛 경로' in line:
                continue  # 바뀌기 전 경로를 일부러 보이는 줄
            for m in ref_re.finditer(line):
                q = m.group(1).rstrip('.').rstrip('*')
                if norm(q) in spec or q.startswith(tuple(API_REF_ALLOW)):
                    continue
                if f.startswith('prototype/'):
                    rep.warn('api', '%s:%d' % (f, n), 'openapi에 없는 경로 %s(프로토타입 전용 읽기 경로면 wbs 0.2.3)' % q)
                else:
                    rep.err('api', '%s:%d' % (f, n), 'openapi에 없는 경로 %s' % q)


# ---------- 5. 절 번호 참조 ----------
ALIAS = {
    '01-overview': 'planning/01-overview.md', '02-requirements': 'planning/02-requirements.md',
    '03-policies': 'planning/03-policies-glossary.md', '04-ia': 'planning/04-ia-flows-screens.md',
    '04-ia-flows-screens': 'planning/04-ia-flows-screens.md',
    'planning/01': 'planning/01-overview.md', 'planning/02': 'planning/02-requirements.md',
    'planning/03': 'planning/03-policies-glossary.md', 'planning/04': 'planning/04-ia-flows-screens.md',
    'design/d1': 'design/d1-brief.md', 'design/d2': 'design/d2-design-system.md', 'design/d5': 'design/d5-screen-blueprint.md', 'd5': 'design/d5-screen-blueprint.md',
    'design/d3': 'design/d3-screens.md', 'design/d4': 'design/d4-handoff-checklist.md',
    'd1': 'design/d1-brief.md', 'd2': 'design/d2-design-system.md', 'd3': 'design/d3-screens.md', 'd4': 'design/d4-handoff-checklist.md',
    'review': 'review/consistency-review.md', 'wbs': 'wbs/wbs.md', 'appendix': 'docs/appendix-learning-map.md',
    '00-summary': '00-summary.md', '00-diagnosis': '00-diagnosis.md',
}


def resolve(name):
    n = name.strip('`').rstrip('.')
    if n in ALIAS:
        return ALIAS[n]
    cands = [n, n + '.md', 'docs/' + n, 'docs/' + n + '.md', 'docs/features/' + n, 'docs/features/' + n + '.md',
             'docs/api/' + n, 'docs/api/' + n + '.md', 'docs/security/' + n, 'docs/security/' + n + '.md']
    for c in cands:
        if os.path.isfile(os.path.join(ROOT, c)):
            return c
    return None


def headings(path, cache={}):
    if path not in cache:
        hs = {}
        with io.open(os.path.join(ROOT, path), encoding='utf-8') as fh:
            for l in strip_fences(fh.read()):
                m = re.match(r'^(#{2,4})\s+(\d+(?:\.\d+)*)[.\s]', l)
                if m:
                    hs[m.group(2).rstrip('.')] = l.strip()
        cache[path] = hs
    return cache[path]


def check_secrefs(texts, rep):
    names = 'queue-admission|seat-hold|payment|identity|offline-gate|control-tower|transfer-refund|settlement|analytics|search|observability|infra|guidelines|architecture|data|devops|verification'
    bare_re = re.compile(r'(?<![\w/.-])((?:features/)?(?:%s))(?:\.md)?\s*§\s*(\d+(?:\.\d+)?)' % names)
    ref_re = re.compile(r'(`?(?:docs/[\w./-]+|planning/[\w.-]+|design/[\w.-]+|review|wbs|appendix|0[0-4]-[\w-]+|d[1-5]|[a-z]+-[a-z-]+\.md)`?)\s*§\s*(\d+(?:\.\d+)?)')
    total = 0
    for f, text in texts.items():
        if f.startswith('docs/appendix') or not f.endswith(('.md', '.yaml')):
            continue
        for n, line in enumerate(text.split('\n'), 1):
            for m in list(ref_re.finditer(line)) + list(bare_re.finditer(line)):
                tgt = resolve(m.group(1))
                if not tgt:
                    continue
                total += 1
                if m.group(2) not in headings(tgt):
                    rep.err('secrefs', '%s:%d' % (f, n), '%s §%s 절이 없음' % (tgt, m.group(2)))
    rep.info['secrefs_checked'] = total


# ---------- 6. 작업 흔적 ----------
def check_artifacts(texts, rep):
    for f, text in texts.items():
        for n, line in enumerate(text.split('\n'), 1):
            if re.match(r'^다음:', line):
                rep.err('artifacts', '%s:%d' % (f, n), "작업용 '다음:' 줄")
            if re.search(r'\bTODO\b|\bTBD\b', line):
                rep.warn('artifacts', '%s:%d' % (f, n), 'TODO·TBD')
            if re.search(r'\[충돌 C-\d+', line) and f.startswith(('planning/', 'design/', 'docs/')):
                rep.err('artifacts', '%s:%d' % (f, n), '해소되지 않은 [충돌] 표시(기획 v1.0은 0건)')


# ---------- 6의2. ASVS 요구사항 요약 일치(00-summary 질문 45-5 (가), 2026-10-23) ----------
def check_asvs(texts, rep):
    seen = {}
    for f, text in texts.items():
        if not f.startswith('docs/security/asvs/'):
            continue
        for n, line in enumerate(text.split('\n'), 1):
            m = re.match(r'^\| (v5\.0\.0-[\d.]+) \| (L\d[^|]*?) \| (.*?) \| ', line)
            if not m:
                continue
            where = '%s:%d' % (f, n)
            if m.group(1) in seen and seen[m.group(1)][0] != m.group(3):
                rep.err('asvs', where, '%s의 요구사항 요약이 %s와 다르다' % (m.group(1), seen[m.group(1)][1]))
            seen.setdefault(m.group(1), (m.group(3), where))
    rep.info['asvs_ids'] = len(seen)


# ---------- 7. 마커 ----------
def count_markers(texts, rep, out_path=None):
    tot_all = collections.Counter()
    tot_core = collections.Counter()
    lines = []
    for f, text in texts.items():
        c = collections.Counter({k: text.count(k) for k in MARKERS})
        tot_all.update(c)
        if f not in ('00-summary.md', 'review/consistency-review.md'):
            tot_core.update(c)
        if out_path:
            for n, line in enumerate(text.split('\n'), 1):
                for k in MARKERS:
                    if k in line:
                        i = line.find(k)
                        lines.append('%s:%d\t%s\t%s' % (f, n, k, line[max(0, i - 60):i + 120].strip()))
    rep.info['markers_all'] = {k.strip('['): tot_all[k] for k in MARKERS}
    rep.info['markers_excl_summary_review'] = {k.strip('['): tot_core[k] for k in MARKERS}
    if out_path:
        with io.open(out_path, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(lines) + '\n')


# ---------- 8. WBS ----------
def check_wbs(texts, rep):
    md = texts.get('wbs/wbs.md')
    if md is None or not os.path.exists(os.path.join(ROOT, 'wbs', 'wbs.csv')):
        rep.err('wbs', 'wbs/', 'wbs.md 또는 wbs.csv 없음')
        return
    with io.open(os.path.join(ROOT, 'wbs', 'wbs.csv'), encoding='utf-8', newline='') as fh:
        rows = list(csv.DictReader(fh))
    est = {r['WBS ID']: (r['레벨'], float(r['추정(일)'])) for r in rows}
    for r in rows:
        if r['레벨'] in ('1', '2'):
            kids = [k for k, (lv, d) in est.items() if lv == str(int(r['레벨']) + 1) and k.rsplit('.', 1)[0] == r['WBS ID']]
            s = sum(est[k][1] for k in kids)
            if abs(s - float(r['추정(일)'])) > 1e-6:
                rep.err('wbs', 'wbs.csv %s' % r['WBS ID'], '하위 합계 %g ≠ %s' % (s, r['추정(일)']))
    md_tasks = {}
    for m in re.finditer(r'^\| (\d+\.\d+\.\d+) \|(?:[^|]*\|){3} ([\d.]+) \|', md, re.M):
        md_tasks[m.group(1)] = float(m.group(2))
    csv_tasks = {k: d for k, (lv, d) in est.items() if lv == '3'}
    for k in sorted(set(csv_tasks) | set(md_tasks)):
        if k not in md_tasks:
            rep.err('wbs', 'wbs.md', '%s가 md에 없음' % k)
        elif k not in csv_tasks:
            rep.err('wbs', 'wbs.csv', '%s가 csv에 없음' % k)
        elif abs(md_tasks[k] - csv_tasks[k]) > 1e-6:
            rep.err('wbs', 'wbs.md %s' % k, '추정이 csv와 다름(%g ≠ %g)' % (md_tasks[k], csv_tasks[k]))
    total = sum(d for k, (lv, d) in est.items() if lv == '1')
    rep.info['wbs'] = {'tasks': len(csv_tasks), 'days': total, 'weeks': round(total / 5, 1)}


# ---------- 9. 기획 버전 ----------
def check_versions(texts, rep):
    plan = re.search(r'\*\*기획 버전\*\*: (v\d+\.\d+)', texts.get('planning/01-overview.md', ''))
    if not plan:
        rep.err('versions', 'planning/01-overview.md', '기획 버전 줄 없음')
        return
    v = plan.group(1)
    for f, text in texts.items():
        for m in re.finditer(r'기준 기획 버전\**:?\**:? (v\d+\.\d+)', text):
            if m.group(1) != v:
                rep.warn('versions', f, '기준 기획 버전 %s ≠ 기획 %s' % (m.group(1), v))
    rep.info['plan_version'] = v


# ---------- 10. 원문 대조(선택) ----------
def check_coverage(texts, rep):
    arch = [os.path.join(ROOT, 'archive', f) for f in os.listdir(os.path.join(ROOT, 'archive')) if f.endswith('.md')]
    if not arch:
        rep.warn('coverage', 'archive/', '원문 없음')
        return
    with io.open(arch[0], encoding='utf-8') as fh:
        src = fh.read()
    nall = '\n'.join(texts.values())
    url_re = re.compile(r'https?://[^\s)\]>"\'`]+')
    nu = lambda u: u.rstrip('.,;:')
    d_urls = collections.OrderedDict()
    for n, line in enumerate(src.split('\n'), 1):
        for u in url_re.findall(line):
            d_urls.setdefault(nu(u), n)
    n_urls = set(nu(u) for u in url_re.findall(nall))
    miss = [u for u in d_urls if u not in n_urls]
    for u in miss:
        rep.warn('coverage', 'archive L%d' % d_urls[u], '원문 링크가 새 문서에 없음 %s' % u)
    tok_re = re.compile(r'(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9+#_.\-]*[A-Za-z0-9+#]')
    low = url_re.sub(' ', nall).lower()
    toks = collections.OrderedDict()
    for n, line in enumerate(url_re.sub(' ', src).split('\n'), 1):
        for tk in tok_re.findall(line):
            if len(tk) >= 3:
                toks.setdefault(tk, n)
    mt = [tk for tk in toks if tk.lower() not in low]
    for tk in mt:
        rep.warn('coverage', 'archive L%d' % toks[tk], '원문 영문 용어가 새 문서에 없음 %s' % tk)
    rep.info['coverage'] = {'urls': len(d_urls), 'urls_missing': len(miss), 'terms': len(toks), 'terms_missing': len(mt)}


def main():
    ap = argparse.ArgumentParser(description='PEAKET 문서 점검')
    ap.add_argument('--strict', action='store_true', help='경고도 실패로 처리')
    ap.add_argument('--json', action='store_true', help='JSON으로 출력')
    ap.add_argument('--coverage', action='store_true', help='archive/ 원문 대조(링크·영문 용어)도 실행')
    ap.add_argument('--markers-out', help='마커가 있는 줄 목록을 이 파일에 씀')
    a = ap.parse_args()
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    rep = Report()
    texts = load_files()
    check_ids(texts, rep)
    check_tables_fences(texts, rep)
    check_paths(texts, rep)
    check_api(texts, rep)
    check_secrefs(texts, rep)
    check_artifacts(texts, rep)
    check_asvs(texts, rep)
    count_markers(texts, rep, a.markers_out)
    check_wbs(texts, rep)
    check_versions(texts, rep)
    if a.coverage:
        check_coverage(texts, rep)
    failed = bool(rep.errors) or (a.strict and bool(rep.warnings))
    if a.json:
        print(json.dumps({'errors': rep.errors, 'warnings': rep.warnings, 'info': rep.info, 'failed': failed}, ensure_ascii=False, indent=2))
    else:
        print('파일 %d개 점검' % len(texts))
        for k, v in rep.info.items():
            print('  %s: %s' % (k, v))
        for e in rep.errors:
            print('오류 [%s] %s: %s' % (e['check'], e['where'], e['msg']))
        for w in rep.warnings:
            print('경고 [%s] %s: %s' % (w['check'], w['where'], w['msg']))
        print('결과: 오류 %d, 경고 %d → %s' % (len(rep.errors), len(rep.warnings), '실패' if failed else '통과'))
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as ex:  # 실행 실패는 점검 실패와 구분한다
        print('실행 실패: %r' % (ex,), file=sys.stderr)
        sys.exit(2)
