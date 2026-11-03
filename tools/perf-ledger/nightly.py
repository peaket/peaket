"""야간 축소 성능 상대 비교(docs/devops.md §3.3 '축소 성능 시험의 판정', D-T40, ADR-0133 낮음-016).

같은 러너에서 기준판과 새 판을 번갈아(기준·새·기준·새…) 재고, 판별 p99 중앙값의 비율(새 ÷ 기준)로 판정한다.
날짜가 다른 두 실행의 p99를 견주지 않는다. 기준값(max_ratio)은 A/A 실행 10번의 가장 큰 벗어남으로 정하고,
정하기 전에는 경고만 한다.

사용:
  python tools/perf-ledger/nightly.py run --config loadtest/nightly/config.json --out results.json [--k6 명령 …]
  python tools/perf-ledger/nightly.py compare --results results.json --threshold loadtest/nightly/threshold.json [--alert-out alert.md]
  python tools/perf-ledger/nightly.py aa-threshold --results a1.json … a10.json --out loadtest/nightly/threshold.json
  python tools/perf-ledger/nightly.py aa --config loadtest/nightly/config-aa.json --runs 10 --out-dir .cache/aa [--deadline-s 19000]

설정 파일: {"scenario": k6 시나리오 경로, "rounds": 판마다 실행 수, "prepare": 준비 명령(인자 목록), "k6": k6를 부를 명령(인자 목록, 없어도 된다)}.
k6 명령은 --k6 인자, 설정의 k6, 기본(다이제스트 고정 이미지를 docker로) 순으로 고른다(BSL-090: v0 시나리오는 실행 도구가 kind 안에서 돌린다).
aa는 준비 명령을 한 번만 부르고 A/A 측정(판마다 rounds번씩 번갈아)을 runs번 해 aa-NN.json을 쓰고, 10번 이상이면 threshold.json도 쓴다.
준비 명령은 두 판을 올린 뒤 마지막 줄에 {"base_url": …, "new_url": …}를 낸다. 셸을 거치지 않고 부른다.
종료 코드: compare는 통과·경고 0, 기준값을 넘음 1. 입력이 틀리거나 준비 명령·k6가 실패하면 모든 명령이 2.
"""
import argparse
import datetime as dt
import io
import json
import math
import os
import statistics
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledgerlib as L  # noqa: E402

# loadtest/poc/stack.mjs와 같은 다이제스트 고정 k6 이미지(docs/devops.md §4.4)
K6_IMAGE = 'grafana/k6:1.4.2@sha256:3656673de3f30424e8ebcfa46acd9558d83b6a43612d0f668ffeac953950c6c7'
SUMMARY_DIR = os.path.join('.cache', 'nightly')
ALERT_TITLE = '[SEV3] 야간 축소 성능 시험 실패'
AA_MIN_RUNS = 10  # 기준값을 정하는 A/A 실행 수 [가정](docs/devops.md §3.3)
K6_THRESHOLDS_FAILED = 99  # k6가 시나리오 기준(thresholds)을 넘었을 때의 종료 코드. 요약은 그대로 남는다
# 실패한 명령의 출력 가운데 오류에 붙이는 끝부분(글자 수). 300자면 실행 도구의 진행 글에 묻혀 까닭이 잘렸다(2026-11-03 러너 A/A 실행)
ERR_TAIL = 2000


class InputError(ValueError):
    pass


def fail_input(msg):
    print(f'::error::입력이 틀렸다: {msg}', file=sys.stderr)
    sys.exit(2)


def load(path, what):
    try:
        return L.load_json_strict(path)
    except (OSError, ValueError) as e:
        raise InputError(f'{what}를 읽지 못했다({path}): {e}')


def check_config(c):
    if not isinstance(c, dict) or set(c) - {'scenario', 'rounds', 'prepare', 'k6'}:
        raise InputError('설정은 scenario·rounds·prepare·k6만 둔다')
    if not isinstance(c.get('scenario'), str) or not c['scenario']:
        raise InputError('scenario는 k6 시나리오 경로다')
    r = c.get('rounds')
    if isinstance(r, bool) or not isinstance(r, int) or not 1 <= r <= 50:
        raise InputError('rounds는 1~50 정수다')
    p = c.get('prepare')
    # 셸 문자열은 받지 않는다: 인자 목록만(ASVS v5.0.0-1.2.5)
    if not isinstance(p, list) or not p or not all(isinstance(x, str) and x for x in p):
        raise InputError('prepare는 빈 글이 없는 인자 목록이다(셸 문자열 아님)')
    k = c.get('k6')
    if 'k6' in c and (not isinstance(k, list) or not k or not all(isinstance(x, str) and x for x in k)):
        raise InputError('k6는 빈 글이 없는 인자 목록이다(셸 문자열 아님)')
    return c


