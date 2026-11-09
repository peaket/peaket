"""사람 쪽 측정 자료를 K6 측정 입력으로 바꾼다(BUILD_ORDER BAS-260, ADR-0174·0245, docs/perf-ledger.md §10.1·§10.5).

  convert-aalto         공개 실제 사람 기록(Aalto 136M Keystrokes의 Keystrokes.zip)을 행동 요약으로 바꾸고 사람 단위로 나눠 비공개 등록 파일을 쓴다
  register-mock         모의 사람 기록을 사람 단위로 나눠 비공개 등록 파일을 쓴다
  publish-registration  비공개 등록 파일의 소금 넣은 해시를 저장소의 공개 등록 파일로 쓴다(측정 전에 커밋해 고정한다)
  sessions              점수기 결과를 사전 등록 기준에 맞춰 human_sessions.csv·confusion-human.csv로 만든다
  verify                등록 파일과 기록을 원본에서 다시 계산해 맞춰 본다

원본과 바꾼 파일, 비공개 등록 파일은 어떤 Git 저장소 안에도 쓰지 않는다. 입력한 글자 내용은 읽어 들이지 않고 시각만 옮긴다.
자료를 내려받지 않는다. 받은 파일을 --zip으로 받을 뿐이고, 그 안의 스크립트를 실행하거나 풀어 놓지 않는다.
"""
import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
import secrets
import subprocess
import sys
import time
import zipfile
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledgerlib as L  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CONVERSION_RULE = 'aalto-keystroke-v1'
AALTO_NAME = 'Aalto 136M Keystrokes'
AALTO_ATTRIBUTION = ('Dhakal, V., Feit, A. M., Kristensson, P. O., Oulasvirta, A. Observations on Typing from 136 Million Keystrokes. '
                     'CHI 2018. doi:10.1145/3173574.3174220. https://userinterfaces.aalto.fi/136Mkeystrokes/ (연구·비상업 목적, 저자 표시)')
# 자료 안 파일의 꼴. 공개 페이지는 Keystrokes.zip과 readme.txt만 밝히므로 아래 이름은 [가정]이다.
# 어긋나면 변환이 아무것도 쓰지 않고 멈추고, 받은 뒤 readme를 읽어 여기를 고친다(docs/perf-ledger.md §10.5).
AALTO_MEMBER = re.compile(r'(?:^|/)([A-Za-z0-9_-]{1,64})_keystrokes\.txt$')
AALTO_METADATA = 'metadata_participants.txt'
AALTO_README = 'readme.txt'
AALTO_COLUMNS = ('PARTICIPANT_ID', 'TEST_SECTION_ID', 'PRESS_TIME')

MAX_WINDOW_MS = 3_600_000   # openapi BehaviorSummary.windowMs 상한
KEEP_INTERVALS = 200        # 화면(apps/web createBehaviorTracker)이 들고 있는 간격 수 [가정]
DEFAULT_TUNE_N = 2000       # 조정용 사람 수 [가정, ADR-0246]
DEFAULT_MAX_MISSING = 0.01  # 판정 기록 가운데 값 없음 비율 상한 [가정, ADR-0246]
AGE60 = 60
# 풀기 전에 보는 상한 [가정, ASVS 5.2.3]: 공개 페이지가 밝힌 풀린 크기 16GB의 두 배, 약 16만 8천 명의 두 배가 넘는 파일 수
MAX_ZIP_FILES = 400_000
MAX_ZIP_BYTES = 32 * 1024 ** 3
MAX_PERSON_BYTES = 8 * 1024 ** 2
MAX_README_BYTES = 1024 ** 2
MAX_METADATA_BYTES = 256 * 1024 ** 2
MAX_ROWS = 100_000
MAX_METADATA_ROWS = 400_000
MAX_LINE_CHARS = 64 * 1024

PUBLIC_SUMMARY_KEYS = {'v', 'windowMs', 'inputIntervalMeanMs', 'inputIntervalStdMs'}
SUMMARY_KEYS = PUBLIC_SUMMARY_KEYS | {'pointerMoves', 'pointerEntropy', 'scrollEvents', 'scrollDistancePx'}
_COUNT_KEYS = {'pointerMoves', 'scrollEvents', 'scrollDistancePx'}
_ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
# K6InputError도 ValueError다. 읽지 못한 파일, 깨진 JSON·칸, 손상·암호·지원 밖 압축의 zip(RuntimeError는 NotImplementedError를 포함한다)
INPUT_ERRORS = (ValueError, OSError, zlib.error, zipfile.BadZipFile, EOFError, KeyError, TypeError, RuntimeError) + ((zipfile.lzma.LZMAError,) if zipfile.lzma else ())


def refuse(message):
    raise SystemExit(f'실행 거부(docs/perf-ledger.md §10.5): {message}')


