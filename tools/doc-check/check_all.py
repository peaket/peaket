"""PEAKET 문서 점검: YAML 중복 키, ID 참조, FR→시험 연결, 표, 펜스, 경로와 링크(절대 경로·대상 파일·위치 표시),
REST 경로 규칙과 openapi 계약, 절 번호 참조, 작업 흔적, ASVS 표, 차단 조건 목록 대조, 결정이 많은 ADR의 결정별 표,
마커, WBS 일치, 기획 버전, mermaid 그림.

사용법: python tools/doc-check/check_all.py [--strict] [--json] [--coverage] [--markers-out FILE]
종료 코드: 0 = 오류 없음, 1 = 오류 있음(--strict면 경고도 오류로 봄), 2 = 실행 실패.
표준 라이브러리만 쓴다(Python 3.10 이상). mermaid 문법 검사만 node와 tools/doc-check/mermaid의 의존성을 쓰고,
없으면 경고를 내고 건너뛴다. 규칙과 예외는 tools/doc-check/README.md.
"""
import argparse
import collections
import csv
import html
import io
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
import urllib.parse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
# 원문 설계서는 2026-10-27 archive/에서 지웠고 이 git 태그에만 남는다(ADR-0098). --coverage가 여기서 읽는다.
ORIGINAL_TAG = 'archive-original'
SCAN_EXT = ('.md', '.yaml', '.json', '.csv')
SKIP_DIRS = {'archive', 'tools', '.git', 'node_modules'}
# pnpm이 만드는 잠금 파일은 문서가 아니다. pnpm 12의 잠금 파일은 YAML 문서 두 개를 `---`로 이어 붙여
# 이 도구의 YAML 읽개가 한 매핑으로 읽고, 검사는 pnpm의 공급망 검사가 한다(ADR-0167, R-196)
SKIP_FILES = {'pnpm-lock.yaml'}
# drizzle-kit이 만드는 마이그레이션 메타(migrations/meta/*.json)도 문서가 아니다. 첫 스냅숏의 prevId가 0 UUID라 '12자리 숫자' 규칙에 걸린다(R-235)
SKIP_PATH_PARTS = ('/migrations/meta/',)
ID_KINDS = ('FR', 'NFR', 'POL', 'SCR', 'CMP', 'ADR')
MARKERS = ('[가정', '[충돌', '[보완')
# 존재하지 않아도 되는 경로: 외부 URL 안의 경로 문자열이라 오탐(review R-10),
# 없앤 문서인데 고치지 않는 지난 기록(ADR 본문, review의 지난 행)이 가리키는 경로(ADR-0090, review R-105).
# docs/guide/README.md는 2026-11-01 소유자가 지운 쉬운 설명서이고, 00-summary §4의 신설 기록이 가리킨다(ADR-0177)
ALLOW_PATHS = {'docs/software-architecture.md', 'docs/arc42.md', 'docs/appendix-learning-map.md', 'docs/guide/README.md'}


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
            if f.endswith(SCAN_EXT) and f not in SKIP_FILES:
                p = os.path.join(dp, f)
                if any(part in '/' + rel(p) for part in SKIP_PATH_PARTS):
                    continue
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
    charts = {f.rsplit('/', 1)[0] for f in texts if f.endswith('/Chart.yaml')}
    for f, text in texts.items():
        if not f.endswith('.yaml'):
            continue
        # Helm 차트의 templates/는 렌더하기 전에는 YAML이 아니다(Go 틀). 렌더 결과는 tools/local/chart.test.mjs가 본다
        if '/templates/' in f and f.split('/templates/', 1)[0] in charts:
            continue
        values = []
        for offset, part in split_yaml_docs(text):
            try:
                value, dups = yaml_load(part)
            except YamlError as e:
                rep.err('yaml', '%s:%d' % (f, e.line + offset), '읽을 수 없는 YAML: %s' % e)
                values = None
                break
            for line, key, first in dups:
                rep.err('yaml', '%s:%d' % (f, line + offset), "같은 매핑에 키 '%s'가 두 번 있음(처음은 %d줄)" % (key, first + offset))
            values.append(value)
        # 문서가 하나면 예전처럼 그 값, 여럿(쿠버네티스 매니페스트)이면 목록
        docs[f] = None if values is None else (values[0] if len(values) == 1 else values)
    rep.info['yaml_files'] = len(docs)
    return docs


def split_yaml_docs(text):
    """`---` 줄로 나눈 (앞선 줄 수, 글) 목록. 주석·빈 줄만 있는 조각은 뺀다(한 문서 파일은 조각 하나)."""
    parts, buf, start = [], [], 0
    for n, line in enumerate(text.split('\n')):
        if line.rstrip() == '---' or line.startswith('--- '):
            parts.append((start, '\n'.join(buf)))
            buf, start = [], n + 1
        else:
            buf.append(line)
    parts.append((start, '\n'.join(buf)))
    real = [p for p in parts if any(l.strip() and not l.strip().startswith('#') for l in p[1].split('\n'))]
    return real or [(0, text)]


# ---------- 1. ID 정의와 참조 ----------
def check_ids(texts, rep):
    t = texts
    need = ['docs/planning/02-requirements.md', 'docs/planning/03-policies-glossary.md', 'docs/planning/04-ia-flows-screens.md', 'docs/design/d2-design-system.md']
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


# ---------- 1의2. FR → 시험 연결(docs/planning/02 §2, 기술 검토 중간-005) ----------
# 시험 행: 첫 칸이 시험 ID(예: Q-T12, FE-T3, **SR-T1**)인 표 행. 그 행 안의 FR 참조를 센다.
TEST_ROW_RE = re.compile(r'^\| (?:\*\*)?([A-Z]{1,3}-T\d+)(?:\*\*)? \|(.*)$')
# FR 참조와 그 뒤에 붙은 묶음(FR-005~008, FR-005~FR-008, FR-026·028~034, FR-001, 002). NFR-은 앞 글자 때문에 빠진다.
FR_TOKEN_RE = re.compile(r'(?<![A-Za-z])FR-(\d{3})((?:\s*(?:~|·|,)\s*(?:FR-)?\d{3}(?!\d))*)')
FR_TRACE_SKIP = ('docs/review/', 'docs/adr/')  # 검토 기록과 ADR 본문은 시험 표가 아니다(tools/는 처음부터 읽지 않는다)


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
    req = texts.get('docs/planning/02-requirements.md')
    if req is None:
        rep.err('frtrace', 'docs/planning/02-requirements.md', '정의 파일 없음')
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
            rep.err('frtrace', 'docs/planning/02-requirements.md:%d' % n, '%s를 가리키는 시험 표 행이 없음' % fr)
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
            # 링크 대상은 링크 검사(4의1)가 링크가 있는 파일 기준으로 본다. 여기서 저장소 기준으로 읽으면 틀린다
            if f.endswith('.md'):
                line = LINK_RE.sub(lambda m: m.group(0)[:m.start(2) - m.start()] + m.group(0)[m.end(2) - m.start():], line)
            for m in path_re.finditer(line):
                p = m.group(1)
                if os.path.exists(os.path.join(ROOT, p)) or p in ALLOW_PATHS:
                    continue
                # 2026-10-30 전 ADR 본문의 옛 경로(planning/… 등)는 docs/ 아래를 뜻한다. 본문은 고치지 않는다(ADR-0168)
                if f.startswith('docs/adr/') and os.path.exists(os.path.join(ROOT, 'docs', p)):
                    continue
                if '예정' in line:
                    rep.warn('paths', '%s:%d' % (f, n), '예정 문서 %s' % p)
                else:
                    rep.err('paths', '%s:%d' % (f, n), '없는 경로 %s' % p)


