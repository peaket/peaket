"""직접 운영 시간 기록(docs/perf-ledger/ops-hours.csv)의 검사와 요약(기능 F-01-1, OPS-030, 시험 V-T48, ADR-0067 결정 5 ③·R2).

  check    기록 파일의 머리 줄과 줄마다 값 범위를 본다. 틀린 줄은 모두 '<파일>:<줄 번호>: <까닭>'으로 찍는다
  summary  부품·활동마다 1회 평균 시간(연간 추정식의 '1회 시간' 표본)과, 합계 시간 × 시간 단가를 0.5배·1배·1.5배로 JSON 하나에 낸다

열 이름·부품·활동·환경 목록, 분 범위, 판 올림 규칙, 시간 단가는 이 파일에 적지 않고 docs/perf-ledger.md §11.5에서 읽는다(정본).
기록이 없으면 '기록 없음'을 내고 비용을 0원으로 내지 않는다(docs/verification.md V-T48 ②). 1년 값으로 늘리는 계산과 R2 판정은 4.8.2 몫이다.
끝 코드: 0 통과, 1 틀린 줄 있음, 2 파일 없음·문서에서 규칙을 읽지 못함·인자 오류.
표준 라이브러리만 쓰고 Python 3.10 이상에서 돈다. 실행: python -I -X utf8 tools/perf-ledger/ops_hours.py check
"""
import argparse
import csv
import datetime
import json
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_FILE = os.path.join(REPO_ROOT, 'docs', 'perf-ledger', 'ops-hours.csv')
DEFAULT_DOC = os.path.join(REPO_ROOT, 'docs', 'perf-ledger.md')
# 비용 민감도 배수(docs/perf-ledger.md §11.5 '민감도 표'의 0.5배·1배·1.5배). JSON 칸 이름과 곱하는 값
MULTIPLIERS = (('0.5', 1, 2), ('1', 1, 1), ('1.5', 3, 2))
DATE_SHAPE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
MINUTES_SHAPE = re.compile(r'^[0-9]+$')


class RuleError(Exception):
    """문서에서 규칙을 읽지 못함(끝 코드 2)"""


def _ticks(text):
    return re.findall(r'`([^`]+)`', text)


def read_rules(doc_path):
    """§11.5의 시간 단가와 '운영 시간 기록' 글귀에서 규칙을 읽는다"""
    try:
        with open(doc_path, encoding='utf-8') as f:
            doc = f.read()
    except OSError as e:
        raise RuleError(f'문서를 읽지 못했다: {doc_path}: {e.strerror or e}') from e
    rate = re.search(r'시간 단가 ([\d,]+)원', doc)
    if not rate:
        raise RuleError(f'{doc_path}: §11.5에서 "시간 단가 <숫자>원"을 읽지 못했다')
    line = next((l for l in doc.splitlines() if 'ops-hours.csv' in l and '열은 `' in l), None)
    if line is None:
        raise RuleError(f'{doc_path}: §11.5에서 운영 시간 기록 글귀(열은 `…`)를 읽지 못했다')

    def after(label, stop=r'(?: 가운데 하나|다\.|이다\.|,|\()'):
        m = re.search(re.escape(label) + r'(.*?)' + stop, line)
        if not m:
            raise RuleError(f'{doc_path}: 운영 시간 기록 글귀에서 "{label}" 뒤의 목록을 읽지 못했다')
        values = _ticks(m.group(1))
        if not values:
            raise RuleError(f'{doc_path}: 운영 시간 기록 글귀의 "{label}" 뒤에 백틱 값이 없다')
        return values

    cols = re.search(r'열은 `([a-z_,]+)`', line)
    if not cols:
        raise RuleError(f'{doc_path}: 운영 시간 기록 글귀에서 열 목록을 읽지 못했다')
    minutes = re.search(r'`minutes`는 ([\d,]+)~([\d,]+)의 정수 분', line)
    if not minutes:
        raise RuleError(f'{doc_path}: 운영 시간 기록 글귀에서 `minutes`의 범위를 읽지 못했다')
    both = re.search(r'`([a-z_]+)`는 `([a-z_]+)`·`([a-z_]+)`가 둘 다 있어야 한다', line)
    if not both:
        raise RuleError(f'{doc_path}: 운영 시간 기록 글귀에서 판 올림의 판 칸 규칙을 읽지 못했다')
    header = cols.group(1).split(',')
    rules = {
        'rate': int(rate.group(1).replace(',', '')),
        'header': header,
        'components': after('`component`는 '),
        'activities': after('`activity`는 '),
        'environments': after('`environment`는 '),
        'min_minutes': int(minutes.group(1).replace(',', '')),
        'max_minutes': int(minutes.group(2).replace(',', '')),
        'versioned_activity': both.group(1),
        'version_columns': (both.group(2), both.group(3)),
    }
    for need in ('date', 'component', 'activity', 'minutes', 'environment', *rules['version_columns']):
        if need not in header:
            raise RuleError(f'{doc_path}: 열 목록에 {need}이(가) 없다')
    if rules['versioned_activity'] not in rules['activities']:
        raise RuleError(f'{doc_path}: 판 칸 규칙의 활동 {rules["versioned_activity"]}이(가) 활동 목록에 없다')
    return rules


