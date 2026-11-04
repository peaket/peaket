// K5 PoC 결과를 프로젝트마다 중앙값·최댓값으로 모은다(seatmap/RESULT.md의 표).
//   node seatmap/report.mjs [보고서 폴더]   (기본 reports/seatmap, 컨테이너 결과는 reports/docker-seatmap/reports/seatmap)
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? new URL('../reports/seatmap', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const runs = new Map();
for (const f of readdirSync(dir).filter((x) => /-\d+\.json$/.test(x))) {
  const r = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
  if (!runs.has(r.project)) runs.set(r.project, []);
  runs.get(r.project).push(r);
}
const pick = {
  '단계 3 합': (r) => r.stage3Ms,
  '단계 3 판정 어림': (r) => r.judged.stage3Ms,
  '단계 5 합': (r) => r.stage5Ms,
  '단계 5 판정 어림': (r) => r.judged.stage5Ms,
  'Worker 시작까지': (r) => r.workerBootMs,
  '받기': (r) => r.fetchMs,
  'JSON 풀기': (r) => r.parseMs,
  '형식 배열': (r) => r.decodeMs,
  '격자 색인': (r) => r.gridMs,
  '전체 배치도 그리기(끝내기 포함)': (r) => r.overviewDrawMs,
  '첫 프레임 기다림': (r) => r.stage5Ms - r.overviewDrawMs,
  '중간 배율 8,700석 그리기': (r) => r.mid.directMs,
  '중간 배율 구역 비트맵 미리 그리기': (r) => r.mid.prerenderMs,
  '구역 비트맵 붙이기': (r) => r.mid.blitMs,
  '고를 수 있는 배율 418석 그리기': (r) => r.close.ms,
  '바뀐 100석 덧칠': (r) => r.deltaMs,
  '누른 좌석 찾기(µs)': (r) => r.hitAvgUs,
  '메시지 처리 p95(풀기 포함)': (r) => r.messages.handleP95Ms,
  '메시지 처리 최대': (r) => r.messages.handleMaxMs,
  '메시지 전달 지연 p95': (r) => r.messages.latencyP95Ms,
  '긴 작업 수': (r) => (r.longTasks === null ? null : r.longTasks.length),
};
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
};
const fmt = (v) => (v === null ? '잴 수 없음' : Number.isInteger(v) ? String(v) : v.toFixed(1));
const projects = [...runs.keys()].sort();
console.log(`| 항목 | ${projects.map((p) => `${p}(${runs.get(p).length}번, 중앙값/최대)`).join(' | ')} |`);
console.log(`| --- | ${projects.map(() => '---').join(' | ')} |`);
for (const [label, f] of Object.entries(pick)) {
  const cells = projects.map((p) => {
    const vals = runs.get(p).map(f);
    if (vals.some((v) => v === null)) return '잴 수 없음';
    return `${fmt(med(vals))} / ${fmt(Math.max(...vals))}`;
  });
  console.log(`| ${label} | ${cells.join(' | ')} |`);
}
