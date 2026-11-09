"""덮개 표 만들기: 정본의 큰 절(## )·ADR·FR·NFR·POL·SCR·CMP가 해설서(docs/walkthrough/) 어디에 나오는지 센다(ADR-0177 결정 6).
사용: python -I -X utf8 tools/walkthrough/coverage.py [--write] [--list-blank]
  --write: docs/walkthrough/coverage.md를 다시 쓴다. --list-blank: 빈칸인 절을 보인다."""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WRITE = '--write' in sys.argv
WT = os.path.join(ROOT, 'docs', 'walkthrough')


def read(p):
    with io.open(p, encoding='utf-8') as f:
        return f.read()


# 정본 문서: docs/ 아래 .md 가운데 adr/, walkthrough/, perf-ledger/runs|charts, api/*/ 하위 README 말고 전부
canon = []
for dp, dn, fn in os.walk(os.path.join(ROOT, 'docs')):
    rel = os.path.relpath(dp, ROOT).replace('\\', '/')
    if rel.startswith('docs/adr') or rel.startswith('docs/walkthrough') or rel.startswith('docs/perf-ledger/'):
        continue
    for f in fn:
        if f.endswith('.md'):
            canon.append((rel + '/' + f))
canon.sort()

# 해설서 파일
wt_files = []
for dp, dn, fn in os.walk(WT):
    for f in fn:
        if f.endswith('.md') and f != 'coverage.md':
            wt_files.append(os.path.join(dp, f))
wt_files.sort()


def short(p):
    r = os.path.relpath(p, WT).replace('\\', '/')
    if r == '01-system-design.md':
        return '한 판'
    if r == '00-status.md':
        return '현황'
    if r == 'README.md':
        return '길잡이'
    if r.startswith('fields/'):
        return '분야 ' + str(int(r[7:9]))
    if r.startswith('db/'):
        return 'DB ' + str(int(r[3:5]))
    if r.startswith('decisions/D'):
        return 'D-' + r[11:13]
    if r == 'decisions/README.md':
        return '카드 목록'
    return r


wt_text = {short(p): read(p) for p in wt_files}

# 정본 경로를 가리키는 여러 표기: 'docs/features/x.md', '../../features/x.md', 'docs/planning/03'(번호만) 등
def path_aliases(rel):
    a = {rel, rel[len('docs/'):]}
    m = re.match(r'docs/planning/(\d\d)-', rel)
    if m:
        a.add('docs/planning/' + m.group(1))
        a.add('planning/' + m.group(1))
    m = re.match(r'docs/design/(d\d)-', rel)
    if m:
        a.add('docs/design/' + m.group(1))
        a.add('design/' + m.group(1))
    return a


SEC_RE = re.compile(r'§\s?(\d+(?:\.\d+)*)(?:\s?[~∼]\s?§?(\d+(?:\.\d+)*))?')


def secs_after(line, start):
    """line[start:]에서 이어지는 § 번호들(·, 와, ~ 범위)을 모은다. 다음 문서 경로가 나오면 멈춘다."""
    seg = line[start:start + 160]
    stop = re.search(r'docs/[\w/-]+\.md|\]\(', seg[1:])
    if stop:
        seg = seg[:stop.start() + 1]
    out = set()
    for m in SEC_RE.finditer(seg):
        a = m.group(1)
        out.add(a.split('.')[0])
        out.add(a)
        if m.group(2):
            try:
                lo, hi = int(a.split('.')[0]), int(m.group(2).split('.')[0])
                for k in range(lo, hi + 1):
                    out.add(str(k))
            except ValueError:
                pass
    return out


CANON_PATH_RE = re.compile(r'docs/[\w./-]+\.md')