# ---------- 4의1. 링크: 절대 경로, 대상 파일, 위치 표시(docs/review/open-items.md 32번, 소유자 결정 2026-10-30) ----------
# 위 경로 검사는 저장소 기준 경로 글자만 보므로 `file:///d:/…` 안의 경로와 상대 링크(`../planning/…`), `#제목`을 보지 않았다.
CODE_SPAN_RE = re.compile(r'(`+)(.+?)\1')
# 마크다운 인라인 링크 [글](대상 "제목")와 참조 정의 [이름]: 대상. 그림 ![글](대상)도 같은 꼴이다
LINK_RE = re.compile(r'!?\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|\'[^\']*\'))?\s*\)')
LINK_DEF_RE = re.compile(r'^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)')
# 이 컴퓨터에서만 열리는 절대 경로: file: 주소(뒤에 경로 글자가 붙은 것만. 코드 표시 안의 `file:///`와, 경로 없이 'file:/// 링크'처럼
# 말로 가리킨 것은 빠진다. review R-106 행이 그렇다)와 드라이브 경로(D:/…)
FILE_URL_RE = re.compile(r'(?<![\w])file:/{1,3}[^\s/`\'")\]>|]', re.I)
DRIVE_PATH_RE = re.compile(r'^[A-Za-z]:[\\/]')
URL_SCHEME_RE = re.compile(r'^[A-Za-z][A-Za-z0-9+.-]*:')
# 파일·폴더를 가리키는 대상만 본다. 화면 설계의 버튼 표기 '[ 승인 ](재인증)'은 링크 꼴이지만 대상이 낱말이라 빠진다
LINK_FILE_RE = re.compile(r'\.(?:md|yaml|yml|json|csv|py|mjs|js|html|txt|proto|png|svg|jpe?g|gif|webp|pdf|bat)$|/$', re.I)
HEADING_LINE_RE = re.compile(r'^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$')
HTML_ANCHOR_RE = re.compile(r'<a\s+(?:[^>]*\s)?(?:id|name)=["\']([^"\']+)["\']', re.I)
# 위치 표시가 맞지 않아도 되는 링크: (링크가 있는 파일, 링크 대상 글자) → 이유.
# 고치지 않는 지난 기록(ADR 본문, review의 지난 행)이 그 뒤 바뀐 제목을 가리킬 때만 넣는다(ALLOW_PATHS와 같은 방식). 지금은 없다
ALLOW_ANCHORS = {}


def gh_slug(text):
    """GitHub가 제목에 붙이는 위치 표시(id). 제목을 화면 글자로 바꾼 뒤 소문자로 하고, 문자·결합 부호·십진 숫자·밑줄·하이픈·빈칸만
    남기고, 빈칸 하나를 '-' 하나로 바꾼다(빈칸을 합치지 않는다). 한국어 글자는 그대로 남는다. 같은 제목의 뒷번호는 heading_ids가 붙인다.
    저장소 제목 2,041개(겹치지 않는 것)를 GitHub Markdown API로 그려 받은 id와 모두 같았다(2026-10-30)."""
    out, pos = [], 0

    def plain(s):
        s = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', s)          # 그림은 화면 글자가 없다
        s = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', s)       # 링크는 글만 남는다
        s = re.sub(r'<[^>]+>', '', s)                         # HTML 태그
        s = re.sub(r'\\([!-/:-@\[-`{-~])', r'\1', s)         # 역슬래시로 푼 문장 부호
        s = re.sub(r'\*+|(?<!\w)_+|_+(?!\w)', '', s)          # 강조 표시(낱말 안의 밑줄은 남긴다)
        return html.unescape(s)

    for m in CODE_SPAN_RE.finditer(text):
        out.append(plain(text[pos:m.start()]))
        c = m.group(2)
        if len(c) > 1 and c[0] == ' ' and c[-1] == ' ' and c.strip():
            c = c[1:-1]
        out.append(c)                                         # 코드 표시 안은 글자 그대로
        pos = m.end()
    out.append(plain(text[pos:]))
    s = ''.join(out).strip().lower()
    # 남기는 글자: 문자(L)·결합 부호(M)·십진 숫자(Nd)·연결 부호(Pc, 밑줄). ②·²·½ 같은 다른 숫자는 지운다(GitHub 렌더링으로 확인 2026-10-30)
    s = ''.join(ch for ch in s if ch in ' -' or unicodedata.category(ch)[0] in 'LM' or unicodedata.category(ch) in ('Nd', 'Pc'))
    return s.replace(' ', '-')


def heading_ids(path, texts, cache={}):
    """문서 제목들의 위치 표시 집합. 같은 표시가 또 나오면 -1, -2를 붙인다(GitHub와 같은 순서). 코드 펜스 안은 제목이 아니다.
    점검 대상이 아닌 파일(tools/ 아래 등)은 디스크에서 읽는다."""
    if path not in cache:
        ids, seen = set(), {}
        if path in texts:
            lines = strip_fences(texts[path])
        else:
            with io.open(os.path.join(ROOT, path), encoding='utf-8') as fh:
                lines = strip_fences(fh.read())
        for l in lines:
            ids.update(HTML_ANCHOR_RE.findall(l))
            m = HEADING_LINE_RE.match(l)
            if not m:
                continue
            title = re.sub(r'(?:^|[ \t]+)#+[ \t]*$', '', m.group(2).strip()).strip()  # 닫는 # 줄
            base = slug = gh_slug(title)
            while slug in seen:
                seen[base] += 1
                slug = '%s-%d' % (base, seen[base])
            seen[slug] = 0
            ids.add(slug)
        cache[path] = ids
    return cache[path]


def exists_exact(relpath, cache={}):
    """대소문자까지 같은 파일·폴더가 있는가(Windows에서도 GitHub처럼 본다)."""
    cur = ROOT
    for part in [p for p in relpath.split('/') if p]:
        if cur not in cache:
            cache[cur] = set(os.listdir(cur)) if os.path.isdir(cur) else set()
        if part not in cache[cur]:
            return False
        cur = os.path.join(cur, part)
    return True


