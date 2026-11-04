// FE-T36 크기 기록(reports/sizes/*.json, css.spec.mjs가 남긴다)을 표로 모은다(seed-css/RESULT.md에 옮긴다).
//   node seed-css/report.mjs [--baseline]   --baseline이면 예산을 넘은 경로의 기준선 파일(css-baseline.json)을 새로 쓴다
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const dir = new URL('../reports/sizes/', import.meta.url);
if (!existsSync(dir)) {
  console.error('reports/sizes/가 없다: 먼저 playwright test -c playwright.layers.config.mjs --project=css');
  process.exit(2);
}
const rows = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')))
  .sort((a, b) => a.key.localeCompare(b.key));
console.log('| 앱·경로 | §5.8 경로 묶음 | 첫 화면 CSS(gzip, kB) | 예산(kB) | 판정 |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of rows) console.log(`| ${r.key} | ${r.row} | ${r.kB} | ${r.budget} | ${r.overBudget ? `예산 초과(+${(r.kB - r.budget).toFixed(1)})` : '예산 안'} |`);

if (process.argv.includes('--baseline')) {
  const path = new URL('./css-baseline.json', import.meta.url);
  const cur = JSON.parse(readFileSync(path, 'utf8'));
  cur.pages = Object.fromEntries(rows.filter((r) => r.overBudget).map((r) => [r.key, r.kB]));
  writeFileSync(path, `${JSON.stringify(cur, null, 2)}\n`);
  console.log(`기준선 ${Object.keys(cur.pages).length}개를 css-baseline.json에 썼다`);
}
