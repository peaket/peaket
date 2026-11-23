// '관측 파이프라인' 대시보드(V-T50 ⑦, docs/verification.md V-T50, docs/observability.md §3 운영 확인 표의 증거 수집기·Loki 줄과 §5 '수집기 자체 신호').
// 계획 docs/review/plans/F-01-4.md §3 '대시보드'·§5. F-01-2의 dashboards.test.mjs는 그대로 두고 이 파일이 새 대시보드만 본다.
// 생성기를 바깥에서 돌린다: node tools/local/dashboards.mjs [--check] --root <임시 저장소>. 지표 이름은 시험이 정본 문서에서 따로 읽는다.
// 커밋된 파일과 생성기가 지금 만드는 파일 둘 다를 본다.
// 실행(저장소 뿌리): node --test tools/local/observability-dashboard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SCRIPT = join(HERE, 'dashboards.mjs');
const DASH = 'deploy/local/dashboards';
const PROVIDERS = 'deploy/platform/observability/grafana/provisioning/dashboards.yaml';
const DOC = 'docs/observability.md';
/** 계획 §5의 자리: platform 폴더, 파일 이름 observability-pipeline, uid peaket-observability-pipeline, 행 제목 셋의 차례 */
const FILE = 'platform/observability-pipeline.json';
const UID = 'peaket-observability-pipeline';
const ROWS = ['증거 수집기', 'OTel 수집기', 'Loki'];

function cli(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const readIn = (root, rel) => readFileSync(join(root, rel), 'utf8');
const writeIn = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const temps = [];
process.on('exit', () => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'observability-dashboard-'));
  temps.push(root);
  for (const rel of ['docs/architecture.md', '.github/CODEOWNERS']) writeIn(root, rel, readIn(REPO, rel));
  cpSync(join(REPO, DASH), join(root, DASH), { recursive: true });
  return root;
}
/** 원천만 둔 임시 저장소에 생성기를 돌린 결과 */
function generated() {
  const root = fixture();
  rmSync(join(root, DASH), { recursive: true });
  const r = cli('--root', root);
  assert.equal(r.status, 0, r.out);
  return root;
}

// ---------- 정본에서 읽은 지표 이름 ----------
const lines = readIn(REPO, DOC).split(/\r?\n/);
const backticked = (line) => [...line.matchAll(/`([a-z_*]+)(?:\{[^`]*\})?`/g)].map((m) => m[1]);
/** §3 운영 확인 표 증거 수집기 줄(웹훅·대상 수집): 지표 이름과 그 라벨 */
const evidenceLine = lines.find((l) => /^\|\s*큰 경보가 울리면 그 의존성의 DB·Redis/.test(l));
assert.ok(evidenceLine, `${DOC} 운영 확인 표의 증거 수집기 줄이 없다`);
const EVIDENCE = [...evidenceLine.matchAll(/`(evidence_[a-z_]+)\{([a-z, ]+)\}`/g)].map((m) => ({ name: m[1], labels: m[2].split(',').map((s) => s.trim()) }));
/** §3 운영 확인 표 Loki 줄 */
const lokiLine = lines.find((l) => /^\|\s*Loki가 정한 라벨 넷과 한도로/.test(l));
assert.ok(lokiLine, `${DOC} 운영 확인 표의 Loki 줄이 없다`);
const LOKI = backticked(lokiLine.split('|')[2]).filter((n) => n.startsWith('loki_'));
const lokiReasonLabel = /`loki_discarded_samples_total\{(\w+)\}`/.exec(lokiLine)?.[1];
/** §5 '수집기 자체 신호'의 항목들(머리 줄 다음, 들여쓴 '- ' 줄들) */
const head = lines.findIndex((l) => /^- 수집기 자체 신호/.test(l));
assert.ok(head >= 0, `${DOC} §5 '수집기 자체 신호'가 없다`);
const collectorItems = [];
for (let i = head + 1; i < lines.length && /^\s+- /.test(lines[i]); i++) collectorItems.push(lines[i]);
const COLLECTOR = [...new Set(collectorItems.flatMap((l) => [...l.matchAll(/`([^`]+)`/g)].flatMap((m) => m[1].match(/otelcol_[a-z_]+\*?/g) ?? [])))];
// 읽기 확인(이름 자체는 정본이 정한다): 증거 수집기 셋, 수집기 다섯(보내기 실패·큐 둘·받기 거절·판정 전 버림), Loki 둘
assert.equal(EVIDENCE.length, 3, JSON.stringify(EVIDENCE));
assert.equal(COLLECTOR.length, 5, COLLECTOR.join(','));
assert.equal(LOKI.length, 2, LOKI.join(','));
assert.ok(lokiReasonLabel);

/** 이름을 식에서 찾는 꼴: 끝의 '*'는 이름 꼬리 아무것이나, 수집기 지표는 판에 따라 붙는 _total 꼬리도 받는다 */
function metricPattern(name) {
  const base = name.endsWith('*') ? `${name.slice(0, -1)}[a-z_]+` : `${name}(?:_total)?`;
  return new RegExp(`(^|[^a-z_])${base}($|[^a-z_])`);
}