def check_links(texts, rep):
    n = collections.Counter()
    for f, text in texts.items():
        md = f.endswith('.md')
        lines = strip_fences(text) if md else text.split('\n')
        for no, raw in enumerate(lines, 1):
            if not raw or ('](' not in raw and ':' not in raw):
                continue
            line = CODE_SPAN_RE.sub(lambda m: ' ' * len(m.group(0)), raw)  # 코드 표시 안의 예시는 링크가 아니다
            where = '%s:%d' % (f, no)
            for m in FILE_URL_RE.finditer(line):
                n['absolute'] += 1
                shown = re.split(r'[\s)>\]]', line[m.start():m.start() + 60])[0]
                rep.err('paths', where, "절대 경로 링크 '%s'(이 컴퓨터에서만 열린다). 저장소 안 상대 경로로 쓴다" % shown)
            targets = [m.group(2) for m in LINK_RE.finditer(line)]
            d = LINK_DEF_RE.match(line)
            if d:
                targets.append(d.group(1))
            for t in targets:
                t = t.strip('<>').strip()
                if DRIVE_PATH_RE.match(t):
                    n['absolute'] += 1
                    rep.err('paths', where, "절대 경로 링크 '%s'(이 컴퓨터에서만 열린다). 저장소 안 상대 경로로 쓴다" % t[:60])
                    continue
                if not t or URL_SCHEME_RE.match(t):
                    continue  # 바깥 주소(https·mailto)와 file:(위에서 봄)
                path, hashmark, frag = t.partition('#')
                path, frag = urllib.parse.unquote(path), urllib.parse.unquote(frag)
                if path and not LINK_FILE_RE.search(path):
                    continue
                n['links'] += 1
                if path:
                    full = os.path.normpath(os.path.join(ROOT, path.lstrip('/')) if path.startswith('/')
                                            else os.path.join(ROOT, os.path.dirname(f), path))
                    tgt = rel(full)
                    if tgt.startswith('../') or tgt == '..':
                        rep.err('paths', where, '저장소 밖을 가리키는 링크 %s' % t)
                        continue
                    if not exists_exact(tgt) and tgt not in ALLOW_PATHS:
                        n['missing'] += 1
                        if '예정' in raw:
                            rep.warn('paths', where, '예정 문서 링크 %s' % t)
                        else:
                            rep.err('paths', where, '없는 링크 대상 %s(%s)' % (t, tgt))
                        continue
                else:
                    tgt = f
                if not hashmark or not frag:
                    continue
                n['anchors'] += 1
                if not tgt.endswith('.md') or not (tgt in texts or os.path.isfile(os.path.join(ROOT, tgt))):
                    n['anchors_not_md'] += 1  # 마크다운이 아닌 파일의 위치 표시(openapi의 #/components 등)는 보지 않는다
                    continue
                if frag in heading_ids(tgt, texts) or (f, t) in ALLOW_ANCHORS:
                    continue
                n['bad_anchors'] += 1
                rep.err('paths', where, '위치 표시 #%s: %s에 이 표시로 바뀌는 제목이 없음(GitHub 방식 제목 변환: 소문자, 빈칸은 -, 문장 부호 제거, 같은 제목은 -1·-2)'
                        % (frag, tgt))
    rep.info['links'] = {k: n[k] for k in ('links', 'anchors', 'anchors_not_md', 'missing', 'bad_anchors', 'absolute')}


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
        if f.startswith(('docs/adr/', 'docs/review/')) or f == 'docs/api/openapi.yaml':
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
                   ('PATCH', '/v1/reviews/{reviewId}'): '작성자만 고치는 내 후기',
                   ('PATCH', '/v1/identity/profile'): '내 프로필',
                   ('PUT', '/v1/identity/consents/{kind}'): '내 선택 동의'}


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


def each_operation(spec):
    for path, item in (spec.get('paths') or {}).items():
        if not isinstance(item, dict):
            continue
        for method in HTTP_METHODS:
            op = item.get(method)
            if isinstance(op, dict):
                yield method, path, op


# ---------- 4의3의1. 작업 이름(operationId, docs/api/guidelines.md §10 '작업 이름', BUILD_ORDER BAS-040) ----------
# orval이 이 이름으로 계약 Zod·타입과 api-client의 호출 함수·훅을 만든다. 동사는 메서드로 정한다
OPERATION_VERBS = {'get': ('get', 'list'), 'post': ('create', 'receive'), 'put': ('put',), 'patch': ('update',), 'delete': ('delete',)}
OPERATION_ID_RE = re.compile(r'^[a-z]+[A-Z][A-Za-z0-9]*$')


def check_operation_ids(spec, rep):
    where0 = 'docs/api/openapi.yaml'
    if not isinstance(spec, dict) or not isinstance(spec.get('paths'), dict):
        rep.err('api', where0, 'openapi를 읽지 못해 작업 이름을 검사하지 못함')
        return
    seen = {}
    n = 0
    for method, path, op in each_operation(spec):
        where = '%s %s %s' % (where0, method.upper(), path)
        oid = op.get('operationId')
        if not oid:
            rep.err('api', where, '%s %s: operationId가 없음(guidelines §10 \'작업 이름\')' % (method.upper(), path))
            continue
        n += 1
        if oid in seen:
            rep.err('api', where, '%s %s: operationId %s가 겹침(%s, guidelines §10)' % (method.upper(), path, oid, seen[oid]))
        seen.setdefault(oid, '%s %s' % (method.upper(), path))
        verbs = OPERATION_VERBS.get(method)
        if not verbs:
            rep.err('api', where, '%s %s: 작업 이름 동사를 정하지 않은 메서드(guidelines §10)' % (method.upper(), path))
            continue
        if not OPERATION_ID_RE.match(str(oid)) or not any(re.match(r'^%s[A-Z]' % v, str(oid)) for v in verbs):
            rep.err('api', where, '%s %s: operationId %s는 %s로 시작하는 camelCase여야 함(guidelines §10)' % (method.upper(), path, oid, '·'.join(verbs)))
    rep.info.setdefault('api', {})['operation_ids'] = n


# ---------- 4의3의2. 오류 목록(x-peaket-problem-types, docs/api/guidelines.md §2, BUILD_ORDER BAS-040) ----------
# 한 type은 언제나 같은 상태 코드와 제목으로 낸다. 오류 응답 설명에 적힌 케밥 이름은 목록에 있어야 한다.
# 오류 이름이 아닌 케밥 낱말(서비스·게이트웨이·머리 이름, 캐시 지시어, 사유 값, 문서 이름)은 아래에서 거른다
PROBLEM_NAME_RE = re.compile(r'^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$|^[a-z][a-z0-9]*$')
PROBLEM_TOKEN_RE = re.compile(r'(?<![A-Za-z0-9_./{:-])([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?![A-Za-z0-9_/}-]|\.[A-Za-z0-9])')
PROBLEM_UPPER_RE = re.compile(r'(?<![A-Za-z0-9_])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?![A-Za-z0-9_])')
PROBLEM_NON_TYPE_RE = re.compile(r'-svc$|^gw-|^x-|-ctrl$|-worker$')
PROBLEM_NON_TYPE_WORDS = {
    'auth-controls', 'open-items',            # 문서 이름
    'max-age', 'no-store', 'stale-if-error', 'stale-while-revalidate',  # 캐시 지시어
    'ip-literal', 'private-address',          # webhook-url-not-allowed의 사유(reason) 값
}


