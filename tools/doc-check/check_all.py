"""PEAKET 문서 점검: YAML 중복 키, ID 참조, FR→시험 연결, 표, 펜스, 경로, REST 경로 규칙과 openapi 계약, 절 번호 참조,
작업 흔적, ASVS 표, 결정이 많은 ADR의 결정별 표, 마커, WBS 일치, 기획 버전.

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
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
# 원문 설계서는 2026-10-27 archive/에서 지웠고 이 git 태그에만 남는다(ADR-0098). --coverage가 여기서 읽는다.
ORIGINAL_TAG = 'archive-original'
SCAN_EXT = ('.md', '.yaml', '.json', '.csv')
SKIP_DIRS = {'archive', 'tools', '.git', 'node_modules'}
ID_KINDS = ('FR', 'NFR', 'POL', 'SCR', 'CMP', 'ADR')
MARKERS = ('[가정', '[충돌', '[보완')
# 존재하지 않아도 되는 경로: 외부 URL 안의 경로 문자열이라 오탐(review R-10),
# 없앤 문서인데 고치지 않는 지난 기록(ADR 본문, review의 지난 행)이 가리키는 경로(ADR-0090, review R-105)
ALLOW_PATHS = {'docs/software-architecture.md', 'docs/arc42.md', 'docs/appendix-learning-map.md'}


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


# ---------- YAML 읽기(표준 라이브러리만) ----------
class YamlError(Exception):
    def __init__(self, line, msg):
        super().__init__('%d줄: %s' % (line, msg))
        self.line = line


class YamlReader:
    """이 저장소의 계약 YAML이 쓰는 부분(블록·흐름 매핑과 목록, 따옴표·일반 글자, |·> 블록 글자)만 읽는다.

    값은 dict·list·str·None으로 돌려준다(숫자·참거짓을 바꾸지 않는다). 같은 매핑에 같은 키가 두 번 나오면
    dups에 (줄, 키, 앞 줄)을 모은다. 앵커·별칭·태그·복합 키는 쓰지 않으므로 만나면 YamlError다.
    """

    def __init__(self, text):
        self.lines = text.split('\n')
        self.i = 0
        self.dups = []

    # --- 줄 다루기 ---
    @staticmethod
    def _indent(raw):
        return len(raw) - len(raw.lstrip(' '))

    def _skip(self):
        while self.i < len(self.lines):
            s = self.lines[self.i].strip()
            if s and not s.startswith('#') and s not in ('---', '...'):
                return True
            self.i += 1
        return False

    def _peek(self):
        if not self._skip():
            return None, None
        raw = self.lines[self.i]
        return self._indent(raw), raw.strip(' ')

    @staticmethod
    def _is_seq(content):
        return content == '-' or content.startswith('- ')

    def _key_end(self, s):
        """s가 '키: …' 꼴이면 (키, ':' 다음 위치), 아니면 None."""
        if not s or s[0] in '[{&*!|>%@`?':
            return None
        if s[0] in '"\'':
            val, p = self._quoted(s, 0, 0)
            while p < len(s) and s[p] == ' ':
                p += 1
            if p < len(s) and s[p] == ':' and (p + 1 == len(s) or s[p + 1] == ' '):
                return val, p + 1
            return None
        p = 0
        while p < len(s):
            if s[p] == ':' and (p + 1 == len(s) or s[p + 1] == ' '):
                return s[:p].rstrip(), p + 1
            if s[p] == '#' and p and s[p - 1] == ' ':
                return None
            p += 1
        return None

    def _dup(self, seen, key, line):
        if key in seen:
            self.dups.append((line, key, seen[key]))
        else:
            seen[key] = line

    # --- 블록 ---
    def parse(self):
        ind, content = self._peek()
        if ind is None:
            return None
        node = self._node(ind)
        if self._skip():
            raise YamlError(self.i + 1, '해석하지 못한 줄(들여쓰기가 맞지 않음)')
        return node

    def _node(self, ind):
        _, content = self._peek()
        if self._is_seq(content):
            return self._seq(ind)
        if self._key_end(content):
            return self._map(ind)
        line = self.i + 1
        self.i += 1
        return self._value(content, ind - 1, line)

    def _map(self, ind):
        out, seen = {}, {}
        while True:
            li, content = self._peek()
            if li is None or li < ind or self._is_seq(content):
                break
            if li > ind:
                raise YamlError(self.i + 1, '들여쓰기가 맞지 않음')
            ke = self._key_end(content)
            if not ke:
                raise YamlError(self.i + 1, "'키: 값' 꼴이 아님")
            key, p = ke
            line = self.i + 1
            self._dup(seen, key, line)
            self.i += 1
            out[key] = self._value(content[p:], ind, line)
        return out

    def _seq(self, ind):
        out = []
        while True:
            li, content = self._peek()
            if li is None or li != ind or not self._is_seq(content):
                break
            after = content[1:]
            item = after.lstrip(' ')
            col = ind + 1 + (len(after) - len(item))
            line = self.i + 1
            if not item or item.startswith('#'):
                self.i += 1
                nli, _ = self._peek()
                out.append(self._node(nli) if nli is not None and nli > ind else None)
            elif self._is_seq(item) or self._key_end(item):
                self.lines[self.i] = ' ' * col + item  # '- 키: 값'은 그 칸에서 시작하는 매핑
                out.append(self._node(col))
            else:
                self.i += 1
                out.append(self._value(item, ind, line))
        return out

    def _value(self, rest, ind, line):
        """'키:' 뒤(또는 목록 항목)의 값. ind는 부모의 들여쓰기."""
        r = rest.strip(' ')
        if not r or r.startswith('#'):
            li, content = self._peek()
            if li is None:
                return None
            if li > ind:
                return self._node(li)
            if li == ind and self._is_seq(content):
                return self._seq(ind)
            return None
        c = r[0]
        if c in '&*!':
            raise YamlError(line, '앵커·별칭·태그는 읽지 않는다')
        if c in '|>':
            return self._block_scalar(r, ind, line)
        if c in '[{"\'':
            text, start = r, self.i
            while True:
                try:
                    val, p = self._flow(text, 0, line) if c in '[{' else self._quoted(text, 0, line)
                    break
                except YamlError:
                    if self.i >= len(self.lines) or (self.lines[self.i].strip() and self._indent(self.lines[self.i]) <= ind):
                        raise
                    text += '\n' + self.lines[self.i]
                    self.i += 1
            tail = text[p:].strip()
            if tail and not tail.startswith('#'):
                raise YamlError(line, '값 뒤에 남은 글자: %s' % tail[:30])
            return val
        parts = [self._plain_line(r)]
        while self.i < len(self.lines):
            raw = self.lines[self.i]
            if raw.strip() and (self._indent(raw) <= ind or raw.strip().startswith('#')):
                break
            if not raw.strip():
                j = self.i
                while j < len(self.lines) and not self.lines[j].strip():
                    j += 1
                if j >= len(self.lines) or self._indent(self.lines[j]) <= ind:
                    break
                parts.append('\n')
            else:
                parts.append(self._plain_line(raw.strip()))
            self.i += 1
        out = ''
        for part in parts:
            if part.endswith(':') or ': ' in part:
                raise YamlError(line, "일반 글자 안에 ': '가 있음(따옴표로 감싸거나 들여쓰기를 고친다)")
            out += part if part == '\n' or not out or out.endswith('\n') else ' ' + part
        return out

    @staticmethod
    def _plain_line(s):
        p = s.find(' #')
        return (s[:p] if p >= 0 else s).rstrip()

    def _block_scalar(self, header, ind, line):
        h = self._plain_line(header)
        chomp = '-' if '-' in h else ('+' if '+' in h else '')
        digits = [ch for ch in h if ch.isdigit()]
        body = []
        while self.i < len(self.lines):
            raw = self.lines[self.i]
            if raw.strip() and self._indent(raw) <= ind:
                break
            body.append(raw)
            self.i += 1
        nonblank = [b for b in body if b.strip()]
        cut = ind + int(digits[0]) if digits else (min(self._indent(b) for b in nonblank) if nonblank else 0)
        rows = [b[cut:] if b.strip() else '' for b in body]
        while rows and not rows[-1] and chomp != '+':
            rows.pop()
        if h[0] == '|':
            text = '\n'.join(rows)
        else:
            text, prev_more = '', False
            for k, row in enumerate(rows):
                more = row.startswith(' ')
                if k == 0:
                    text = row
                elif not row:
                    text += '\n'
                elif more or prev_more or text.endswith('\n'):
                    text += ('\n' if not text.endswith('\n') or more else '') + row
                else:
                    text += ' ' + row
                prev_more = more
        if chomp == '-':
            return text
        return text + '\n' if rows else ''

    # --- 따옴표와 흐름 ---
    @staticmethod
    def _quoted(s, p, line):
        q, p, out = s[p], p + 1, []
        esc = {'n': '\n', 't': '\t', 'r': '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', ' ': ' ', 'b': '\b', 'e': '\x1b'}
        while p < len(s):
            ch = s[p]
            if q == "'" and ch == "'":
                if s[p + 1:p + 2] == "'":
                    out.append("'")
                    p += 2
                    continue
                return ''.join(out), p + 1
            if q == '"' and ch == '"':
                return ''.join(out), p + 1
            if q == '"' and ch == '\\':
                n = s[p + 1:p + 2]
                if n in ('x', 'u', 'U'):
                    w = {'x': 2, 'u': 4, 'U': 8}[n]
                    out.append(chr(int(s[p + 2:p + 2 + w], 16)))
                    p += 2 + w
                    continue
                if n == '\n':
                    p += 2
                    while p < len(s) and s[p] in ' \t':
                        p += 1
                    continue
                out.append(esc.get(n, n))
                p += 2
                continue
            if ch == '\n':  # 여러 줄 따옴표 글자: 줄바꿈 하나는 빈칸, 빈 줄은 줄바꿈
                while out and out[-1] in ' \t':
                    out.pop()
                p += 1
                blank = 0
                while p < len(s) and s[p] in ' \t\n':
                    blank += s[p] == '\n'
                    p += 1
                out.append('\n' * blank if blank else ' ')
                continue
            out.append(ch)
            p += 1
        raise YamlError(line, '따옴표가 닫히지 않음')

    def _ws(self, s, p):
        while p < len(s):
            if s[p] in ' \t\n\r':
                p += 1
            elif s[p] == '#' and (p == 0 or s[p - 1] in ' \t\n'):
                while p < len(s) and s[p] != '\n':
                    p += 1
            else:
                break
        return p

    def _flow(self, s, p, line):
        p = self._ws(s, p)
        if p >= len(s):
            raise YamlError(line, '흐름 값이 끝나지 않음')
        ch = s[p]
        if ch == '{':
            out, seen, p = {}, {}, p + 1
            while True:
                p = self._ws(s, p)
                if p >= len(s):
                    raise YamlError(line, "'}'가 없음")
                if s[p] == '}':
                    return out, p + 1
                key, p = self._flow_scalar(s, p, line, True)
                p = self._ws(s, p)
                val = None
                if p < len(s) and s[p] == ':':
                    p = self._ws(s, p + 1)
                    if p < len(s) and s[p] not in ',}':
                        val, p = self._flow(s, p, line)
                self._dup(seen, key, line + s.count('\n', 0, p))
                out[key] = val
                p = self._ws(s, p)
                if p < len(s) and s[p] == ',':
                    p += 1
                elif p < len(s) and s[p] == '}':
                    continue
                else:
                    raise YamlError(line, "흐름 매핑에 ',' 또는 '}'가 없음")
        if ch == '[':
            out, p = [], p + 1
            while True:
                p = self._ws(s, p)
                if p >= len(s):
                    raise YamlError(line, "']'가 없음")
                if s[p] == ']':
                    return out, p + 1
                val, p = self._flow(s, p, line)
                q = self._ws(s, p)
                if q < len(s) and s[q] == ':' and not isinstance(val, (dict, list)):  # [키: 값] 한 쌍 매핑
                    q = self._ws(s, q + 1)
                    inner, p = self._flow(s, q, line)
                    val = {val: inner}
                out.append(val)
                p = self._ws(s, p)
                if p < len(s) and s[p] == ',':
                    p += 1
                elif p < len(s) and s[p] == ']':
                    continue
                else:
                    raise YamlError(line, "흐름 목록에 ',' 또는 ']'가 없음")
        return self._flow_scalar(s, p, line, False)

    def _flow_scalar(self, s, p, line, is_key):
        if s[p] in '"\'':
            return self._quoted(s, p, line)
        if s[p] in '&*!':
            raise YamlError(line, '앵커·별칭·태그는 읽지 않는다')
        start = p
        while p < len(s):
            ch = s[p]
            if ch in ',[]{}':
                break
            if ch == ':' and (p + 1 == len(s) or s[p + 1] in ' \t\n,[]{}'):
                break
            if ch == '#' and s[p - 1] in ' \t\n':
                break
            p += 1
        text = ' '.join(x.strip() for x in s[start:p].split('\n') if x.strip())
        return text, p


def yaml_load(text):
    """(값, 중복 키 목록)."""
    r = YamlReader(text)
    return r.parse(), r.dups


# ---------- 0. YAML 중복 키(기술 검토 낮음-027) ----------
def check_yaml(texts, rep):
    """저장소의 .yaml(openapi·asyncapi·buf.yaml)을 읽어 같은 매핑의 같은 키와 읽을 수 없는 줄을 오류로 낸다.

    읽은 값을 {파일: 값}으로 돌려준다(읽지 못한 파일은 None). api 검사가 openapi 값을 쓴다.
    """
    docs = {}
    for f, text in texts.items():
        if not f.endswith('.yaml'):
            continue
        try:
            docs[f], dups = yaml_load(text)
        except YamlError as e:
            rep.err('yaml', '%s:%d' % (f, e.line), '읽을 수 없는 YAML: %s' % e)
            docs[f] = None
            continue
        for line, key, first in dups:
            rep.err('yaml', '%s:%d' % (f, line), "같은 매핑에 키 '%s'가 두 번 있음(처음은 %d줄)" % (key, first))
    rep.info['yaml_files'] = len(docs)
    return docs


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


# ---------- 1의2. FR → 시험 연결(planning/02 §2, 기술 검토 중간-005) ----------
# 시험 행: 첫 칸이 시험 ID(예: Q-T12, FE-T3, **SR-T1**)인 표 행. 그 행 안의 FR 참조를 센다.
TEST_ROW_RE = re.compile(r'^\| (?:\*\*)?([A-Z]{1,3}-T\d+)(?:\*\*)? \|(.*)$')
# FR 참조와 그 뒤에 붙은 묶음(FR-005~008, FR-005~FR-008, FR-026·028~034, FR-001, 002). NFR-은 앞 글자 때문에 빠진다.
FR_TOKEN_RE = re.compile(r'(?<![A-Za-z])FR-(\d{3})((?:\s*(?:~|·|,)\s*(?:FR-)?\d{3}(?!\d))*)')
FR_TRACE_SKIP = ('review/', 'docs/adr/')  # 검토 기록과 ADR 본문은 시험 표가 아니다(tools/는 처음부터 읽지 않는다)


def expand_fr(m):
    """FR_TOKEN_RE 일치 하나를 FR ID 목록으로 펼친다. '~'는 범위, '·'와 ','는 낱개다."""
    first = int(m.group(1))
    out, prev = [first], first
    for sep, num in re.findall(r'\s*(~|·|,)\s*(?:FR-)?(\d{3})(?!\d)', m.group(2)):
        n = int(num)
        if sep == '~':
            out.extend(range(prev + 1, n + 1))
        else:
            out.append(n)
        prev = n
    return ['FR-%03d' % x for x in out]


def check_frtrace(texts, rep):
    req = texts.get('planning/02-requirements.md')
    if req is None:
        rep.err('frtrace', 'planning/02-requirements.md', '정의 파일 없음')
        return
    frs = collections.OrderedDict()  # FR ID → 정의 줄 번호
    for n, line in enumerate(req.split('\n'), 1):
        m = re.match(r'^\| (FR-\d{3}) \|', line)
        if m:
            frs.setdefault(m.group(1), n)
    linked = {f: 0 for f in frs}
    rows = 0
    for f, text in texts.items():
        if not f.endswith('.md') or f.startswith(FR_TRACE_SKIP):
            continue
        for line in strip_fences(text):
            m = TEST_ROW_RE.match(line)
            if not m:
                continue
            rows += 1
            for tm in FR_TOKEN_RE.finditer(m.group(2)):
                for fr in expand_fr(tm):
                    if fr in linked:
                        linked[fr] += 1
    for fr, n in frs.items():
        if not linked[fr]:
            rep.err('frtrace', 'planning/02-requirements.md:%d' % n, '%s를 가리키는 시험 표 행이 없음' % fr)
    rep.info['frtrace'] = {'fr': len(frs), 'linked': sum(1 for v in linked.values() if v), 'test_rows': rows}


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
                 '/v1/settlements': '토스페이먼츠 API(외부)', '/v1/proto/': '프로토타입 전용 가짜 API', '/v1/forensics/': 'ADR-0080 2단계 초안'}


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


# ---------- 4의3. openapi 계약: 호스트·인증·Problem·동시 수정·보고 수(guidelines §10·§12, 기술 검토 낮음-030·031·032) ----------
HTTP_METHODS = ('get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace')
# Problem 본문을 약속하지 않는 오류 응답(guidelines §2·§12의 예외 둘): (메서드, 경로, 코드) → 이유. 정적 파일 404는 아래 규칙으로 따로 본다
PROBLEM_EXEMPT = {('POST', '/v1/scanner/token', '400'): 'RFC 8628·RFC 6749 §5.2 OAuth 오류 본문'}
STATIC_FILE_RE = re.compile(r'\.[a-z]+$')  # 확장자가 붙은 경로 = CDN이 내는 정적 파일(guidelines §10)
# If-Match 없이 마지막 저장이 이기는 자기 상태(guidelines §12 '동시 수정'의 예외 셋): (메서드, 경로) → 이유
IF_MATCH_EXEMPT = {('PUT', '/v1/productions/{productionId}/wish'): '내 찜',
                   ('PUT', '/v1/scanner/shift/readiness'): '그 기기의 근무 준비',
                   ('PATCH', '/v1/reviews/{reviewId}'): '작성자만 고치는 내 후기'}


def check_api_contract(spec, rep):
    where0 = 'docs/api/openapi.yaml'
    if not isinstance(spec, dict) or not isinstance(spec.get('paths'), dict):
        rep.err('api', where0, 'openapi를 읽지 못해 계약 검사를 못 함')
        return
    comp = spec.get('components') or {}
    schemes = set((comp.get('securitySchemes') or {}).keys())
    responses = comp.get('responses') or {}
    rules = ((spec.get('x-peaket-gateways') or {}).get('rules')) or []
    global_sec = spec.get('security')
    for req in global_sec or []:
        for name in (req or {}):
            if name not in schemes:
                rep.err('api', where0 + ' security', '전역 security의 %s가 securitySchemes에 없음' % name)

    def is_problem(r, depth=0):
        if not isinstance(r, dict) or depth > 5:
            return False
        if r.get('$ref'):
            return is_problem(responses.get(r['$ref'].rsplit('/', 1)[-1]), depth + 1)
        content = r.get('content') or {}
        if 'application/problem+json' in content:
            return True
        return any(str(((v or {}).get('schema') or {}).get('$ref', '')).endswith('/Problem') for v in content.values())

    hosts = collections.Counter()
    n = {'operations': 0, 'error_responses': 0, 'problem_responses': 0, 'missing_operation_id': 0,
         'missing_host': 0, 'missing_security': 0, 'public': 0, 'if_match_required': 0, 'if_match_exempt': 0}
    exempt_seen = []
    for path, item in spec['paths'].items():
        if not isinstance(item, dict):
            continue
        for method in HTTP_METHODS:
            op = item.get(method)
            if not isinstance(op, dict):
                continue
            n['operations'] += 1
            M = method.upper()
            where = '%s %s %s' % (where0, M, path)
            if not op.get('operationId'):
                n['missing_operation_id'] += 1
            srv = op.get('servers') or item.get('servers')
            if srv:
                hs = {(s or {}).get('url') for s in srv} - {None}
            else:
                hs = {next((r.get('server') for r in rules if isinstance(r, dict) and path.startswith(str(r.get('prefix')))), None)} - {None}
            if len(hs) == 1:
                hosts[re.sub(r'^https?://|\.peaket\.example$', '', next(iter(hs)))] += 1
            else:
                n['missing_host'] += 1
                rep.err('api', where, '호스트가 하나로 정해지지 않음(x-peaket-gateways 규칙이나 경로 servers, guidelines §10): %s' % (sorted(hs) or '없음'))
            if 'security' in op:
                sec = op.get('security') or []
                if not sec:
                    n['public'] += 1
                for req in sec:
                    for name in (req or {}):
                        if name not in schemes:
                            rep.err('api', where, 'security의 %s가 securitySchemes에 없음' % name)
            else:
                n['missing_security'] += 1
                if not global_sec:
                    rep.err('api', where, 'security가 없고 전역 security도 없음(인증 없는 작업은 security: [], guidelines §10)')
            for code, r in (op.get('responses') or {}).items():
                code = str(code)
                if code[:1] not in ('4', '5'):
                    continue
                n['error_responses'] += 1
                if is_problem(r):
                    n['problem_responses'] += 1
                elif (M, path, code) in PROBLEM_EXEMPT or (code == '404' and STATIC_FILE_RE.search(path)):
                    exempt_seen.append('%s %s %s' % (M, path, code))
                else:
                    rep.err('api', where, '%s 응답이 Problem을 선언하지 않음(guidelines §2·§12)' % code)
            if method in ('put', 'patch'):
                params = list(op.get('parameters') or []) + list(item.get('parameters') or [])
                has = any(isinstance(p, dict) and (str(p.get('$ref', '')).endswith('/IfMatch')
                                                   or (p.get('in') == 'header' and str(p.get('name', '')).lower() == 'if-match'))
                          for p in params)
                codes = {str(c) for c in (op.get('responses') or {})}
                if (M, path) in IF_MATCH_EXEMPT:
                    n['if_match_exempt'] += 1
                elif not has:
                    rep.err('api', where, 'PUT·PATCH에 If-Match(IfMatch 파라미터)가 없음(guidelines §12 동시 수정)')
                else:
                    n['if_match_required'] += 1
                    missing = [c for c in ('412', '428') if c not in codes]
                    if missing:
                        rep.err('api', where, 'If-Match를 받는데 %s 응답을 선언하지 않음(guidelines §12)' % '·'.join(missing))
    counted = rep.info.get('api', {}).get('operations')
    if counted is not None and counted != n['operations']:
        rep.err('api', where0, '작업 수를 줄 규칙(%d)과 YAML 읽기(%d)로 센 값이 다름' % (counted, n['operations']))
    rep.info.setdefault('api', {}).update(n)
    rep.info['api_hosts'] = dict(sorted(hosts.items(), key=lambda x: -x[1]))
    rep.info['api_problem_exempt'] = exempt_seen


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
    'review': 'review/consistency-review.md', 'wbs': 'wbs/wbs.md',
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
    ref_re = re.compile(r'(`?(?:docs/[\w./-]+|planning/[\w.-]+|design/[\w.-]+|review|wbs|0[0-4]-[\w-]+|d[1-5]|[a-z]+-[a-z-]+\.md)`?)\s*§\s*(\d+(?:\.\d+)?)')
    total = 0
    for f, text in texts.items():
        if not f.endswith(('.md', '.yaml')):
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
            m = re.match(r'^\| (v5\.0\.0-[\d.]+) \| ([^|]*?) \| (.*?) \| ', line)
            if not m:
                continue
            where = '%s:%d' % (f, n)
            if m.group(2) not in ('L1', 'L2', 'L3'):
                rep.err('asvs', where, "%s의 레벨 칸이 L1·L2·L3이 아님: '%s'(기술 검토 낮음-089)" % (m.group(1), m.group(2)))
            if m.group(1) in seen and seen[m.group(1)][0] != m.group(3):
                rep.err('asvs', where, '%s의 요구사항 요약이 %s와 다르다' % (m.group(1), seen[m.group(1)][1]))
            seen.setdefault(m.group(1), (m.group(3), where))
    rep.info['asvs_ids'] = len(seen)


# ---------- 6의3. 결정이 많은 ADR의 결정별 현재 판(docs/architecture.md §11·§11.1, 기술 검토 낮음-150) ----------
ADR_TABLE_MIN_DECISIONS = 11   # §11 '결정이 10개를 넘는 ADR'
ADR_TABLE_MIN_STATUS = 1000    # 상태 줄이 이 글자 수를 넘어 바꾼 기록이 쌓인 것(l9 권고: 둘 다일 때만 경고)


def check_adr_tables(texts, rep):
    arch = texts.get('docs/architecture.md', '')
    sec = arch.split('\n### 11.1', 1)[1].split('\n## ', 1)[0] if '\n### 11.1' in arch else ''
    tabled = set(re.findall(r'^ADR-(\d{4})\(', sec, re.M))
    for f, text in texts.items():
        m = re.match(r'docs/adr/(\d{4})-.*\.md$', f)
        if not m:
            continue
        lines = text.split('\n')
        st = next((i for i, l in enumerate(lines) if l.startswith('- **상태**')), None)
        body = re.search(r'^## 결정[^\n]*\n(.*?)(?=^## |\Z)', text, re.M | re.S)
        decisions = len(re.findall(r'^\d+\. ', body.group(1), re.M)) if body else 0
        if st is None or decisions < ADR_TABLE_MIN_DECISIONS or len(lines[st]) <= ADR_TABLE_MIN_STATUS or m.group(1) in tabled:
            continue
        rep.warn('adr', '%s:%d' % (f, st + 1), '결정 %d개·상태 줄 %d자인데 docs/architecture.md §11.1에 결정별 현재 판 표가 없음'
                 % (decisions, len(lines[st])))
    rep.info['adr_decision_tables'] = sorted(tabled)


# ---------- 7. 마커 ----------
def count_markers(texts, rep, out_path=None):
    tot_all = collections.Counter()
    tot_core = collections.Counter()
    lines = []
    for f, text in texts.items():
        c = collections.Counter({k: text.count(k) for k in MARKERS})
        tot_all.update(c)
        if f not in ('00-summary.md', 'review/consistency-review.md', 'review/tech-review.md'):
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
def load_original():
    """원문 설계서 본문. archive/ 폴더가 있으면 거기서, 없으면 git 태그 ORIGINAL_TAG에서 읽는다."""
    d = os.path.join(ROOT, 'archive')
    if os.path.isdir(d):
        arch = sorted(f for f in os.listdir(d) if f.endswith('.md'))
        if arch:
            with io.open(os.path.join(d, arch[0]), encoding='utf-8') as fh:
                return fh.read()
    try:
        names = subprocess.run(['git', '-C', ROOT, 'ls-tree', '-z', '--name-only', ORIGINAL_TAG, 'archive/'],
                               capture_output=True, check=True).stdout.decode('utf-8').split('\0')
        md = sorted(n for n in names if n.endswith('.md'))
        if md:
            return subprocess.run(['git', '-C', ROOT, 'show', '%s:%s' % (ORIGINAL_TAG, md[0])],
                                  capture_output=True, check=True).stdout.decode('utf-8')
    except (OSError, subprocess.CalledProcessError):
        pass
    return None


def check_coverage(texts, rep):
    src = load_original()
    if src is None:
        rep.warn('coverage', ORIGINAL_TAG, '원문 없음(archive/ 폴더도 git 태그 %s도 읽지 못함)' % ORIGINAL_TAG)
        return
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
        rep.warn('coverage', '원문 L%d' % d_urls[u], '원문 링크가 새 문서에 없음 %s' % u)
    tok_re = re.compile(r'(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9+#_.\-]*[A-Za-z0-9+#]')
    low = url_re.sub(' ', nall).lower()
    toks = collections.OrderedDict()
    for n, line in enumerate(url_re.sub(' ', src).split('\n'), 1):
        for tk in tok_re.findall(line):
            if len(tk) >= 3:
                toks.setdefault(tk, n)
    mt = [tk for tk in toks if tk.lower() not in low]
    for tk in mt:
        rep.warn('coverage', '원문 L%d' % toks[tk], '원문 영문 용어가 새 문서에 없음 %s' % tk)
    rep.info['coverage'] = {'urls': len(d_urls), 'urls_missing': len(miss), 'terms': len(toks), 'terms_missing': len(mt)}


def main():
    ap = argparse.ArgumentParser(description='PEAKET 문서 점검')
    ap.add_argument('--strict', action='store_true', help='경고도 실패로 처리')
    ap.add_argument('--json', action='store_true', help='JSON으로 출력')
    ap.add_argument('--coverage', action='store_true', help='원문 설계서(git 태그 archive-original) 대조(링크·영문 용어)도 실행')
    ap.add_argument('--markers-out', help='마커가 있는 줄 목록을 이 파일에 씀')
    a = ap.parse_args()
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    rep = Report()
    texts = load_files()
    yaml_docs = check_yaml(texts, rep)
    check_ids(texts, rep)
    check_frtrace(texts, rep)
    check_tables_fences(texts, rep)
    check_paths(texts, rep)
    check_api(texts, rep)
    check_api_contract(yaml_docs.get('docs/api/openapi.yaml'), rep)
    check_secrefs(texts, rep)
    check_artifacts(texts, rep)
    check_asvs(texts, rep)
    check_adr_tables(texts, rep)
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