def outside_git(path, what):
    try:
        L.require_outside_git(path, what)
    except L.K6InputError as e:
        refuse(str(e))


def rank(seed, person):
    """씨앗값과 사람 코드만으로 정해지는 순서 값. 파일 순서와 결과에 기대지 않는다."""
    return hashlib.sha256(f'{seed}:{person}'.encode('utf-8')).hexdigest()


def round1(x):
    """화면의 Math.round(x * 10) / 10과 같게 반올림한다(파이썬 round는 짝수 쪽으로 간다)."""
    return math.floor(x * 10 + 0.5) / 10


def interval_fields(presses):
    """키 누름 시각에서 행동 요약의 간격 칸. 평균과 모표준편차, 마지막 200개(apps/web createBehaviorTracker와 같다)."""
    gaps = [b - a for a, b in zip(presses, presses[1:])][-KEEP_INTERVALS:]
    if not gaps:
        return {}
    mean = sum(gaps) / len(gaps)
    var = sum((g - mean) ** 2 for g in gaps) / len(gaps)
    return {'inputIntervalMeanMs': round1(mean), 'inputIntervalStdMs': round1(math.sqrt(var))}


def section_summary(presses):
    """한 문장(세션)의 키 누름 시각 → BehaviorSummary v1. 자료에 없는 칸(포인터·스크롤)은 비운다. 돌려주는 값: (요약, 구간을 잘랐는지)."""
    presses = sorted(presses)
    span = presses[-1] - presses[0]
    summary = {'v': 1, 'windowMs': int(min(span, MAX_WINDOW_MS))}
    summary.update(interval_fields(presses))
    return summary, span > MAX_WINDOW_MS


def zip_preflight(zf, limits):
    """풀기 전에 ZipInfo에 적힌 크기와 파일 수로 상한을 본다(ASVS 5.2.3). 넘으면 멈춘다."""
    infos = zf.infolist()
    if len(infos) > limits['files']:
        refuse(f'zip의 파일 수 {len(infos)}개가 상한 {limits["files"]}개를 넘는다')
    total = sum(i.file_size for i in infos)
    if total > limits['bytes']:
        refuse(f'zip의 풀린 크기 {total}바이트가 상한 {limits["bytes"]}바이트를 넘는다')
    for i in infos:
        base = i.filename.rsplit('/', 1)[-1]
        if base.lower() == AALTO_README and i.file_size > MAX_README_BYTES:
            refuse(f'readme.txt의 풀린 크기가 상한 {MAX_README_BYTES}바이트를 넘는다')
        if base == AALTO_METADATA and i.file_size > MAX_METADATA_BYTES:
            refuse(f'메타데이터의 풀린 크기가 상한 {MAX_METADATA_BYTES}바이트를 넘는다')
        if AALTO_MEMBER.search(i.filename) and i.file_size > MAX_PERSON_BYTES:
            refuse(f'참가자 파일의 풀린 크기가 상한 {MAX_PERSON_BYTES}바이트를 넘는다')
    return [i.filename for i in infos]


def read_person(zf, member, person, limits):
    """참가자 파일 하나를 읽어 {문장 ID: [키 누름 시각]}과 버린 행 수를 돌려준다. 시각과 ID 칸만 꺼내고 글자 칸은 담지 않는다."""
    sections, dropped, matched, foreign = {}, 0, 0, 0
    with zf.open(member) as raw, io.TextIOWrapper(raw, encoding='utf-8-sig', errors='replace', newline='') as text:
        header = text.readline().rstrip('\r\n').split('\t')
        if not all(c in header for c in AALTO_COLUMNS):
            refuse(f'자료의 열이 예상과 다르다. 필요한 열: {",".join(AALTO_COLUMNS)}(자료 readme를 읽고 도구를 고친다)')
        ip, it, ipress = (header.index(c) for c in AALTO_COLUMNS)
        for n, line in enumerate(text, 1):
            if n > limits['rows']:
                refuse(f'참가자 파일의 행 수가 상한 {limits["rows"]}행을 넘는다')
            if len(line) > MAX_LINE_CHARS:
                dropped += 1
                continue
            cells = line.rstrip('\r\n').split('\t')
            if len(cells) != len(header):   # 글자 칸의 탭 때문에 열이 밀린 행
                dropped += 1
                continue
            if cells[ip] != person:
                foreign += 1
                dropped += 1
                continue
            matched += 1
            try:
                press = float(cells[ipress])
            except ValueError:
                dropped += 1
                continue
            if not math.isfinite(press) or not _ID.match(cells[it]):
                dropped += 1
                continue
            sections.setdefault(cells[it], []).append(press)
    if matched == 0 and foreign > 0:
        refuse('파일 이름의 사람 ID와 안쪽 PARTICIPANT_ID가 다르다(자료 readme를 읽고 도구를 고친다)')
    return sections, dropped