def check_threshold(t):
    if not isinstance(t, dict) or set(t) - {'max_ratio', 'aa_ratios', 'decided_at', 'basis'}:
        raise InputError('기준값 파일은 max_ratio·aa_ratios·decided_at·basis만 둔다')
    m = t.get('max_ratio')
    if m is not None and (isinstance(m, bool) or not isinstance(m, (int, float)) or not math.isfinite(m) or m < 1):
        raise InputError('max_ratio는 비우거나 1 이상의 수다')
    return t


def check_results(r):
    ratio = r.get('ratio') if isinstance(r, dict) else None
    if isinstance(ratio, bool) or not isinstance(ratio, (int, float)) or not math.isfinite(ratio) or ratio <= 0:
        raise InputError('결과 파일에 양수 ratio가 없다')
    return r


def summary_p99(path):
    m = (load(path, 'k6 요약').get('metrics') or {}).get('http_req_duration') or {}
    v = (m.get('values', m) if isinstance(m, dict) else {}).get('p(99)')
    if not isinstance(v, (int, float)):
        raise InputError(f'k6 요약에 http_req_duration p(99)가 없다: {path}')
    return float(v)


def call(cmd, what, timeout, deadline):
    """명령 하나를 부른다. 한 번의 상한(timeout)과 전체 기한(deadline, monotonic 시각) 가운데 이른 쪽에서 끊는다."""
    left = deadline - time.monotonic()
    if left <= 0:
        raise InputError(f'전체 기한을 넘겨 {what}를 부르지 않았다')
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=min(timeout, left))
    except subprocess.TimeoutExpired:
        raise InputError(f'{what}가 기한을 넘겨 끊었다(한 번 {timeout}초, 전체 기한 남은 {int(left)}초)')
    except OSError as e:
        raise InputError(f'{what}를 부르지 못했다({cmd[0]}): {e}')


def prepare_targets(cmd, deadline):
    out = call(cmd, '준비 명령', 1800, deadline)
    if out.returncode != 0:
        raise InputError(f'준비 명령 실패({out.returncode}): {(out.stderr or out.stdout).strip()[-ERR_TAIL:]}')
    last = next((ln for ln in reversed(out.stdout.splitlines()) if ln.strip()), '')
    try:
        t = json.loads(last)
    except ValueError:
        t = None
    if not isinstance(t, dict):
        raise InputError('준비 명령의 마지막 줄이 JSON 객체가 아니다')
    for k in ('base_url', 'new_url'):
        if not isinstance(t.get(k), str) or not t[k].startswith(('http://', 'https://')):
            raise InputError(f'준비 명령이 낸 {k}가 http(s) 주소가 아니다')
    return t['base_url'], t['new_url']


def k6_command(a, c):
    """k6를 부를 명령: --k6 인자, 설정의 k6, 기본(다이제스트 고정 이미지를 docker로) 순"""
    if a.k6:
        return a.k6
    if c.get('k6'):
        return list(c['k6'])
    # 공식 k6 이미지는 사용자 12345로 돈다. 러너 사용자의 폴더에 요약을 쓸 수 있게 같은 사용자로 돌린다(새 맥락 리뷰)
    user = ['--user', f'{os.getuid()}:{os.getgid()}'] if hasattr(os, 'getuid') else []
    return ['docker', 'run', '--rm', '--network', 'host', *user, '-v', f'{os.getcwd()}:/w', '-w', '/w', K6_IMAGE]


def run(a):
    c = check_config(load(a.config, '설정'))
    # 결과 폴더는 측정 전에 만든다. 측정을 다 하고 쓰다가 폴더가 없어 결과를 잃지 않게(2026-11-03 30ms 지연 판 실행에서 재현)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    # 전체 기한을 잡 시간 제한보다 짧게 두어, 멈춘 k6도 잡 취소가 아니라 실패(SEV3 알림)로 끝나게 한다(새 맥락 리뷰)
    deadline = time.monotonic() + a.deadline_s
    k6 = k6_command(a, c)
    base_url, new_url = prepare_targets(c['prepare'], deadline)
    result = measure(c, k6, base_url, new_url, deadline, '')
    with io.open(a.out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f'중앙값: 기준 {result["base_p99_ms"]}ms, 새 {result["new_p99_ms"]}ms, 비율 {result["ratio"]}')


