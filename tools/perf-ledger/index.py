"""perf-ledger/runs/*/manifest.json을 읽어 docs/perf-ledger.md의 장부 표를 다시 쓴다.
--stamp를 주면 그날 끝난 실행들의 해시 묶음을 OpenTimestamps로 고정한다(docs/perf-ledger.md §9).

사용: python tools/perf-ledger/index.py [--root DIR] [--stamp [YYYY-MM-DD]] [--upgrade]
"""
import argparse
import glob
import io
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledgerlib as L  # noqa: E402

HEADER = ('| 날짜 | 측정 ID | KPI | 버전 | 프로파일 | 규모 | p99(ms) | 오류율 | 판정 | 비용(원) | 폴더 |\n'
          '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n')


def row_for(root, manifest_path):
    m = L.load_json(manifest_path)
    run_id = m.get('run_id') or os.path.basename(os.path.dirname(manifest_path))
    k6 = m.get('k6') or {}
    sc = m.get('scale') or {}
    scale = []
    if sc.get('users'):
        scale.append(f"{sc['users']:,}명")
    if sc.get('arrival_rps'):
        scale.append(f"{sc['arrival_rps']:,.0f} RPS")
    verdict = m.get('verdict') or '미판정'
    k6s = L.k6_summary(m.get('k6_eval'), m.get('k6_cost'))
    if k6s:
        verdict = f'{verdict}({k6s})'
    if m.get('valid') is False:
        verdict = f"무효({(m.get('invalid_reason') or '')[:30]})"
    cost = m.get('cost_krw')
    return (run_id, f"| {run_id[:10]} | {run_id} | {m.get('kpi','')} | {m.get('version','')} | {m.get('profile','')} | "
            f"{', '.join(scale) or '-'} | {L.fmt_num(k6.get('p99_ms'))} | {L.fmt_pct(k6.get('error_rate'))} | {verdict} | "
            f"{L.fmt_num(cost) if cost is not None else '-'} | perf-ledger/runs/{run_id}/ |")


def rebuild(root):
    paths = glob.glob(os.path.join(root, L.RUNS, '*', 'manifest.json'))
    rows = sorted(row_for(root, p) for p in paths)
    table = HEADER + ('\n'.join(r for _, r in rows) if rows else '| (아직 없음) | | | | | | | | | | |') + '\n'
    doc_path = os.path.join(root, L.LEDGER_DOC)
    doc = io.open(doc_path, encoding='utf-8', newline='').read()
    b, e = '<!-- ledger:begin -->', '<!-- ledger:end -->'
    i, j = doc.find(b), doc.find(e)
    if i < 0 or j < 0 or j < i:
        raise SystemExit('docs/perf-ledger.md에 ledger 마커가 없습니다')
    new = doc[:i + len(b)] + '\n' + table + doc[j:]
    io.open(doc_path, 'w', encoding='utf-8', newline='').write(new)
    print(f'장부 표 갱신: {len(rows)}행')
    return len(rows)


def run_ots(args):
    """OpenTimestamps 클라이언트(`ots`)를 부른다. 성공이면 None, 실패면 이유."""
    try:
        out = subprocess.run(['ots'] + args, capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.SubprocessError) as e:
        return f'{type(e).__name__}: {e}(OpenTimestamps 클라이언트 `ots`가 필요하다)'
    return None if out.returncode == 0 else (out.stderr or out.stdout).strip()[:300]


def run_day(m):
    """실행이 끝난 날(UTC). ended_at이 없으면 collected_at."""
    ts = m.get('ended_at') or m.get('collected_at')
    return L.iso_utc(L.parse_time(ts))[:10] if ts else None


def stamp(root, day):
    """그날 끝난 실행들의 SHA256SUMS 해시를 timestamps/<날짜>.txt로 모으고 `ots stamp`로 고정한다(docs/perf-ledger.md §9).

    이미 고정한(.ots가 있는) 날의 목록이 달라지면 증명이 깨지므로 거부한다. 같은 내용이면 다시 쓰지 않는다.
    """
    rows = []
    for mp in sorted(glob.glob(os.path.join(root, L.RUNS, '*', 'manifest.json'))):
        run_dir = os.path.dirname(mp)
        sums = os.path.join(run_dir, 'SHA256SUMS')
        if run_day(L.load_json(mp)) == day and os.path.exists(sums):
            rows.append(f'{L.sha256_file(sums)}  runs/{os.path.basename(run_dir)}/SHA256SUMS')
    if not rows:
        print(f'{day}에 끝난 실행이 없어 고정할 것이 없다')
        return None
    body = '\n'.join(rows) + '\n'
    tdir = os.path.join(root, L.TIMESTAMPS)
    os.makedirs(tdir, exist_ok=True)
    path = os.path.join(tdir, f'{day}.txt')
    old = io.open(path, encoding='utf-8', newline='').read() if os.path.exists(path) else None
    if old is not None and old != body and os.path.exists(path + '.ots'):
        raise SystemExit(f'{path}는 이미 고정했는데 그날 실행의 해시 목록이 달라졌다(고정 뒤 변경). 고치지 않고 원인을 본다')
    if old != body:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(body)
    print(f'하루 해시 묶음: {path} ({len(rows)}개 실행)')
    if os.path.exists(path + '.ots'):
        print('이미 OpenTimestamps 증명이 있다(확정은 --upgrade)')
        return path
    err = run_ots(['stamp', path])
    if err:
        raise SystemExit(f'ots stamp 실패: {err}')
    print(f'OpenTimestamps 증명: {path}.ots (확정되면 --upgrade로 갱신해 Git에 넣는다)')
    return path


def upgrade(root):
    """timestamps/*.ots를 확정 증명으로 갱신한다(`ots upgrade`). 아직 확정 전인 것은 다음에 다시 한다."""
    done, pending = 0, []
    for ots in sorted(glob.glob(os.path.join(root, L.TIMESTAMPS, '*.ots'))):
        err = run_ots(['upgrade', ots])
        if err:
            pending.append(f'{os.path.basename(ots)}: {err}')
        else:
            done += 1
    print(f'증명 갱신: {done}개' + (', 아직 안 됨: ' + '; '.join(pending) if pending else ''))
    return done, pending


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root')
    p.add_argument('--stamp', nargs='?', const='', metavar='YYYY-MM-DD',
                   help='그날(기본: 오늘, UTC) 끝난 실행들의 SHA256SUMS 해시를 timestamps/<날짜>.txt로 모아 OpenTimestamps로 고정한다')
    p.add_argument('--upgrade', action='store_true', help='timestamps/*.ots를 확정 증명으로 갱신한다')
    a = p.parse_args()
    if a.stamp and not re.match(r'^\d{4}-\d{2}-\d{2}$', a.stamp):
        p.error('--stamp 날짜는 YYYY-MM-DD다')
    root = a.root or L.find_root()
    rebuild(root)
    if a.stamp is not None:
        stamp(root, a.stamp or L.iso_utc(time.time())[:10])
    if a.upgrade:
        upgrade(root)


if __name__ == '__main__':
    main()