def owned_sections():
    """분야 편 §2 '절마다 읽기' 표: 행이 '| §N …'으로 시작하면 지금 문서의 §N이다.
    지금 문서는 처음에 '맡는 정본' 줄의 첫 문서이고, 표 밖 줄에 다른 정본 경로가 나오면 그 문서로 바뀐다."""
    res = {}   # (name, rel) -> set(sec)
    for name, t in wt_text.items():
        if not name.startswith('분야 '):
            continue
        cur = None
        in2 = False
        for line in t.split('\n'):
            if line.startswith('- **맡는 정본**'):
                m = CANON_PATH_RE.search(line)
                cur = m.group(0) if m else None
            if line.startswith('## '):
                in2 = line.startswith('## 2.')
                continue
            if not in2:
                continue
            if not line.startswith('|'):
                m = CANON_PATH_RE.search(line)
                if m:
                    cur = m.group(0)
                continue
            if cur and line.startswith('| §'):
                res.setdefault((name, cur), set()).update(secs_after(line, 1))
    return res


OWNED = owned_sections()


def refs_for(rel):
    """해설서 파일마다 이 정본 문서의 어느 § 번호를 가리키는지."""
    al = sorted(path_aliases(rel), key=len, reverse=True)
    res = {}
    for (name, r), secs in OWNED.items():
        if r == rel:
            res.setdefault(name, set()).update(secs)
    for name, t in wt_text.items():
        found = set(res.get(name, set()))
        mentioned = name in res
        for line in t.split('\n'):
            for a in al:
                i = line.find(a)
                while i >= 0:
                    mentioned = True
                    found |= secs_after(line, i + len(a))
                    i = line.find(a, i + 1)
        if mentioned:
            res[name] = found
    return res


rows = []   # (문서, 절 표시, 덮는 파일 목록)
blank = 0
total = 0
for rel in canon:
    text = read(os.path.join(ROOT, rel))
    heads = [l[3:].strip() for l in text.split('\n') if l.startswith('## ')]
    if not heads:
        continue
    refs = refs_for(rel)
    for h in heads:
        total += 1
        m = re.match(r'(\d+)[.)]?\s', h)
        num = m.group(1) if m else None
        cov = []
        for name, secs in refs.items():
            if num and num in secs:
                cov.append(name)
            elif not num and h[:20] and h[:20] in wt_text[name]:
                cov.append(name)
        # 번호 없는 짧은 문서(README 등)는 문서가 언급되기만 해도 덮은 것으로 본다(분야 편 §2에 문서 단위로 적는다)
        if not cov and not num and refs:
            cov = sorted(refs)[:3]
        if not cov:
            blank += 1
        rows.append((rel, h, cov))

all_text = '\n'.join(wt_text.values())


def ids(kind, pat, src_files):
    found = set()
    for f in src_files:
        found |= set(re.findall(pat, read(os.path.join(ROOT, f))))
    return sorted(found)


adr_ids = sorted('ADR-' + f[:4] for f in os.listdir(os.path.join(ROOT, 'docs', 'adr')) if re.match(r'\d{4}-', f))
id_sets = {'ADR': adr_ids}
for kind in ('FR', 'NFR', 'POL', 'SCR', 'CMP'):
    # 정의 위치: 표의 첫 칸이 그 ID인 행
    defs = set()
    for rel in canon:
        for l in read(os.path.join(ROOT, rel)).split('\n'):
            m = re.match(r'^\|\s*\**`?(%s-\d{3})' % kind, l)
            if m:
                defs.add(m.group(1))
    id_sets[kind] = sorted(defs)

id_cov = {}
for kind, lst in id_sets.items():
    for i in lst:
        where = [n for n, t in wt_text.items() if re.search(re.escape(i) + r'(?!\d)', t)]
        id_cov[i] = where

blank_ids = {k: [i for i in v if not id_cov[i]] for k, v in id_sets.items()}