def measure(c, k6, base_url, new_url, deadline, prefix):
    """기준·새를 번갈아 rounds번씩 재고 결과(판별 p99 중앙값과 비율)를 돌려준다. 요약 파일 이름은 prefix로 실행마다 나눈다"""
    os.makedirs(SUMMARY_DIR, exist_ok=True)
    started, runs = L.iso_utc(dt.datetime.now(dt.timezone.utc).timestamp()), []
    for i in range(c['rounds']):
        for side, url in (('base', base_url), ('new', new_url)):
            # 요약 파일은 작업 폴더 안의 상대 경로에 둔다(컨테이너 k6도 /w로 같은 자리를 본다)
            summary = os.path.join(SUMMARY_DIR, f'{prefix}{i:02d}-{side}.json').replace('\\', '/')
            # 지난 실행의 요약을 다시 읽지 않게 먼저 지운다(쓰기가 실패한 회차가 옛 p99로 통과하지 않게)
            if os.path.exists(summary):
                os.remove(summary)
            cmd = k6 + ['run', '--quiet', '--summary-trend-stats', 'med,p(95),p(99),max',
                        '--summary-export', summary, '-e', f'BASE_URL={url}', c['scenario']]
            r = call(cmd, 'k6', 1800, deadline)
            # 시나리오 기준을 넘은 종료(99)도 요약이 있으면 견준다. 크게 나빠진 밤일수록 이 경우라 알림을 놓치지 않게 한다
            if r.returncode not in (0, K6_THRESHOLDS_FAILED) or not os.path.exists(summary):
                raise InputError(f'k6 실패({side} {i + 1}번째, 종료 {r.returncode}, 요약 {"있음" if os.path.exists(summary) else "없음"}): '
                                 f'{(r.stderr or r.stdout).strip()[-ERR_TAIL:]}')
            runs.append({'round': i + 1, 'side': side, 'p99_ms': summary_p99(summary)})
            print(f'{side} {i + 1}/{c["rounds"]}: p99 {runs[-1]["p99_ms"]}ms')
    base = statistics.median(x['p99_ms'] for x in runs if x['side'] == 'base')
    new = statistics.median(x['p99_ms'] for x in runs if x['side'] == 'new')
    return {'scenario': c['scenario'], 'rounds': c['rounds'], 'started_at': started,
            'ended_at': L.iso_utc(dt.datetime.now(dt.timezone.utc).timestamp()), 'runs': runs,
            'base_p99_ms': base, 'new_p99_ms': new, 'ratio': round(new / base, 6) if base else None}