def check_problem_types(spec, rep):
    where0 = 'docs/api/openapi.yaml'
    if not isinstance(spec, dict) or not isinstance(spec.get('paths'), dict):
        rep.err('api', where0, 'openapi를 읽지 못해 오류 목록을 검사하지 못함')
        return
    types = ((spec.get('x-peaket-problem-types') or {}).get('types')) or {}
    if not isinstance(types, dict) or not types:
        rep.err('api', where0 + ' x-peaket-problem-types', '오류 목록(x-peaket-problem-types.types)이 없음(guidelines §2)')
        return
    status_of = {}
    for name, t in types.items():
        w = '%s x-peaket-problem-types.%s' % (where0, name)
        t = t if isinstance(t, dict) else {}
        st, title = t.get('status'), t.get('title')
        # 문서 점검은 YAML 값을 글자로 읽는다(check_yaml). 숫자 글자도 받는다
        st = int(st) if isinstance(st, str) and st.isdigit() else st
        bad = []
        if not PROBLEM_NAME_RE.match(str(name)):
            bad.append('이름은 소문자 케밥 표기')
        if not isinstance(st, int) or isinstance(st, bool) or not 400 <= st <= 599:
            bad.append('status는 400~599의 정수')
        if not isinstance(title, str) or not title.strip():
            bad.append('title이 있어야 함')
        if bad:
            rep.err('api', w, '오류 목록 항목 %s: %s(guidelines §2)' % (name, ', '.join(bad)))
        status_of[name] = st
    for method, path, op in each_operation(spec):
        for code, r in (op.get('responses') or {}).items():
            code = str(code)
            if code[:1] not in ('4', '5') or not isinstance(r, dict):
                continue
            d = str(r.get('description') or '')
            where = '%s %s %s %s' % (where0, method.upper(), path, code)
            for tok in sorted(set(PROBLEM_TOKEN_RE.findall(d))):
                if tok in PROBLEM_NON_TYPE_WORDS or PROBLEM_NON_TYPE_RE.search(tok):
                    continue
                if tok not in status_of:
                    rep.err('api', where, '오류 응답 설명의 %s가 목록(x-peaket-problem-types)에 없음(오류 이름이면 목록에 더하고, 아니면 check_all.py PROBLEM_NON_TYPE_WORDS에 더한다)' % tok)
                elif str(status_of[tok]) != code:
                    rep.warn('api', where, '%s는 목록에서 %s인데 %s 응답 설명에 적힘(대비 설명이 아니면 고친다, guidelines §2)' % (tok, status_of[tok], code))
            for tok in sorted(set(PROBLEM_UPPER_RE.findall(d))):
                name = tok.lower().replace('_', '-')
                if name in status_of and str(status_of[name]) != code:
                    rep.warn('api', where, '%s(%s)는 목록에서 %s인데 %s 응답 설명에 적힘(guidelines §2)' % (tok, name, status_of[name], code))
    rep.info.setdefault('api', {})['problem_types'] = len(types)


# ---------- 4의3의3. 칸 닫힘(docs/api/guidelines.md §1, docs/security/authz-matrix.md '요청 스키마는 허용한 칸만', BUILD_ORDER BAS-040) ----------
# 요청 본문에서 닿는 객체는 정의 밖 칸을 거절하게 닫고(additionalProperties: false), 응답에서 닿는 객체는 열어 둔다
# (응답에 칸을 더해도 옛 화면이 거절하지 않게). 둘 다에서 닿는 객체 스키마는 요청용과 나눈다. 맵(additionalProperties에
# 스키마)은 닫지 않아도 되고, 일부러 연 객체는 x-peaket-open-object에 이유를 적는다. 요청 본문은 allOf로 잇지 않는다
# (칸이 다른 조각에 있어 닫을 수 없다).
OPEN_OBJECT_KEY = 'x-peaket-open-object'


def _is_object_schema(s):
    return isinstance(s, dict) and (s.get('type') == 'object' or 'properties' in s)


def _is_false(v):
    # 문서 점검은 YAML 값을 글자로 읽는다(check_yaml). 시험은 safe_load로 읽어 bool이다
    return v is False or v == 'false'