# ADR 자리표(decisions/README.md §2)가 둔 편에 그 ADR이 실제로 나오는지
place_bad = []
rd = wt_text.get('카드 목록', '')
for l in rd.split('\n'):
    m = re.match(r'\| (ADR-\d{4}) \|.*\| (.+?) \|\s*$', l)
    if not m:
        continue
    adr, place = m.group(1), m.group(2)
    targets = ['분야 ' + n for n in re.findall(r'분야 편 (\d+)', place)] + ['D-' + c for c in re.findall(r'D-(\d\d)', place)]
    for tg in targets:
        if not re.search(re.escape(adr) + r'(?!\d)', wt_text.get(tg, '')):
            place_bad.append('%s → %s' % (adr, tg))
print('ADR 자리표 어긋남: %d %s' % (len(place_bad), ' '.join(place_bad)))

# 표·키 단위: data.md §2 ERD의 PostgreSQL 표와 §3 Redis 키 표의 행이 DB 설계 편에 나오는지
data_lines = read(os.path.join(ROOT, 'docs', 'data.md')).split('\n')
pg_tables = []
in_er = False
for l in data_lines:
    if l.strip() == 'erDiagram':
        in_er = True
        continue
    if in_er and l.strip() == '```':
        in_er = False
        continue
    if in_er:
        m = re.match(r'\s+([a-z_][a-z0-9_]*)\s*\{', l)
        if m and m.group(1) not in pg_tables:
            pg_tables.append(m.group(1))
        # 칸 정의 없이 관계선에만 나오는 표(이름만 있는 상자)도 표로 센다
        m = re.match(r'\s+([a-z_][a-z0-9_]*)\s+[|{}o.\-]+\s+([a-z_][a-z0-9_]*)\s*:', l)
        if m:
            for x in m.groups():
                if x not in pg_tables:
                    pg_tables.append(x)
s3 = [i for i, l in enumerate(data_lines) if l.startswith('## 3.')]
s4 = [i for i, l in enumerate(data_lines) if l.startswith('## 4.')]
redis_keys = []
if s3 and s4:
    in_key_table = False
    for l in data_lines[s3[0]:s4[0]]:
        if l.startswith('| 키 (예시) |'):
            in_key_table = True
            continue
        if in_key_table and not l.startswith('|'):
            in_key_table = False
        if not in_key_table or l.startswith('| ---'):
            continue
        # 키 표의 행마다 첫 칸의 첫 백틱 이름(예: `q:{event:E}:seq`, '위 두 키 뒤에 `:over`를 붙인 키')
        m = re.match(r'^\|[^|`]*`([^`]+)`', l)
        if m:
            redis_keys.append(m.group(1))
db_text = {n: t for n, t in wt_text.items() if n.startswith('DB ')}
pg_cov = {x: [n for n, t in db_text.items() if re.search(r'(?<![A-Za-z0-9_])' + re.escape(x) + r'(?![A-Za-z0-9_])', t)] for x in pg_tables}
rk_cov = {x: [n for n, t in db_text.items() if x in t] for x in redis_keys}
pg_blank = [x for x in pg_tables if not pg_cov[x]]
rk_blank = [x for x in redis_keys if not rk_cov[x]]
print('PostgreSQL 표: %d, DB 설계 편 빈칸 %d %s' % (len(pg_tables), len(pg_blank), ' '.join(pg_blank)))
print('Redis 키: %d, DB 설계 편 빈칸 %d %s' % (len(redis_keys), len(rk_blank), ' '.join(rk_blank)))
print('정본 큰 절: %d, 빈칸 %d' % (total, blank))
for k, v in id_sets.items():
    print('%s: %d, 빈칸 %d %s' % (k, len(v), len(blank_ids[k]), ' '.join(blank_ids[k][:40])))
if '--list-blank' in sys.argv:
    for rel, h, cov in rows:
        if not cov:
            print('BLANK', rel, '|', h[:70])