/** 행 제목 → 그 행 패널들(접힌 행은 row.panels, 펼친 행은 다음 행까지의 패널) */
function rowsOf(d) {
  const out = new Map();
  let current;
  for (const p of d.panels) {
    if (p.type === 'row') {
      current = p.title;
      out.set(current, [...(p.panels ?? [])]);
    } else if (current) out.get(current).push(p);
  }
  return out;
}
const exprs = (panels) => panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr ?? '')).filter(Boolean);

function checkPipeline(root) {
  const all = JSON.parse(readIn(root, `${DASH}/${FILE}`));
  assert.equal(all.uid, UID);
  const rows = rowsOf(all);
  assert.deepEqual([...rows.keys()], ROWS);
  for (const [title, panels] of rows) assert.ok(panels.length > 0, `${title} 행에 패널이 없다`);
  const ev = exprs(rows.get('증거 수집기'));
  for (const { name, labels } of EVIDENCE) {
    const hit = ev.filter((e) => metricPattern(name).test(e));
    assert.ok(hit.length > 0, `증거 수집기 행에 ${name}이 없다: ${ev.join(' | ')}`);
    // 패널이 정본의 라벨(대상·결과, 고른 결과, 까닭)로 나눠 보인다
    for (const l of labels) assert.ok(hit.some((e) => new RegExp(`by \\([^)]*\\b${l}\\b`).test(e)), `${name}을 ${l}로 나누지 않는다: ${hit.join(' | ')}`);
  }
  const col = exprs(rows.get('OTel 수집기'));
  for (const name of COLLECTOR) assert.ok(col.some((e) => metricPattern(name).test(e)), `OTel 수집기 행에 ${name}이 없다: ${col.join(' | ')}`);
  // 큐 사용률은 한 식에서 크기 ÷ 용량
  const size = COLLECTOR.find((n) => /queue_size$/.test(n));
  const cap = COLLECTOR.find((n) => /queue_capacity$/.test(n));
  assert.ok(col.some((e) => metricPattern(size).test(e) && metricPattern(cap).test(e) && e.indexOf(size) < e.indexOf('/') && e.indexOf('/') < e.indexOf(cap)), `큐 사용률 식이 없다: ${col.join(' | ')}`);
  const lk = exprs(rows.get('Loki'));
  for (const name of LOKI) assert.ok(lk.some((e) => metricPattern(name).test(e)), `Loki 행에 ${name}이 없다: ${lk.join(' | ')}`);
  assert.ok(lk.some((e) => /loki_discarded_samples_total/.test(e) && new RegExp(`by \\([^)]*\\b${lokiReasonLabel}\\b`).test(e)), `까닭별 거절이 없다: ${lk.join(' | ')}`);
  // 집계 창과 데이터 소스는 기존 생성기와 같다($__rate_interval, uid prometheus)
  const every = exprs([...rows.values()].flat());
  for (const e of every) if (/\b(rate|increase)\(/.test(e)) assert.match(e, /\[\$__rate_interval\]/, e);
  for (const p of [...rows.values()].flat()) for (const t of p.targets ?? []) assert.equal((t.datasource ?? p.datasource)?.uid, 'prometheus', p.title);
  return all;
}

test('V-T50 ⑦ 관측 파이프라인 대시보드에 세 행의 패널이 있다', async () => {
  const gen = generated();
  for (const root of [REPO, gen]) checkPipeline(root);
  assert.equal(readIn(gen, `${DASH}/${FILE}`), readIn(REPO, `${DASH}/${FILE}`));
  // platform 폴더를 싣는 공급자가 있다(그 폴더에 실린다)
  const providers = parse(readIn(REPO, PROVIDERS)).providers.filter((p) => p.options.path.endsWith('/platform'));
  assert.equal(providers.length, 1);
  // 내보낸 자리 상수(계획 §5)
  const mod = await import(pathToFileURL(SCRIPT).href);
  assert.deepEqual(mod.PIPELINE_DASHBOARD, { name: 'observability-pipeline', uid: UID, folder: 'platform' });
  const ok = cli('--check');
  assert.equal(ok.status, 0, ok.out);
  // 대시보드 파일을 지우면 --check가 1, 쓰기 모드는 다시 만든다
  const removed = fixture();
  rmSync(join(removed, DASH, FILE));
  const r = cli('--check', '--root', removed);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /없다: .*observability-pipeline\.json/);
  assert.equal(cli('--root', removed).status, 0);
  assert.ok(existsSync(join(removed, DASH, FILE)));
  // 손으로 Loki 행을 지우면 --check가 1
  const edited = fixture();
  const d = JSON.parse(readIn(edited, `${DASH}/${FILE}`));
  const lokiRow = d.panels.findIndex((p) => p.type === 'row' && p.title === 'Loki');
  writeIn(edited, `${DASH}/${FILE}`, `${JSON.stringify({ ...d, panels: d.panels.slice(0, lokiRow) }, null, 2)}\n`);
  const e = cli('--check', '--root', edited);
  assert.equal(e.status, 1, e.out);
  assert.match(e.out, /다르다: .*observability-pipeline\.json/);
});