def check_schema_closure(spec, rep):
    where0 = 'docs/api/openapi.yaml'
    if not isinstance(spec, dict) or not isinstance(spec.get('paths'), dict):
        rep.err('api', where0, 'openapi를 읽지 못해 칸 닫힘을 검사하지 못함')
        return
    comps = ((spec.get('components') or {}).get('schemas')) or {}

    def ref_name(s):
        return str(s['$ref']).rsplit('/', 1)[-1]

    # 1단계: 구성 요소마다 요청·응답 어느 쪽에서 닿는지
    sides = collections.defaultdict(set)

    def mark(s, side, seen):
        if isinstance(s, dict):
            if '$ref' in s:
                name = ref_name(s)
                sides[name].add(side)
                if name not in seen:
                    mark(comps.get(name), side, seen | {name})
                return
            for v in s.values():
                mark(v, side, seen)
        elif isinstance(s, list):
            for v in s:
                mark(v, side, seen)

    allc = spec.get('components') or {}

    def resolved(obj, kind):
        # 작업이 components/requestBodies·responses를 가리키면 그것을 읽는다
        if isinstance(obj, dict) and isinstance(obj.get('$ref'), str) and '/%s/' % kind in obj['$ref']:
            return (allc.get(kind) or {}).get(ref_name(obj)) or {}
        return obj if isinstance(obj, dict) else {}

    bodies = []
    json_bodies = 0
    for method, path, op in each_operation(spec):
        where = '%s %s' % (method.upper(), path)
        content = (resolved(op.get('requestBody'), 'requestBodies').get('content')) or {}
        if 'application/json' in content:
            json_bodies += 1
        for c in content.values():
            if isinstance(c, dict) and c.get('schema') is not None:
                bodies.append((where, 'req', c['schema']))
                mark(c['schema'], 'req', set())
        for code, r in (op.get('responses') or {}).items():
            for c in (resolved(r, 'responses').get('content') or {}).values():
                if isinstance(c, dict) and c.get('schema') is not None:
                    bodies.append((where, 'resp', c['schema']))
                    mark(c['schema'], 'resp', set())
    shared = {n for n, s in sides.items() if s == {'req', 'resp'} and _is_object_schema(comps.get(n))}
    for n in sorted(shared):
        rep.err('api', '%s components/schemas/%s' % (where0, n),
                '요청과 응답이 함께 쓰는 객체 스키마 %s: 요청용(%sInput, 닫힘)과 나눈다(guidelines §1)' % (n, n))

    # 2단계: 닫힘 검사(나눌 구성 요소 안으로는 들어가지 않는다)
    reported = set()

    def report(key, where, msg):
        if key not in reported:
            reported.add(key)
            rep.err('api', where, msg)

    def walk(s, side, where, trail, comp, seen):
        if not isinstance(s, dict):
            return
        if '$ref' in s:
            name = ref_name(s)
            if name in shared or (name, side) in seen:
                return
            walk(comps.get(name), side, where, [], name, seen | {(name, side)})
            return
        at = ('components/schemas/%s' % comp if comp else where + ' 본문') + ('/' + '/'.join(trail) if trail else '')
        if side == 'req' and s.get('allOf'):
            report(('allOf', at), '%s %s' % (where0, at), '%s: 요청 본문 스키마를 allOf로 잇지 않는다(칸이 다른 조각에 있어 닫을 수 없다, 요청용 스키마를 따로 둔다)' % at)
            return
        if _is_object_schema(s):
            ap = s.get('additionalProperties')
            if side == 'req' and not _is_false(ap) and not isinstance(ap, dict) and OPEN_OBJECT_KEY not in s:
                report(('req', at), '%s %s' % (where0, at),
                       '%s: 요청 본문에서 닿는 객체가 닫혀 있지 않음(additionalProperties: false. 맵이면 additionalProperties에 스키마, 일부러 열면 %s에 이유, guidelines §1)' % (at, OPEN_OBJECT_KEY))
            if side == 'resp' and _is_false(ap):
                report(('resp', at), '%s %s' % (where0, at),
                       '%s: 응답에서 닿는 객체가 닫혀 있음(응답에 칸을 더하면 옛 화면이 거절한다, guidelines §1 \'응답 칸 추가는 깨짐 아님\')' % at)
        for pn, ps in (s.get('properties') or {}).items():
            walk(ps, side, where, trail + [str(pn)], comp, seen)
        if isinstance(s.get('items'), dict):
            walk(s['items'], side, where, trail + ['[]'], comp, seen)
        if isinstance(s.get('additionalProperties'), dict):
            walk(s['additionalProperties'], side, where, trail + ['{}'], comp, seen)
        # 스키마 하나를 담는 키(text/plain의 JSON 글자는 contentSchema, JSON Schema 2020-12)
        for k in ('contentSchema', 'not', 'if', 'then', 'else'):
            if isinstance(s.get(k), dict):
                walk(s[k], side, where, trail + [k], comp, seen)
        # 이름마다 스키마를 담는 키
        for k in ('patternProperties', 'dependentSchemas'):
            for pn, ps in (s.get(k) or {}).items() if isinstance(s.get(k), dict) else []:
                walk(ps, side, where, trail + ['%s(%s)' % (k, pn)], comp, seen)
        for k in ('allOf', 'oneOf', 'anyOf', 'prefixItems'):
            for i, x in enumerate(s.get(k) or []):
                walk(x, side, where, trail + ['%s%d' % (k, i)], comp, seen)

    for where, side, schema in bodies:
        walk(schema, side, where, [], None, frozenset())
    rep.info.setdefault('api', {})['json_request_bodies'] = json_bodies
    rep.info['api']['shared_object_schemas'] = len(shared)


# ---------- 4의4. 작업별 허용 역할(x-peaket-roles, docs/security/authz-matrix.md §5.5, open-items 71번) ----------
# 허용 역할 값의 정본은 권한 표 §5.5의 표 하나다. 첫 칸이 `값`인 행에서 값, '알아보는 자격', '함께 오는 자격'을 읽는다.
# 자격 칸의 코드 표시 가운데 securitySchemes의 이름은 인증 방식이고, `{}`는 빈 요구(공개)다.
ROLE_DOC = 'docs/security/authz-matrix.md'
ROLE_SEC = '5.5'
ROLE_KEY = 'x-peaket-roles'
ROLE_ROW_RE = re.compile(r'^\| `([a-z][a-z0-9_]*)` \|')


def role_catalog(texts, schemes):
    """{값: (알아보는 자격 set, 함께 오는 자격 set, 빈 요구와 맞는지)}와 (시작 줄)."""
    start, sl = section_lines(texts.get(ROLE_DOC, ''), ROLE_SEC)
    cat = {}
    for line in sl:
        m = ROLE_ROW_RE.match(line)
        if not m:
            continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) < 4:
            continue
        ident = re.findall(r'`([^`]+)`', cells[2])
        comp = re.findall(r'`([^`]+)`', cells[3])
        cat[m.group(1)] = ({x for x in ident if x in schemes}, {x for x in comp if x in schemes}, '{}' in ident)
    return cat, start


def check_roles(texts, spec, rep):
    where0 = 'docs/api/openapi.yaml'
    if not isinstance(spec, dict) or not isinstance(spec.get('paths'), dict):
        rep.err('roles', where0, 'openapi를 읽지 못해 허용 역할을 검사하지 못함')
        return
    schemes = set(((spec.get('components') or {}).get('securitySchemes') or {}).keys())
    cat, start = role_catalog(texts, schemes)
    if not cat:
        rep.err('roles', ROLE_DOC, "허용 역할 값 표(§%s, 첫 칸이 `값`인 행)를 찾지 못함(tools/doc-check/check_all.py ROLE_DOC·ROLE_SEC를 고친다)" % ROLE_SEC)
        return
    listed = set().union(*[a | b for a, b, _ in cat.values()])
    for s in sorted(schemes - listed):
        rep.err('roles', '%s:%d' % (ROLE_DOC, start), '인증 방식 %s를 받을 역할 값이 §%s 표에 없음' % (s, ROLE_SEC))

    def matches(req, role):
        ident, comp, public = cat[role]
        if not req:
            return public
        return bool(req & ident) and req <= ident | comp

    global_sec = spec.get('security')
    per_role = collections.Counter()
    n = {'operations': 0, 'with_roles': 0}
    for path, item in spec['paths'].items():
        if not isinstance(item, dict):
            continue
        for method in HTTP_METHODS:
            op = item.get(method)
            if not isinstance(op, dict):
                continue
            n['operations'] += 1
            where = '%s %s %s' % (where0, method.upper(), path)
            roles = op.get(ROLE_KEY)
            if roles is None:
                rep.err('roles', where, '%s가 없음(공개 작업은 [public], docs/security/authz-matrix.md §5.5)' % ROLE_KEY)
                continue
            if not isinstance(roles, list) or not roles or not all(isinstance(r, str) and r for r in roles):
                rep.err('roles', where, '%s가 값이 하나 이상인 목록이 아님: %r' % (ROLE_KEY, roles))
                continue
            n['with_roles'] += 1
            dup = sorted({r for r in roles if roles.count(r) > 1})
            if dup:
                rep.err('roles', where, '%s에 같은 값이 두 번 있음: %s' % (ROLE_KEY, ', '.join(dup)))
            unknown = [r for r in roles if r not in cat]
            if unknown:
                rep.err('roles', where, '%s에 §%s 표에 없는 값: %s' % (ROLE_KEY, ROLE_SEC, ', '.join(unknown)))
            known = [r for r in dict.fromkeys(roles) if r in cat]
            for r in known:
                per_role[r] += 1
            sec = op['security'] if 'security' in op else global_sec
            reqs = [set((q or {}).keys()) for q in (sec or [{}])]
            for q in reqs:
                if known and not any(matches(q, r) for r in known):
                    rep.err('roles', where, 'security 요구 %s를 받을 값이 %s에 없음' % ('{' + ', '.join(sorted(q)) + '}', ROLE_KEY))
            for r in known:
                if not any(matches(q, r) for q in reqs):
                    rep.err('roles', where, "%s의 '%s'가 이 작업의 security와 맞지 않음(§%s 표의 자격)" % (ROLE_KEY, r, ROLE_SEC))
    n['per_role'] = {r: per_role[r] for r in cat}
    rep.info['roles'] = n