def person_records(zf, member, person, stratum, stats, limits):
    """참가자 파일 → 기록 목록(시간순). 맨 앞 문장이 그 사람의 첫 세션이다. 쓸 수 없으면 빈 목록."""
    sections, dropped = read_person(zf, member, person, limits)
    stats['dropped_rows'] += dropped
    ordered = sorted(sections.items(), key=lambda kv: (min(kv[1]), kv[0]))
    records = []
    for session, presses in ordered:
        summary, capped = section_summary(presses)
        stats['capped_windows'] += capped
        records.append({'source': 'public', 'person': person, 'session': session, 'stratum': stratum, 'summary': summary})
    return records


def load_age60(zf, names, limits):
    """메타데이터에서 60세 이상인 사람 코드. 파일이나 열이 없으면 None(층을 붙이지 않는다). 행 수와 행 길이 상한을 지킨다."""
    member = next((n for n in names if n.rsplit('/', 1)[-1] == AALTO_METADATA), None)
    if member is None:
        return None
    with zf.open(member) as raw, io.TextIOWrapper(raw, encoding='utf-8-sig', errors='replace', newline='') as text:
        header = text.readline().rstrip('\r\n').split('\t')
        if 'PARTICIPANT_ID' not in header or 'AGE' not in header:
            return None
        ip, ia = header.index('PARTICIPANT_ID'), header.index('AGE')
        out = set()
        for n, line in enumerate(text, 1):
            if n > limits['metadata_rows']:
                refuse(f'메타데이터의 행 수가 상한 {limits["metadata_rows"]}행을 넘는다')
            if len(line) > MAX_LINE_CHARS:
                continue
            cells = line.rstrip('\r\n').split('\t')
            if len(cells) == len(header):
                try:
                    if float(cells[ia]) >= AGE60:
                        out.add(cells[ip])
                except ValueError:
                    continue
    return out


def write_jsonl(path, rows):
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n')