def read_records(path, rules):
    """(문제 목록, 바른 줄 목록). 파일이 없으면 OSError"""
    with open(path, encoding='utf-8', newline='') as f:
        rows = list(csv.reader(f))
    problems = []
    records = []
    name = os.path.basename(path)
    if not rows:
        return [f'{name}:1: 머리 줄이 없다(열은 {",".join(rules["header"])})'], []
    if [c.strip() for c in rows[0]] != rules['header']:
        problems.append(f'{name}:1: 머리 줄이 §11.5의 열과 다르다(바른 머리 줄 {",".join(rules["header"])})')
        return problems, []
    header = rules['header']
    for n, row in enumerate(rows[1:], start=2):
        if not row or all(not c.strip() for c in row):
            continue
        why = []
        if len(row) != len(header):
            problems.append(f'{name}:{n}: 칸 수가 {len(row)}개다({len(header)}개여야 한다)')
            continue
        r = dict(zip(header, (c.strip() for c in row)))
        if not DATE_SHAPE.match(r['date']):
            why.append(f'date {r["date"]!r}이(가) YYYY-MM-DD 꼴이 아니다')
        else:
            try:
                datetime.date.fromisoformat(r['date'])
            except ValueError:
                why.append(f'date {r["date"]!r}은(는) 없는 날짜다')
        if r['component'] not in rules['components']:
            why.append(f'component {r["component"]!r}은(는) §11.5의 부품 목록에 없다')
        if r['activity'] not in rules['activities']:
            why.append(f'activity {r["activity"]!r}은(는) §11.5의 활동 목록에 없다')
        if r['environment'] not in rules['environments']:
            why.append(f'environment {r["environment"]!r}은(는) §11.5의 환경 목록에 없다')
        minutes = None
        if not MINUTES_SHAPE.match(r['minutes']):
            why.append(f'minutes {r["minutes"]!r}이(가) 정수 분이 아니다')
        else:
            minutes = int(r['minutes'])
            if not rules['min_minutes'] <= minutes <= rules['max_minutes']:
                why.append(f'minutes {minutes}이(가) {rules["min_minutes"]}~{rules["max_minutes"]} 밖이다')
        if r['activity'] == rules['versioned_activity']:
            for col in rules['version_columns']:
                if not r[col]:
                    why.append(f'{rules["versioned_activity"]}인데 {col}이(가) 비었다')
        if why:
            problems.append(f'{name}:{n}: ' + '; '.join(why))
        else:
            records.append({'component': r['component'], 'activity': r['activity'], 'minutes': minutes})
    return problems, records


def summarize(records, rate):
    if not records:
        return {'status': '기록 없음', 'rate_krw_per_hour': rate, 'samples': []}
    groups = {}
    for r in records:
        groups.setdefault((r['component'], r['activity']), []).append(r['minutes'])
    samples = []
    for (component, activity), mins in sorted(groups.items()):
        total = sum(mins)
        samples.append({'component': component, 'activity': activity, 'count': len(mins), 'total_minutes': total, 'mean_minutes': total / len(mins)})
    total_minutes = sum(r['minutes'] for r in records)
    # ⌊합계 분 × 단가 × 배수 ÷ 60⌋: 정수로만 셈해 합계 시간을 먼저 반올림하지 않는다. 원 아래는 버린다
    cost = {label: (total_minutes * rate * num) // (den * 60) for label, num, den in MULTIPLIERS}
    return {'rate_krw_per_hour': rate, 'samples': samples, 'total_hours': total_minutes / 60, 'cost_krw': cost}


def main(argv=None):
    p = argparse.ArgumentParser(description='직접 운영 시간 기록 검사·요약(docs/perf-ledger.md §11.5)')
    sub = p.add_subparsers(dest='cmd', required=True)
    for cmd in ('check', 'summary'):
        s = sub.add_parser(cmd)
        s.add_argument('--file', default=DEFAULT_FILE, help='기록 파일(기본 docs/perf-ledger/ops-hours.csv)')
        s.add_argument('--doc', default=DEFAULT_DOC, help='규칙 문서(기본 docs/perf-ledger.md)')
    try:
        a = p.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    try:
        rules = read_rules(a.doc)
    except RuleError as e:
        print(f'읽기 오류: {e}', file=sys.stderr)
        return 2
    try:
        problems, records = read_records(a.file, rules)
    except OSError as e:
        print(f'읽기 오류: 기록 파일을 읽지 못했다: {a.file}: {e.strerror or e}', file=sys.stderr)
        return 2
    if problems:
        for line in problems:
            print(f'틀림: {line}')
        return 1
    if a.cmd == 'check':
        print(f'운영 시간 기록: {len(records)}줄, 틀린 줄 없음')
        return 0
    print(json.dumps(summarize(records, rules['rate']), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