# ---------- 5. 절 번호 참조 ----------
ALIAS = {
    '01-overview': 'docs/planning/01-overview.md', '02-requirements': 'docs/planning/02-requirements.md',
    '03-policies': 'docs/planning/03-policies-glossary.md', '04-ia': 'docs/planning/04-ia-flows-screens.md',
    '04-ia-flows-screens': 'docs/planning/04-ia-flows-screens.md',
    'planning/01': 'docs/planning/01-overview.md', 'planning/02': 'docs/planning/02-requirements.md',
    'planning/03': 'docs/planning/03-policies-glossary.md', 'planning/04': 'docs/planning/04-ia-flows-screens.md',
    'design/d1': 'docs/design/d1-brief.md', 'design/d2': 'docs/design/d2-design-system.md', 'design/d5': 'docs/design/d5-screen-blueprint.md', 'd5': 'docs/design/d5-screen-blueprint.md',
    'design/d3': 'docs/design/d3-screens.md', 'design/d4': 'docs/design/d4-handoff-checklist.md',
    'd1': 'docs/design/d1-brief.md', 'd2': 'docs/design/d2-design-system.md', 'd3': 'docs/design/d3-screens.md', 'd4': 'docs/design/d4-handoff-checklist.md',
    'review': 'docs/review/consistency-review.md', 'wbs': 'docs/wbs/wbs.md',
    '00-summary': 'docs/00-summary.md', '00-diagnosis': 'docs/00-diagnosis.md',
}


def resolve(name):
    n = name.strip('`').rstrip('.')
    if n in ALIAS:
        return ALIAS[n]
    # 2026-10-30부터 문서는 docs/ 아래에 있다(ADR-0168). 'docs/planning/03'도 'planning/03'과 같게 푼다
    if n.startswith('docs/') and n[5:] in ALIAS:
        return ALIAS[n[5:]]
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
            # 기획·디자인·설계 문서만 본다. 2026-10-30에 docs/ 아래로 옮긴 검토·WBS·쉬운 설명·요약은 예전처럼 빼고 본다(ADR-0168)
            if re.search(r'\[충돌 C-\d+', line) and f.startswith('docs/') and not f.startswith(
                    ('docs/review/', 'docs/wbs/', 'docs/guide/', 'docs/perf-ledger/', 'docs/00-summary.md', 'docs/00-diagnosis.md')):
                rep.err('artifacts', '%s:%d' % (f, n), '해소되지 않은 [충돌] 표시(기획 v1.0은 0건)')


# ---------- 6의1의2. 공개 문서에 실제 운영 값이 없음(ADR-0153, docs/devops.md §2.1) ----------
PUBLIC_ARN = re.compile(r'arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d{12}:')
PUBLIC_ACCOUNT = re.compile(r'(?<![\d,.])\d{12}(?![\d,.])')
PUBLIC_DOMAIN = re.compile(r'\bpeaket\.(?:co\.kr|com|net|org|io|kr|app|dev|ai|co|me)\b', re.I)
PUBLIC_CIDR = re.compile(r'(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})/(\d{1,2})(?!\d)')
# 문서에 적어도 되는 대역: 사설·공유(CGNAT)·링크 로컬·루프백·문서용(RFC 5737)·성능 측정용(RFC 2544, 부하 시험의 가상 사용자 IP,
# docs/verification.md §3.9)·전체(0.0.0.0/0)·운영 주소가 될 수 없는 특수 용도(이 망·프로토콜 할당·멀티캐스트·예약, 나가는 연결 제외 목록, BUILD_ORDER PRF-192)
PUBLIC_CIDR_OK = ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16',
                  '127.0.0.0/8', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '198.18.0.0/15',
                  '0.0.0.0/8', '192.0.0.0/24', '224.0.0.0/4', '240.0.0.0/4')


def check_public(texts, rep):
    import ipaddress
    ok_nets = [ipaddress.ip_network(n) for n in PUBLIC_CIDR_OK]
    hits = 0
    for f, text in texts.items():
        for n, line in enumerate(text.split('\n'), 1):
            where = '%s:%d' % (f, n)
            if PUBLIC_ARN.search(line):
                rep.err('public', where, 'ARN에 실제 계정 번호(12자리)가 있음. 자리표시값을 쓴다')
                hits += 1
            elif PUBLIC_ACCOUNT.search(line):
                rep.err('public', where, '12자리 숫자(계정 번호로 읽힘). 실제 계정 번호면 지우고, 아니면 자릿수 구분 쉼표를 넣는다')
                hits += 1
            for m in PUBLIC_DOMAIN.finditer(line):
                # 쿠버네티스 레이블·주석 키 접두사(`peaket.io/pool` 등)는 주소가 아니라 이름이다
                if line[m.end():m.end() + 1] == '/' and line[m.start() - 1:m.start()] not in ('.', '/', ':', '@'):
                    continue
                rep.err('public', where, "실제 도메인으로 읽히는 '%s'. 공개 문서는 peaket.example만 쓴다" % m.group(0))
                hits += 1
            for m in PUBLIC_CIDR.finditer(line):
                try:
                    net = ipaddress.ip_network('%s/%s' % (m.group(1), m.group(2)), strict=False)
                except ValueError:
                    continue
                if net.prefixlen == 0 or any(net.subnet_of(o) for o in ok_nets):
                    continue
                rep.err('public', where, "공인 대역 '%s'. 공개 문서는 사설·문서용 대역만 쓴다" % m.group(0))
                hits += 1
    rep.info['public_hits'] = hits


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