def write_json(path, value):
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(value, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write('\n')


def registered_at(a):
    if a.registered_at:
        L.required_time(a.registered_at, '--registered-at')
        return a.registered_at
    return L.iso_utc(time.time())


def load_rule(path, source):
    outside_git(path, '--behavior-rule')   # 판정 기준값과 가중치는 비공개 설정이다(POL-006)
    try:
        spec = L.load_json_strict(path)
        L.behavior_rule(spec, source)
    except (OSError, ValueError) as e:
        refuse(f'BehaviorScore 기준 파일이 규칙 밖이다: {e}')
    return spec


def parse_plan(text):
    try:
        plan = L.k6_plan_parse(text)
    except ValueError as e:
        refuse(str(e))
    return {'n': plan['holdout_n'], 'c': plan['max_fp']}


def tag_roles(records):
    """한 사람의 기록(시간순)에서 첫 기록이 판정 기록, 나머지는 참고다(ADR-0112·0174)."""
    return [dict(r, role='judge' if i == 0 else 'ref') for i, r in enumerate(records)]


def tool_commit():
    try:
        out = subprocess.run(['git', '-C', REPO_ROOT, 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return 'unknown'
    return out.stdout.strip() if out.returncode == 0 and out.stdout.strip() else 'unknown'


def prepare_output(a):
    """등록을 시작하기 전에 확인한다. 이미 있는 등록 파일은 덮어쓰지 않고, 씨앗값은 서로 달라야 한다."""
    outside_git(a.out_dir, '--out-dir')
    if os.path.exists(os.path.join(a.out_dir, 'registration.json')):
        refuse(f'이 폴더에 등록 파일이 이미 있다. 덮어쓰지 않는다: {a.out_dir}')
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', a.registration_id) or a.registration_id.startswith('.'):
        refuse('--registration-id가 규칙 밖이다')
    if a.split_seed == a.draw_seed:
        refuse('나누기 씨앗값과 뽑기 씨앗값은 달라야 한다')
    if not 0 <= a.max_missing_ratio <= L.K6_MAX_MISSING_RATIO_LIMIT:
        refuse(f'--max-missing-ratio는 0과 {L.K6_MAX_MISSING_RATIO_LIMIT} 사이다')


def finish(a, source, dataset, conversion_rule, plan, spec, tune_rows, judge_rows, report):
    """출력 파일을 쓴다. registration.json이 비공개 등록 파일이다. 소금을 넣고, 그 해시는 측정 전에 저장소에 커밋해 고정한다(ADR-0246)."""
    when = registered_at(a)
    salt = secrets.token_hex(32)
    judge_people = {r['person'] for r in judge_rows}
    tune_people = {r['person'] for r in tune_rows}
    reg = {'id': a.registration_id, 'source': source, 'registered_at': when, 'salt': salt, 'plan': plan, 'dataset': dataset,
           'seeds': {'split': a.split_seed, 'draw': a.draw_seed}, 'conversion_rule': conversion_rule, 'tune_n': a.tune_n, 'behavior_rule': spec,
           'max_missing_ratio': a.max_missing_ratio, 'judge_people_sha256': L.people_hash(salt, judge_people),
           'tune_people_sha256': L.people_hash(salt, tune_people), 'tool_commit': tool_commit(), 'tool_sha256': L.tool_sha256()}
    os.makedirs(a.out_dir, exist_ok=True)
    write_jsonl(os.path.join(a.out_dir, 'tune.jsonl'), tune_rows)
    write_jsonl(os.path.join(a.out_dir, 'judge.jsonl'), judge_rows)
    reg['judge_records_sha256'] = L.records_hash(salt, os.path.join(a.out_dir, 'judge.jsonl'))
    write_json(os.path.join(a.out_dir, 'registration.json'), reg)
    write_json(os.path.join(a.out_dir, 'conversion-report.json'), report)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))


def zip_limits(a):
    return {'files': min(MAX_ZIP_FILES, a.max_zip_files), 'bytes': min(MAX_ZIP_BYTES, a.max_zip_bytes), 'rows': min(MAX_ROWS, a.max_rows),
            'metadata_rows': min(MAX_METADATA_ROWS, a.max_metadata_rows)}


def select_aalto(zf, names, n, tune_n, split_seed, draw_seed, limits):
    """씨앗값대로 조정용·판정용 사람을 나눠 기록을 만든다. 돌려주는 값: (조정용 기록 목록, 판정용 기록 목록, 집계)."""
    members = {}
    for name in names:
        m = AALTO_MEMBER.search(name)
        if m:
            if m.group(1) in members:
                refuse('같은 사람의 참가자 파일이 둘 있다')
            members[m.group(1)] = name
    if len(members) < tune_n + n:
        refuse(f'사람이 모자란다: {len(members)}명 < 조정용 {tune_n} + 판정용 {n}')
    age60 = load_age60(zf, names, limits)
    stats = {'dropped_rows': 0, 'capped_windows': 0, 'unusable': 0}

    def take(order, count):
        """정해진 순서대로 쓸 수 있는 사람을 count명 모은다. 못 쓰는 사람은 그 순서의 다음 사람으로 갈음한다."""
        people, used = [], 0
        for person in order:
            if len(people) == count:
                break
            used += 1
            stratum = 'age60' if age60 and person in age60 else ''
            records = person_records(zf, members[person], person, stratum, stats, limits)
            if records:
                people.append(records)
            else:
                stats['unusable'] += 1
        if len(people) < count:
            refuse(f'쓸 수 있는 사람이 모자란다: {len(people)}명 < {count}명')
        return people, used

    order = sorted(members, key=lambda p: rank(split_seed, p))
    tune_people, used = take(order, tune_n)
    judge_people, _ = take(sorted(order[used:], key=lambda p: rank(draw_seed, p)), n)
    stats.update(people_total=len(members), metadata='age60' if age60 is not None else 'none')
    return tune_people, judge_people, stats


def rows_from(tune_people, judge_people):
    judge_rows = [r for records in judge_people for r in tag_roles(records)]
    tune_rows = [dict(r, role='tune') for records in tune_people for r in records]
    return tune_rows, judge_rows


def open_zip(path):
    try:
        return zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as e:
        refuse(f'zip을 열지 못했다: {e}')


def readme_member(names):
    readme = next((n for n in names if n.rsplit('/', 1)[-1].lower() == AALTO_README), None)
    if readme is None:
        refuse('자료 안에 readme.txt가 없다. 이용 조건을 읽을 수 있는 자료만 쓴다(ADR-0174 결정 2)')
    return readme


def member_sha256(zf, member):
    """압축을 조금씩 풀며 해시한다(큰 파일을 메모리에 올리지 않는다)."""
    h = hashlib.sha256()
    with zf.open(member) as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def convert_aalto(a):
    prepare_output(a)
    outside_git(a.zip, '--zip')
    plan, spec = parse_plan(a.plan), load_rule(a.behavior_rule, 'public')
    limits = zip_limits(a)
    with open_zip(a.zip) as zf:
        names = zip_preflight(zf, limits)
        readme_hash = member_sha256(zf, readme_member(names))
        tune_people, judge_people, stats = select_aalto(zf, names, plan['n'], a.tune_n, a.split_seed, a.draw_seed, limits)
    tune_rows, judge_rows = rows_from(tune_people, judge_people)
    dataset = {'name': AALTO_NAME, 'version': a.dataset_version or os.path.basename(a.zip), 'sha256': L.sha256_file(a.zip),
               'readme_sha256': readme_hash, 'attribution': AALTO_ATTRIBUTION}
    report = {'people_total': stats['people_total'], 'tune_people': len(tune_people), 'judge_people': len(judge_people), 'people_unusable': stats['unusable'],
              'judge_records': sum(1 for r in judge_rows if r['role'] == 'judge'), 'ref_records': sum(1 for r in judge_rows if r['role'] == 'ref'),
              'dropped_rows': stats['dropped_rows'], 'capped_windows': stats['capped_windows'],
              'metadata': stats['metadata'], 'pointer': L.K6_POINTER_UNMEASURED, 'attribution': AALTO_ATTRIBUTION}
    finish(a, 'public', dataset, CONVERSION_RULE, plan, spec, tune_rows, judge_rows, report)
    print('이용 조건: 자료 안 readme.txt를 읽었는지 확인하고, 출처 표시 문구를 측정 보고서에도 적는다(ADR-0174 결정 2·7).')
    print('다음: publish-registration으로 공개 등록 파일을 쓰고, 측정 전에 커밋한다.')


def reject_constant(name):
    raise ValueError(f'JSON 숫자가 아닌 값: {name}')


def check_summary(summary, source, where):
    """행동 요약이 openapi BehaviorSummary v1의 칸과 범위 안인지 본다. public은 자료에 있는 칸만 받는다."""
    if not isinstance(summary, dict):
        refuse(f'{where}: summary가 객체가 아니다')
    allowed = PUBLIC_SUMMARY_KEYS if source == 'public' else SUMMARY_KEYS
    unknown = sorted(set(summary) - allowed)
    if unknown:
        refuse(f'{where}: 행동 요약에 받지 않는 칸이 있다: {",".join(unknown)}')
    if summary.get('v') != 1 or not isinstance(summary.get('windowMs'), int) or isinstance(summary.get('windowMs'), bool) or not 0 <= summary['windowMs'] <= MAX_WINDOW_MS:
        refuse(f'{where}: v 또는 windowMs가 범위 밖이다')
    for key, value in summary.items():
        if key in ('v', 'windowMs'):
            continue
        ok_type = isinstance(value, int) if key in _COUNT_KEYS else isinstance(value, (int, float))
        if isinstance(value, bool) or not ok_type or value < 0:
            refuse(f'{where}: {key}가 범위 밖이다')


def read_records(path):
    rows = []
    with io.open(path, encoding='utf-8') as f:
        for i, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                r = json.loads(line, parse_constant=reject_constant)
            except ValueError as e:
                refuse(f'{i}행: JSON이 아니다: {e}')
            rows.append((i, r))
    return rows


def load_mock_people(path):
    by_person, order = {}, []
    for i, r in read_records(path):
        if not isinstance(r, dict) or set(r) != {'source', 'person', 'session', 'stratum', 'summary'} or r['source'] != 'mock':
            refuse(f'{i}행: 모의 사람 기록의 칸이 규칙 밖이다(source는 mock만 받는다)')
        if not _ID.match(str(r['person'])) or not _ID.match(str(r['session'])):
            refuse(f'{i}행: person·session이 규칙 밖이다')
        check_summary(r['summary'], 'mock', f'{i}행')
        if r['person'] not in by_person:
            by_person[r['person']] = []
            order.append(r['person'])
        by_person[r['person']].append(r)
    return by_person, order


def select_mock(by_person, order, n, tune_n, split_seed, draw_seed):
    if len(order) < tune_n + n:
        refuse(f'사람이 모자란다: {len(order)}명 < 조정용 {tune_n} + 판정용 {n}')
    ranked = sorted(order, key=lambda p: rank(split_seed, p))
    tune, pool = ranked[:tune_n], ranked[tune_n:]
    judge = sorted(pool, key=lambda p: rank(draw_seed, p))[:n]
    return [by_person[p] for p in tune], [by_person[p] for p in judge]


def register_mock(a):
    prepare_output(a)   # registration.json에 비공개 기준값이 든다
    plan, spec = parse_plan(a.plan), load_rule(a.behavior_rule, 'mock')
    by_person, order = load_mock_people(a.records)
    tune_people, judge_people = select_mock(by_person, order, plan['n'], a.tune_n, a.split_seed, a.draw_seed)
    tune_rows, judge_rows = rows_from(tune_people, judge_people)
    dataset = {'name': a.dataset_name, 'version': a.dataset_version, 'sha256': L.sha256_file(a.records), 'readme_sha256': None, 'attribution': ''}
    report = {'people_total': len(order), 'tune_people': len(tune_people), 'judge_people': len(judge_people), 'people_unusable': 0,
              'judge_records': sum(1 for r in judge_rows if r['role'] == 'judge'), 'ref_records': sum(1 for r in judge_rows if r['role'] == 'ref'),
              'dropped_rows': 0, 'capped_windows': 0, 'metadata': 'mock', 'pointer': None, 'attribution': ''}
    finish(a, 'mock', dataset, 'mock-human-v1', plan, spec, tune_rows, judge_rows, report)


def publish_registration(a):
    """공개 등록 파일을 쓴다. 이미 있으면 덮어쓰지 않는다. 쓴 뒤 측정 전에 커밋하는 일은 측정하는 사람의 몫이다."""
    reg, rule, _ = L.k6_load_registration(a.registration)
    path = os.path.join(a.root, *L.K6_REGISTRATIONS_DIR.split('/'), f'{reg["id"]}.json')
    if os.path.exists(path):
        refuse(f'공개 등록 파일이 이미 있다. 덮어쓰지 않는다: {path}')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    write_json(path, L.public_registration(reg, rule))
    print(f'공개 등록 파일을 썼다: {path}. 측정 시작 전에 이 파일만 커밋한다.')


def read_scores(path, source):
    """점수기 결과. public: person,session,behavior_risk. mock은 verdict,risk_total을 더한다(판정 전체). 빈 위험 값은 '값 없음'이고 0으로 바꾸지 않는다."""
    need = ['person', 'session', 'behavior_risk'] + (['verdict', 'risk_total'] if source == 'mock' else [])
    with io.open(path, encoding='utf-8', newline='') as f:
        rd = csv.DictReader(f)
        fields = rd.fieldnames or []
        if sorted(fields) != sorted(need):
            refuse(f'점수 파일의 칸은 {",".join(need)}이다')
        scores = {}
        for i, r in enumerate(rd, 2):
            if None in r:
                refuse(f'{i}행: 머리글보다 칸이 많다')
            key = (r['person'], r['session'])
            if key in scores:
                refuse(f'{i}행: 같은 기록의 점수가 둘이다')
            scores[key] = r
    return scores


def number(text, what, i):
    try:
        value = float(text)
    except ValueError:
        refuse(f'{i}행: {what}가 숫자가 아니다')
    if not math.isfinite(value):
        refuse(f'{i}행: {what}가 숫자가 아니다')
    return value


def sessions(a):
    outside_git(a.out_dir, '--out-dir')
    reg, rule, _ = L.k6_load_registration(a.registration)
    source = reg['source']
    scores = read_scores(a.scores, source)
    rows, confusion, strata, seen, judges = [], {'human': 0, 'bot': 0}, {}, set(), set()
    for i, r in read_records(a.records):
        if not isinstance(r, dict) or r.get('source') != source or r.get('role') not in ('judge', 'ref'):
            refuse(f'{i}행: 원천이나 역할이 사전 등록과 맞지 않는다')
        summary = r.get('summary')
        check_summary(summary, source, f'{i}행')
        key = (r.get('person'), r.get('session'))
        if key not in scores:
            refuse(f'{i}행: 이 기록의 점수가 없다')
        seen.add(key)
        s = scores[key]
        raw = s['behavior_risk'].strip()
        # 입력이 둘 미만인 공개 기록은 BehaviorScore가 볼 값이 없다(windowMs 0인 키 하나짜리 포함). 빈 값은 0으로 바꾸지 않는다
        no_input = source == 'public' and 'inputIntervalMeanMs' not in summary
        risk = None if not raw or no_input else number(raw, 'behavior_risk', i)
        if risk is not None and not 0 <= risk <= rule['ceiling']:
            refuse(f'{i}행: behavior_risk가 범위 밖이다')
        contribution = None if risk is None else round(rule['weight'] * risk, 6)
        if source == 'public':
            predicted = 'bot' if contribution is not None and contribution >= rule['criterion'] else 'human'
            row_score, extra = ('' if contribution is None else contribution), []
        else:
            if s['verdict'] not in ('bot', 'human'):
                refuse(f'{i}행: verdict는 bot·human이다')
            predicted, row_score = s['verdict'], number(s['risk_total'], 'risk_total', i)
            extra = ['' if contribution is None else contribution]
        rows.append([source, r['person'], r['role'], r.get('stratum') or '', a.round, predicted, row_score, *extra])
        if r['role'] == 'judge':
            judges.add(r['person'])
            confusion[predicted] += 1
            for name in (x for x in (r.get('stratum') or '').split(';') if x):
                c = strata.setdefault(name, {'human': 0, 'bot': 0})
                c[predicted] += 1
    extra_scores = set(scores) - seen
    if extra_scores:
        refuse(f'기록에 없는 점수가 {len(extra_scores)}개다')
    if L.people_hash(reg['salt'], judges) != reg['judge_people_sha256']:
        refuse('판정 사람 목록이 사전 등록한 목록과 다르다')
    if L.records_hash(reg['salt'], a.records) != reg['judge_records_sha256']:
        refuse('judge.jsonl의 내용이 사전 등록한 내용과 다르다')
    os.makedirs(a.out_dir, exist_ok=True)
    head = list(L.HUMAN_SESSION_COLUMNS) + (['behavior_score'] if source == 'mock' else [])
    with io.open(os.path.join(a.out_dir, 'human_sessions.csv'), 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(head)
        w.writerows(rows)
    with io.open(os.path.join(a.out_dir, 'confusion-human.csv'), 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(['tier', 'round', 'label', 'predicted', 'count', 'stratum'])
        for pred in ('human', 'bot'):
            w.writerow(['-', a.round, 'human', pred, confusion[pred], ''])
        for name in sorted(strata):
            for pred in ('human', 'bot'):
                w.writerow(['-', a.round, 'human', pred, strata[name][pred], name])
    print(f'{len(rows)}행, 판정 기록 {sum(confusion.values())}개, 기준을 넘은 판정 기록 {confusion["bot"]}개. '
          f'{a.out_dir}의 confusion-human.csv를 봇 행과 합쳐 collect.py --confusion에 넣는다. 측정이 끝나면 지운다.')


def write_verify_result(a, reg_hash, result, reason):
    """verify 결과를 비공개 등록 파일 옆에 남긴다. collect.py가 읽어 manifest에 적는다(public은 성공 결과가 있어야 한다)."""
    write_json(os.path.join(os.path.dirname(os.path.abspath(a.registration)), L.K6_VERIFY_RESULT),
               {'registration_hash': reg_hash, 'result': result, 'source_file_checked': bool(a.source_file) and result == 'ok',
                'verified_at': L.iso_utc(time.time()), 'reason': reason})


def verify(a):
    """비공개 등록 파일과 기록 파일을 다시 계산해 맞춰 본다. 성공과 실패를 결과 파일에 남긴다."""
    reg, _, reg_hash = L.k6_load_registration(a.registration)
    try:
        recompute(a, reg, reg_hash)
    except (SystemExit, *INPUT_ERRORS) as e:
        write_verify_result(a, reg_hash, 'fail', str(getattr(e, 'code', None) or e)[:300])
        raise
    write_verify_result(a, reg_hash, 'ok', None)


def recompute(a, reg, reg_hash):
    """--source-file을 주면 원본에서 뽑기와 변환까지 다시 한다."""
    judge_rows = [r for _, r in read_records(a.judge)]
    tune_rows = [r for _, r in read_records(a.tune)]
    judge_people, tune_people = {r['person'] for r in judge_rows}, {r['person'] for r in tune_rows}
    if L.people_hash(reg['salt'], judge_people) != reg['judge_people_sha256']:
        refuse('판정 사람 목록이 사전 등록한 목록과 다르다')
    if L.people_hash(reg['salt'], tune_people) != reg['tune_people_sha256']:
        refuse('조정 사람 목록이 사전 등록한 목록과 다르다')
    if judge_people & tune_people:
        refuse('조정용과 판정용에 함께 든 사람이 있다')
    counts = {}
    for r in judge_rows:
        if r['role'] == 'judge':
            counts[r['person']] = counts.get(r['person'], 0) + 1
    if len(counts) != len(judge_people) or any(c != 1 for c in counts.values()) or len(counts) != reg['plan']['n']:
        refuse('판정 기록이 사람마다 하나가 아니거나 N과 다르다')
    if a.source_file:
        if L.sha256_file(a.source_file) != reg['dataset']['sha256']:
            refuse('원본 파일의 해시가 등록과 다르다')
        n, split, draw = reg['plan']['n'], reg['seeds']['split'], reg['seeds']['draw']
        if reg['source'] == 'public':
            limits = {'files': MAX_ZIP_FILES, 'bytes': MAX_ZIP_BYTES, 'rows': MAX_ROWS, 'metadata_rows': MAX_METADATA_ROWS}
            with open_zip(a.source_file) as zf:
                names = zip_preflight(zf, limits)
                if member_sha256(zf, readme_member(names)) != reg['dataset']['readme_sha256']:
                    refuse('readme의 해시가 등록과 다르다')
                tune_p, judge_p, _ = select_aalto(zf, names, n, reg['tune_n'], split, draw, limits)
        else:
            by_person, order = load_mock_people(a.source_file)
            tune_p, judge_p = select_mock(by_person, order, n, reg['tune_n'], split, draw)
        tune_again, judge_again = rows_from(tune_p, judge_p)
        if judge_again != judge_rows or tune_again != tune_rows:
            refuse('기록이 원본에서 다시 계산한 값과 다르다')
    if L.records_hash(reg['salt'], a.judge) != reg['judge_records_sha256']:
        refuse('judge.jsonl의 내용이 사전 등록한 내용과 다르다')
    public_path = os.path.join(a.root, *L.K6_REGISTRATIONS_DIR.split('/'), f'{reg["id"]}.json')
    if os.path.exists(public_path):
        if L.load_json_strict(public_path).get('registration_hash') != reg_hash:
            refuse('공개 등록 파일의 등록 해시가 다르다')
    print(f'verify OK: {reg["id"]}, 판정 {len(judge_people)}명, 조정 {len(tune_people)}명, 등록 해시 {reg_hash}')


def positive(text):
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError('1 이상이어야 한다')
    return value


def split_args(p):
    p.add_argument('--out-dir', required=True)
    p.add_argument('--plan', required=True, help='사전 등록 N:C(예: 947:1)')
    p.add_argument('--registration-id', required=True, help='등록 이름. 공개 등록 파일 이름이 된다')
    p.add_argument('--tune-n', type=positive, default=DEFAULT_TUNE_N, help=f'조정용 사람 수(기본 {DEFAULT_TUNE_N} [가정])')
    p.add_argument('--split-seed', type=int, required=True, help='조정용·판정용을 나누는 씨앗값')
    p.add_argument('--draw-seed', type=int, required=True, help='판정용에서 n명을 뽑는 씨앗값(나누기 씨앗값과 달라야 한다)')
    p.add_argument('--behavior-rule', required=True, help='비공개 설정에서 옮긴 강도·정렬 방식·기준값·가중치·최대 위험 값(JSON, 저장소 밖)')
    p.add_argument('--max-missing-ratio', type=float, default=DEFAULT_MAX_MISSING, help=f'판정 기록 가운데 값 없음 비율 상한(기본 {DEFAULT_MAX_MISSING} [가정])')
    p.add_argument('--registered-at', help='사전 등록 시각(기본 지금, 측정 시작보다 앞서야 한다)')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('convert-aalto')
    c.add_argument('--zip', required=True, help='받아 둔 Keystrokes.zip(저장소 밖)')
    c.add_argument('--dataset-version', help='자료 판(기본 zip 파일 이름)')
    c.add_argument('--max-zip-files', type=positive, default=MAX_ZIP_FILES, help='zip 파일 수 상한(기본값보다 낮추는 쪽만 먹는다)')
    c.add_argument('--max-zip-bytes', type=positive, default=MAX_ZIP_BYTES, help='zip 풀린 크기 상한(기본값보다 낮추는 쪽만 먹는다)')
    c.add_argument('--max-rows', type=positive, default=MAX_ROWS, help='참가자 파일 행 수 상한(기본값보다 낮추는 쪽만 먹는다)')
    c.add_argument('--max-metadata-rows', type=positive, default=MAX_METADATA_ROWS, help='메타데이터 행 수 상한(기본값보다 낮추는 쪽만 먹는다)')
    split_args(c)
    c.set_defaults(fn=convert_aalto)
    m = sub.add_parser('register-mock')
    m.add_argument('--records', required=True, help='모의 사람 생성기가 쓴 JSONL')
    m.add_argument('--dataset-name', default='mock-human')
    m.add_argument('--dataset-version', required=True)
    split_args(m)
    m.set_defaults(fn=register_mock)
    u = sub.add_parser('publish-registration')
    u.add_argument('--registration', required=True, help='비공개 등록 파일')
    u.add_argument('--root', default=REPO_ROOT, help='저장소 루트(기본: 이 도구가 있는 저장소)')
    u.set_defaults(fn=publish_registration)
    s = sub.add_parser('sessions')
    s.add_argument('--records', required=True, help='judge.jsonl')
    s.add_argument('--registration', required=True, help='registration.json')
    s.add_argument('--scores', required=True, help='점수기 결과 CSV(public: person,session,behavior_risk, mock은 verdict,risk_total을 더한다)')
    s.add_argument('--out-dir', required=True)
    s.add_argument('--round', type=int, default=1)
    s.set_defaults(fn=sessions)
    v = sub.add_parser('verify')
    v.add_argument('--registration', required=True)
    v.add_argument('--judge', required=True)
    v.add_argument('--tune', required=True)
    v.add_argument('--source-file', help='원본(public은 zip, mock은 생성기 JSONL). 주면 뽑기와 변환까지 다시 계산한다')
    v.add_argument('--root', default=REPO_ROOT, help='공개 등록 파일을 찾을 저장소 루트')
    v.set_defaults(fn=verify)
    a = ap.parse_args()
    try:
        a.fn(a)
    except INPUT_ERRORS as e:
        refuse(f'{type(e).__name__}: {e}')


if __name__ == '__main__':
    main()
