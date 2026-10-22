"""perf-ledger/runs/*/manifest.json을 읽어 docs/perf-ledger.md의 장부 표를 다시 쓴다.

사용: python tools/perf-ledger/index.py [--root DIR]
"""
import argparse
import glob
import io
import os
import sys

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


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root')
    a = p.parse_args()
    rebuild(a.root or L.find_root())


if __name__ == '__main__':
    main()