# ---------- 6의2의2. 차단 조건 목록 대조(docs/review/open-items.md 51번, 소유자 결정 2026-10-30) ----------
# 같은 차단 조건 목록이 정책(docs/planning/03 §1)·상태도(docs/planning/03 §2)·화면(docs/planning/04 F-·SCR-)·API(openapi)에 흩어져 있다.
# API에 적힌 차단 사유 코드(대문자와 밑줄, 예: ENTRY_STARTED)를 기준으로, 각 자리에 적힌 코드 묶음이 같은지 본다.
# 자리는 (파일, 절, 줄 머리)다. 절은 제목의 첫 낱말(예: '2.8', 'F-11')이고 그 제목 아래 다음 같은·높은 단계 제목 전까지를 본다.
# 줄 머리가 있으면 그 절에서 이 글자로 시작하는 첫 줄만, 없으면 절 전체(그림 포함)를 본다.
# API 기준: ('schema', 스키마, 속성) = 그 배열 속성의 열거값, ('409', ((메서드, 경로), …)) = 그 작업들의 409 응답 설명에 적힌 코드.
BLOCKER_LISTS = (
    {'name': '계정 병합 차단 사유',
     'api': ('schema', 'MergeProposal', 'blockers'),
     'places': (('docs/planning/03-policies-glossary.md', '1.', '| POL-034 |'),
                ('docs/planning/03-policies-glossary.md', '2.8', '| T9 |'),
                ('docs/planning/04-ia-flows-screens.md', 'F-11', None),
                ('docs/planning/04-ia-flows-screens.md', '3.1', '| SCR-040 |'),
                ('docs/features/identity.md', '2.1', '- 계정 병합 차단 사유'),
                ('docs/design/d5-screen-blueprint.md', '5.22', '| blocked |'))},
    {'name': '입장 중 소유권 동결(양도 수락·돌려주기)',
     'api': ('409', (('POST', '/v1/transfers/{offerId}/acceptance'), ('POST', '/v1/tickets/{ticketId}/returns'))),
     'places': (('docs/planning/03-policies-glossary.md', '1.', '| POL-017 |'),
                ('docs/planning/03-policies-glossary.md', '2.5', '| T8 |'),
                ('docs/planning/03-policies-glossary.md', '2.5', '| T9 |'),
                ('docs/planning/04-ia-flows-screens.md', '3.1', '| SCR-013 |'),
                ('docs/planning/04-ia-flows-screens.md', '3.1', '| SCR-041 |'))},
)
BLOCKER_CODE_RE = re.compile(r'(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![A-Za-z0-9_])')


def section_lines(text, sec):
    """제목의 첫 낱말이 sec인 절의 (첫 줄 번호, 줄 목록). 없으면 (None, [])."""
    lines = text.split('\n')
    fenced = strip_fences(text)
    for i, l in enumerate(fenced):
        m = re.match(r'^(#{1,6})\s+(\S+)', l)
        if m and m.group(2) == sec:
            level, j = len(m.group(1)), i + 1
            while j < len(fenced):
                h = re.match(r'^(#{1,6})\s', fenced[j])
                if h and len(h.group(1)) <= level:
                    break
                j += 1
            return i + 1, lines[i:j]
    return None, []


def check_blockers(texts, spec, rep):
    if not isinstance(spec, dict):
        rep.err('blockers', 'docs/api/openapi.yaml', 'openapi를 읽지 못해 차단 조건 목록을 대조하지 못함')
        return
    info = {}
    for b in BLOCKER_LISTS:
        kind = b['api'][0]
        try:
            if kind == 'schema':
                prop = spec['components']['schemas'][b['api'][1]]['properties'][b['api'][2]]
                canon = set((prop.get('items') or {}).get('enum') or [])
                api_where = 'docs/api/openapi.yaml %s.%s' % b['api'][1:]
            else:
                canon = set()
                for method, path in b['api'][1]:
                    r = spec['paths'][path][method.lower()]['responses']['409']
                    canon |= set(BLOCKER_CODE_RE.findall(str((r or {}).get('description', ''))))
                api_where = 'docs/api/openapi.yaml ' + '·'.join('%s %s' % x for x in b['api'][1]) + ' 409'
        except (KeyError, TypeError, AttributeError):
            rep.err('blockers', 'docs/api/openapi.yaml', "'%s'의 API 기준 %s를 찾지 못함" % (b['name'], b['api']))
            continue
        if not canon:
            rep.err('blockers', api_where, "'%s'의 API 기준에 차단 사유 코드가 없음" % b['name'])
            continue
        for f, sec, head in b['places']:
            start, sl = section_lines(texts.get(f, ''), sec)
            if start is None:
                rep.err('blockers', f, "'%s'를 대조할 절 %s가 없음(tools/doc-check/check_all.py BLOCKER_LISTS를 고친다)" % (b['name'], sec))
                continue
            if head:
                k = next((k for k, l in enumerate(sl) if l.startswith(head)), None)
                if k is None:
                    rep.err('blockers', '%s:%d' % (f, start), "'%s'를 대조할 줄 '%s'가 절 %s에 없음" % (b['name'], head.strip('| '), sec))
                    continue
                where, body = '%s:%d' % (f, start + k), sl[k]
            else:
                where, body = '%s:%d' % (f, start), '\n'.join(sl)
            found = set(BLOCKER_CODE_RE.findall(body))
            missing, extra = sorted(canon - found), sorted(found - canon)
            if missing:
                rep.warn('blockers', where, "'%s'에 API(%s)의 사유 %s가 없음" % (b['name'], api_where, '·'.join(missing)))
            if extra:
                rep.warn('blockers', where, "'%s'에 API(%s)에 없는 사유 %s가 있음" % (b['name'], api_where, '·'.join(extra)))
        info[b['name']] = {'codes': len(canon), 'places': len(b['places'])}
    rep.info['blockers'] = info


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
        if f not in ('docs/00-summary.md', 'docs/review/consistency-review.md', 'docs/review/tech-review.md'):
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
    md = texts.get('docs/wbs/wbs.md')
    if md is None or not os.path.exists(os.path.join(ROOT, 'docs', 'wbs', 'wbs.csv')):
        rep.err('wbs', 'docs/wbs/', 'wbs.md 또는 wbs.csv 없음')
        return
    with io.open(os.path.join(ROOT, 'docs', 'wbs', 'wbs.csv'), encoding='utf-8', newline='') as fh:
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
    plan = re.search(r'\*\*기획 버전\*\*: (v\d+\.\d+)', texts.get('docs/planning/01-overview.md', ''))
    if not plan:
        rep.err('versions', 'docs/planning/01-overview.md', '기획 버전 줄 없음')
        return
    v = plan.group(1)
    for f, text in texts.items():
        for m in re.finditer(r'기준 기획 버전\**:?\**:? (v\d+\.\d+)', text):
            if m.group(1) != v:
                rep.warn('versions', f, '기준 기획 버전 %s ≠ 기획 %s' % (m.group(1), v))
    rep.info['plan_version'] = v