if WRITE:
    out = []
    w = out.append
    w('# 덮개 표')
    w('')
    w('- **정본 매핑 기준**: ADR-0182 반영')
    w('- **이 문서가 하는 일**: 정본의 큰 절(`## ` 제목)과 ADR, FR·NFR·POL·SCR·CMP 하나하나가 해설서의 어느 편에서 설명되는지 적는다. 빈칸이 0이면 docs 전체를 덮었다고 본다([ADR-0177](../adr/0177-walkthrough-explain-in-interview.md) 결정 6).')
    w('- **만드는 법**: 손으로 쓰지 않고 스크립트로 센다. 해설서 파일에 그 정본 문서의 경로와 `§번호`가 함께 나오거나(예: `docs/features/payment.md §3`), 분야 편 §2 표에 그 문서의 `| §3 …` 행이 있으면 그 절을 덮었다고 본다. 번호 없는 절은 제목 글자로 찾는다. ID는 해설서에 그 번호가 나오면 덮었다고 본다. 정본이 바뀌면 `python -I -X utf8 tools/walkthrough/coverage.py --write`로 다시 만든다.')
    w('- **약어**: 한 판 = [한 판 문서](01-system-design.md), 분야 N = 분야 편 N, DB N = DB 설계 편 N, D-NN = 결정 카드, 현황 = [현황 한 장](00-status.md).')
    w('')
    w('## 1. 요약')
    w('')
    w('| 대상 | 수 | 빈칸 |')
    w('| --- | --- | --- |')
    w('| 정본 큰 절(ADR 제외) | %d | %d |' % (total, blank))
    for k in ('ADR', 'FR', 'NFR', 'POL', 'SCR', 'CMP'):
        w('| %s | %d | %d |' % (k, len(id_sets[k]), len(blank_ids[k])))
    w('| ADR 자리표대로 그 편에 나오는가([결정 카드 목록](decisions/README.md) §2) | %d | %d |' % (len(adr_ids), len(place_bad)))
    w('| PostgreSQL 표(docs/data.md §2 ERD)가 DB 설계 편에 나오는가 | %d | %d |' % (len(pg_tables), len(pg_blank)))
    w('| Redis 키(docs/data.md §3 키 표의 행)가 DB 설계 편에 나오는가 | %d | %d |' % (len(redis_keys), len(rk_blank)))
    w('')
    w('빈칸 0은 해설서 어딘가에 그 절이나 ID의 설명 줄이 있다는 뜻이다. 설명의 깊이는 편마다 다르다. 분야 편 §2 \'절마다 읽기\' 표가 절마다 한 줄씩 \'무엇을 정하나·왜\'를 적고, 깊은 설명은 한 판 문서·결정 카드·DB 설계 편이 맡는다.')
    w('')
    w('## 2. 정본 큰 절')
    w('')
    cur = None
    for rel, h, cov in rows:
        if rel != cur:
            if cur is not None:
                w('')
            cur = rel
            w('### %s' % rel)
            w('')
            w('| 절 | 설명하는 곳 |')
            w('| --- | --- |')
        hh = h.replace('|', '\\|')
        w('| %s | %s |' % (hh, '·'.join(sorted(cov, key=lambda s: (s[0], s))) if cov else '—'))
    w('')
    n = 3
    for k, title in (('ADR', '결정 기록(ADR)'), ('FR', '기능 요구(FR)'), ('NFR', '품질 요구(NFR)'), ('POL', '정책(POL)'), ('SCR', '화면(SCR)'), ('CMP', '컴포넌트(CMP)')):
        w('## %d. %s' % (n, title))
        w('')
        w('| ID | 설명하는 곳 |')
        w('| --- | --- |')
        for i in id_sets[k]:
            c = id_cov[i]
            w('| %s | %s |' % (i, '·'.join(sorted(c)[:8]) + (' 외 %d곳' % (len(c) - 8) if len(c) > 8 else '') if c else '—'))
        w('')
        n += 1
    with io.open(os.path.join(WT, 'coverage.md'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(out))
    print('coverage.md 씀')