def aa(a):
    """A/A 실행 runs번(D-T40 ①): 준비 명령은 한 번만 부르고, 실행마다 aa-NN.json을 쓰고, 10번 이상이면 threshold.json도 쓴다"""
    if isinstance(a.runs, bool) or not isinstance(a.runs, int) or not 1 <= a.runs <= 50:
        raise InputError('--runs는 1~50 정수다')
    c = check_config(load(a.config, '설정'))
    deadline = time.monotonic() + a.deadline_s
    k6 = k6_command(a, c)
    # 결과 폴더를 준비 명령 전에 만든다(새로 받은 저장소의 .cache/aa처럼 없을 수 있다. 첫 A/A를 다 잰 뒤에 쓰기가 실패하지 않게)
    os.makedirs(a.out_dir, exist_ok=True)
    base_url, new_url = prepare_targets(c['prepare'], deadline)
    ratios = []
    for n in range(1, a.runs + 1):
        result = measure(c, k6, base_url, new_url, deadline, f'aa{n:02d}-')
        with io.open(os.path.join(a.out_dir, f'aa-{n:02d}.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        check_results(result)
        ratios.append(result['ratio'])
        print(f'A/A {n}/{a.runs}: 비율 {result["ratio"]}')
    if len(ratios) < AA_MIN_RUNS:
        print(f'A/A 결과가 {len(ratios)}개다. {AA_MIN_RUNS}개 이상이어야 기준값을 정하므로 threshold.json은 쓰지 않는다(docs/devops.md §3.3)')
        return
    write_threshold(ratios, os.path.join(a.out_dir, 'threshold.json'))


def set_output(**kv):
    path = os.environ.get('GITHUB_OUTPUT')
    if path:
        with io.open(path, 'a', encoding='utf-8') as f:
            for k, v in kv.items():
                f.write(f'{k}={v}\n')


def compare(a):
    r = check_results(load(a.results, '결과'))
    t = check_threshold(load(a.threshold, '기준값'))
    ratio, limit = r['ratio'], t.get('max_ratio')
    line = f'p99 중앙값 비율(새 ÷ 기준) {ratio} (기준 {r.get("base_p99_ms")}ms, 새 {r.get("new_p99_ms")}ms)'
    if limit is None:
        set_output(verdict='warn')
        print(f'::warning::기준값(max_ratio)을 정하기 전이라 경고만 한다(A/A 10번 뒤 정함, D-T40 ③): {line}')
        return 0
    if ratio > limit:
        set_output(verdict='fail')
        print(f'::error::기준값 {limit}을 넘었다: {line}')
        if a.alert_out:
            body = (f'# {ALERT_TITLE}\n\n- 심각도: SEV3(docs/devops.md §3.3, D-T40 ②)\n- {line}\n- 기준값 max_ratio: {limit}'
                    f'({t.get("basis") or "A/A 실행의 가장 큰 벗어남"})\n- 시나리오: {r.get("scenario")}, 판마다 {r.get("rounds")}번\n'
                    f'- 실행: {r.get("started_at")} ~ {r.get("ended_at")}\n')
            with io.open(a.alert_out, 'w', encoding='utf-8', newline='\n') as f:
                f.write(body)
        return 1
    set_output(verdict='pass')
    print(f'통과(기준값 {limit} 이하): {line}')
    return 0


def aa_threshold(a):
    ratios = [check_results(load(p, 'A/A 결과'))['ratio'] for p in a.results]
    if len(ratios) < AA_MIN_RUNS:
        raise InputError(f'A/A 결과가 {len(ratios)}개다. {AA_MIN_RUNS}개 이상 있어야 기준값을 정한다(docs/devops.md §3.3)')
    write_threshold(ratios, a.out)


def write_threshold(ratios, out):
    dev = max(abs(x - 1) for x in ratios)
    t = {'max_ratio': round(1 + dev, 6), 'aa_ratios': ratios, 'decided_at': L.iso_utc(dt.datetime.now(dt.timezone.utc).timestamp())[:10],
         'basis': f'A/A 실행 {len(ratios)}번의 가장 큰 벗어남 {round(dev, 6)}'}
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(t, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'기준값 max_ratio {t["max_ratio"]} ({t["basis"]})')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('run')
    r.add_argument('--config', required=True)
    r.add_argument('--out', required=True)
    r.add_argument('--k6', nargs='+', help='k6를 부를 명령(기본: 다이제스트 고정 이미지를 docker로)')
    r.add_argument('--deadline-s', type=int, default=7000, help='준비 명령과 k6 실행 전체의 기한(초). 잡 시간 제한보다 짧게 둔다')
    c = sub.add_parser('compare')
    c.add_argument('--results', required=True)
    c.add_argument('--threshold', required=True)
    c.add_argument('--alert-out', help='기준값을 넘으면 SEV3 이슈 본문을 이 파일에 쓴다')
    t = sub.add_parser('aa-threshold')
    t.add_argument('--results', nargs='+', required=True)
    t.add_argument('--out', required=True)
    x = sub.add_parser('aa', help='A/A 실행 여러 번과 기준값(D-T40 ①)')
    x.add_argument('--config', required=True)
    x.add_argument('--runs', type=int, required=True)
    x.add_argument('--out-dir', required=True)
    x.add_argument('--k6', nargs='+', help='k6를 부를 명령(기본: 설정의 k6, 없으면 다이제스트 고정 이미지를 docker로)')
    x.add_argument('--deadline-s', type=int, default=19000, help='준비 명령과 모든 실행의 기한(초)')
    a = p.parse_args()
    try:
        if a.cmd == 'run':
            run(a)
        elif a.cmd == 'aa':
            aa(a)
        elif a.cmd == 'compare':
            sys.exit(compare(a))
        else:
            aa_threshold(a)
    except (InputError, subprocess.TimeoutExpired) as e:
        fail_input(str(e))


if __name__ == '__main__':
    main()