# ---------- 10. mermaid 그림 ----------
# 그림 쓰기 규칙은 docs/planning/03 §5.5(ADR-0138). 문법은 리더기와 같은 mermaid 버전(tools/doc-check/mermaid/package.json)으로 읽는다.
MERMAID_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mermaid')
MERMAID_LINE_KINDS = ('flowchart', 'graph', 'stateDiagram')  # 선 수·라벨 길이를 보는 그림
MERMAID_MAX_EDGES = 25
MERMAID_MAX_LABEL = 40
# mermaid 설정 maxTextSize의 기본값. 이보다 긴 그림은 읽기(parse)는 되지만 그릴 때 'Maximum text size in diagram exceeded'로 멈춘다
MERMAID_MAX_TEXT = 50000
MERMAID_CODE_RE = re.compile(r'^([A-Z]\d{1,2})(?=\s|$)')  # 선 라벨 앞의 전이 번호(T1, E2)
# 선이 많아도 배치 엔진(ELK)으로 그려 교차가 적은 것을 확인한 그림은 그림 안에 이 주석과 이유를 적는다
MERMAID_EDGE_EXCEPTION_RE = re.compile(r'^\s*%%\s*선 수 예외:\s*\S', re.M)


def mermaid_blocks(texts):
    blocks = []
    for f, text in texts.items():
        if not f.endswith('.md'):
            continue
        lines = text.split('\n')
        i = 0
        while i < len(lines):
            if lines[i].strip() == '```mermaid':
                j = i + 1
                while j < len(lines) and not lines[j].strip().startswith('```'):
                    j += 1
                blocks.append({'id': len(blocks), 'file': f, 'line': i + 1, 'end': j + 1,
                               'code': '\n'.join(lines[i + 1:j]) + '\n'})
                i = j + 1
            else:
                i += 1
    return blocks


def check_mermaid(texts, rep):
    blocks = mermaid_blocks(texts)
    node = shutil.which('node')
    if not node or not os.path.isdir(os.path.join(MERMAID_DIR, 'node_modules', 'mermaid')):
        rep.warn('mermaid', 'tools/doc-check/mermaid', '문법 검사를 건너뜀(node 22 이상과 이 폴더에서 `npm ci --ignore-scripts`가 필요)')
        rep.info['mermaid'] = {'blocks': len(blocks), 'checked': 0}
        return
    payload = json.dumps([{'id': b['id'], 'code': b['code']} for b in blocks], ensure_ascii=False)
    run = subprocess.run([node, 'parse.mjs'], cwd=MERMAID_DIR, input=payload, capture_output=True,
                         encoding='utf-8', timeout=600)
    if run.returncode != 0:
        raise RuntimeError('mermaid 검사 실행 실패: %s' % run.stderr.strip()[:500])
    results = {r['id']: r for r in json.loads(run.stdout)}
    over = 0
    for b in blocks:
        r = results[b['id']]
        where = '%s:%d' % (b['file'], b['line'])
        if len(b['code']) > MERMAID_MAX_TEXT:
            rep.err('mermaid', where, '그림 글자 수 %d자(mermaid 기본 한도 %d자를 넘어 그려지지 않는다. 나눠 그린다, docs/planning/03 §5.5)'
                    % (len(b['code']), MERMAID_MAX_TEXT))
        if not r['ok']:
            rep.err('mermaid', where, '문법 오류: %s' % r['error'])
            continue
        if r['type'].startswith('c4'):
            # C4 문법은 자동 배치 없이 곧은 선으로 그려 상자를 가로지른다. C4 표기를 라벨에 남긴 흐름도로 그린다
            rep.warn('mermaid', where, 'C4 문법(%s)은 자동 배치가 없어 선이 상자를 가로지른다. 흐름도로 그린다(docs/planning/03 §5.5)' % r['type'])
        if r['edges'] is None or not r['type'].startswith(MERMAID_LINE_KINDS):
            continue
        edges = r['edges']
        if len(edges) > MERMAID_MAX_EDGES:
            over += 1
            if not MERMAID_EDGE_EXCEPTION_RE.search(b['code']):
                rep.warn('mermaid', where, '선 %d개(그림 하나에 %d개 이하, 넘으면 나누거나 `%%%% 선 수 예외:`에 이유, docs/planning/03 §5.5)'
                         % (len(edges), MERMAID_MAX_EDGES))
        long_labels = [e for e in edges if len(e) > MERMAID_MAX_LABEL]
        if long_labels:
            rep.warn('mermaid', where, '%d자를 넘는 선 라벨 %d개(조건은 그림 아래 표로, docs/planning/03 §5.5): %s'
                     % (MERMAID_MAX_LABEL, len(long_labels), long_labels[0][:40]))
        codes = {m.group(1) for e in edges for m in [MERMAID_CODE_RE.match(e)] if m}
        if codes:
            # 번호를 붙인 선은 그림 바로 아래(다음 제목 전) 표의 첫 칸에 같은 번호가 있어야 한다
            after = []
            for line in texts[b['file']].split('\n')[b['end']:]:
                if re.match(r'^#{1,6} ', line):
                    break
                after.append(line)
            rows = {m.group(1) for line in after for m in [re.match(r'^\| (?:\*\*)?([A-Z]\d{1,2})(?:\*\*)? \|', line)] if m}
            for c in sorted(codes - rows, key=lambda x: (x[0], int(x[1:]))):
                rep.err('mermaid', where, '선 라벨의 번호 %s가 그림 아래 표에 없음(docs/planning/03 §5.5)' % c)
    rep.info['mermaid'] = {'blocks': len(blocks), 'checked': len(results), 'over_edges': over}


# ---------- 11. 원문 대조(선택) ----------
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
    check_links(texts, rep)
    check_api(texts, rep)
    check_api_contract(yaml_docs.get('docs/api/openapi.yaml'), rep)
    check_operation_ids(yaml_docs.get('docs/api/openapi.yaml'), rep)
    check_problem_types(yaml_docs.get('docs/api/openapi.yaml'), rep)
    check_schema_closure(yaml_docs.get('docs/api/openapi.yaml'), rep)
    check_roles(texts, yaml_docs.get('docs/api/openapi.yaml'), rep)
    check_blockers(texts, yaml_docs.get('docs/api/openapi.yaml'), rep)
    check_secrefs(texts, rep)
    check_artifacts(texts, rep)
    check_public(texts, rep)
    check_asvs(texts, rep)
    check_adr_tables(texts, rep)
    count_markers(texts, rep, a.markers_out)
    check_wbs(texts, rep)
    check_versions(texts, rep)
    check_mermaid(texts, rep)
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
