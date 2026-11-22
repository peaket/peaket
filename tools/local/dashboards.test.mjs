// 대시보드 대상·폴더·온세일 공용(V-T47 ①②③, docs/verification.md V-T47, docs/observability.md §2 '대시보드 거버넌스'·§3 '템플릿 대시보드'·
// '대상·폴더·조직', ADR-0356 결정 1).
// 생성기를 바깥에서 돌린다: node tools/local/dashboards.mjs [--check] --root <임시 저장소>. 임시 저장소에는 docs/architecture.md(§3.1 서비스 맵),
// .github/CODEOWNERS, deploy/local/dashboards/를 복사하고 사례마다 한 곳을 바꾼다. 끝 코드 0 같음, 1 다름·빠짐·남음, 2 원천 읽기 실패.
// 대상 서비스와 주인 팀은 시험이 정본(§3.1 표·CODEOWNERS)을 따로 읽어 정하고, 커밋된 파일과 생성기가 지금 만드는 파일 둘 다와 견준다
// (생성기가 표의 줄을 놓치거나 주석을 빼도 보이게).
// 실행(저장소 뿌리): node --test tools/local/dashboards.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SCRIPT = join(HERE, 'dashboards.mjs');
const DASH = 'deploy/local/dashboards';
const PROVIDERS = 'deploy/platform/observability/grafana/provisioning/dashboards.yaml';
/** docs/architecture.md §3.1 서비스 맵 표의 업무 서비스(2026-11-23 정본, 표 차례) */
const SERVICE_MAP = ['queue-svc', 'admission-ctrl', 'purchase-svc', 'payment-svc', 'ticket-svc', 'realtime-gw', 'identity-svc', 'trust-svc', 'ops-svc', 'core-svc'];
/** 네 신호(docs/observability.md §3 '템플릿 대시보드') */
const FOUR_SIGNALS = ['지연', '트래픽', '오류', '포화도'];

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
  const root = mkdtempSync(join(tmpdir(), 'dashboards-'));
  temps.push(root);
  for (const rel of ['docs/architecture.md', '.github/CODEOWNERS']) writeIn(root, rel, readIn(REPO, rel));
  cpSync(join(REPO, DASH), join(root, DASH), { recursive: true });
  return root;
}
/** 대시보드 폴더 없이 원천만 둔 임시 저장소에 생성기를 돌린 결과(커밋된 파일이 아니라 생성기가 지금 만드는 것) */
function generated() {
  const root = fixture();
  rmSync(join(root, DASH), { recursive: true });
  const r = cli('--root', root);
  assert.equal(r.status, 0, r.out);
  return root;
}
/** '<폴더>/<파일>.json' 목록 */
function files(root) {
  const dir = join(root, DASH);
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? readdirSync(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name])).sort();
}

/** 시험이 따로 읽은 §3.1 표 첫 칸(제목 '### 3.1' 뒤 첫 표의 모든 줄) */
function serviceMapFromDoc(root) {
  const lines = readIn(root, 'docs/architecture.md').split(/\r?\n/);
  const out = [];
  let i = lines.findIndex((l) => l.startsWith('### 3.1 '));
  while (i < lines.length && !lines[i].startsWith('| 서비스명')) i++;
  for (i += 1; i < lines.length && lines[i].startsWith('|'); i++) {
    const first = lines[i].split('|')[1].trim().replace(/`/g, '');
    if (!/^-+$/.test(first)) out.push(first);
  }
  return out;
}
/** 시험이 따로 읽은 CODEOWNERS 주인 팀: '/services/<서비스>/' 줄(주인 하나)의 팀, 없으면 '/services/' 줄의 팀 */
function ownerTeam(root, service) {
  const rows = readIn(root, '.github/CODEOWNERS').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim().split(/\s+/)).filter((x) => x[0]);
  const own = rows.filter((r) => r[0] === `/services/${service}/` && r.length === 2).at(-1) ?? rows.filter((r) => r[0] === '/services/').at(-1);
  return own[1].replace('@peaket/', '');
}
const firstRowTitles = (d) => {
  const rows = d.panels.filter((p) => p.type === 'row');
  return d.panels.slice(d.panels.indexOf(rows[0]) + 1, d.panels.indexOf(rows[1])).map((p) => p.title);
};

test('V-T47 ① §3.1의 업무 서비스마다 대시보드가 있고 첫 행이 네 신호다', () => {
  // 시험이 읽은 표가 정본의 열 서비스(마지막 줄 core-svc까지)를 모두 담는다
  const names = serviceMapFromDoc(REPO);
  for (const s of SERVICE_MAP) assert.ok(names.includes(s), `§3.1 표에 ${s}`);
  const gen = generated();
  assert.deepEqual(files(gen), files(REPO));
  for (const root of [REPO, gen]) {
    const all = files(root);
    for (const s of names) {
      const rel = all.filter((f) => f.endsWith(`/${s}.json`));
      assert.equal(rel.length, 1, `${s}: ${rel.join(',')}`);
      const d = JSON.parse(readIn(root, `${DASH}/${rel[0]}`));
      assert.equal(d.uid, `peaket-svc-${s}`);
      assert.deepEqual(firstRowTitles(d), FOUR_SIGNALS, s);
      for (const p of d.panels.filter((x) => x.type === 'timeseries')) for (const t of p.targets) assert.match(t.expr, new RegExp(`(service|app)="${s}"`), `${s} ${p.title}`);
    }
  }
  const ok = cli('--check');
  assert.equal(ok.status, 0, ok.out);
  // 표에 서비스를 하나 더하면(대시보드 없음) 1
  const added = fixture();
  writeIn(added, 'docs/architecture.md', readIn(added, 'docs/architecture.md').replace(/^(\| core-svc \|.*)$/m, '$1\n| notify-svc | 알림 | 없음 | 없음 | 없음 | 없음 | 없음 |'));
  assert.ok(serviceMapFromDoc(added).includes('notify-svc'));
  const a = cli('--check', '--root', added);
  assert.equal(a.status, 1, a.out);
  assert.match(a.out, /없다: .*notify-svc\.json/);
  // 쓰기 모드는 그 대시보드를 만들고, 그 뒤 --check는 0
  assert.equal(cli('--root', added).status, 0);
  assert.ok(existsSync(join(added, DASH, 'platform', 'notify-svc.json')));
  assert.equal(cli('--check', '--root', added).status, 0);
  // 표에서 마지막 줄(core-svc)을 지우면 남은 대시보드 때문에 1
  const removed = fixture();
  writeIn(removed, 'docs/architecture.md', readIn(removed, 'docs/architecture.md').replace(/^\| core-svc \|.*\r?\n/m, ''));
  const r = cli('--check', '--root', removed);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /대상에 없는 대시보드: .*core-svc\.json/);
  // 표에 없는 대시보드 파일 하나를 남기면 1
  const stray = fixture();
  writeIn(stray, `${DASH}/queue/old-svc.json`, '{}');
  const st = cli('--check', '--root', stray);
  assert.equal(st.status, 1, st.out);
  assert.match(st.out, /old-svc\.json/);
});

test('V-T47 ① 원천(§3.1 표·CODEOWNERS)을 읽지 못하면 2이고 통과로 보지 않는다', () => {
  const noTable = fixture();
  writeIn(noTable, 'docs/architecture.md', readIn(noTable, 'docs/architecture.md').replace('| 서비스명 |', '| 이름 |'));
  const a = cli('--check', '--root', noTable);
  assert.equal(a.status, 2, a.out);
  const noOwners = fixture();
  rmSync(join(noOwners, '.github/CODEOWNERS'));
  assert.equal(cli('--check', '--root', noOwners).status, 2);
  // 표의 첫 칸이 서비스 이름 꼴이 아니면 2
  const badName = fixture();
  writeIn(badName, 'docs/architecture.md', readIn(badName, 'docs/architecture.md').replace('| core-svc |', '| Core Service |'));
  assert.equal(cli('--check', '--root', badName).status, 2);
  assert.equal(cli('--bogus').status, 2);
});

/** 온세일 공용 대시보드: '온세일 공용' 폴더, 첫 행 네 신호, 서비스 고르기, 주석 셋 */
function checkOnsale(root) {
  const onsale = files(root).filter((f) => JSON.parse(readIn(root, `${DASH}/${f}`)).uid === 'peaket-onsale');
  assert.equal(onsale.length, 1, onsale.join(','));
  const folder = onsale[0].split('/')[0];
  // 그 폴더를 싣는 공급자의 Grafana 폴더 제목이 '온세일 공용'이다
  const providers = parse(readIn(REPO, PROVIDERS)).providers.filter((p) => p.options.path.endsWith(`/${folder}`));
  assert.deepEqual(providers.map((p) => p.folder), ['온세일 공용']);
  const d = JSON.parse(readIn(root, `${DASH}/${onsale[0]}`));
  assert.deepEqual(firstRowTitles(d), FOUR_SIGNALS);
  const service = d.templating.list.find((v) => v.name === 'service');
  assert.equal(service.multi, true);
  for (const s of SERVICE_MAP) assert.ok(service.options.some((o) => o.value === s), s);
  for (const p of d.panels.filter((x) => x.type === 'timeseries')) for (const t of p.targets) assert.match(t.expr, /(service|app)=~"\$service"/, p.title);
  // 주석 셋: 배포·장애 주입·운영 사건 줄(ops_event). 모두 Loki(uid loki)에서 읽고 켜져 있다
  const ann = d.annotations.list;
  assert.equal(ann.length, 3, JSON.stringify(ann.map((x) => x.name)));
  for (const x of ann) assert.deepEqual([x.datasource.uid, x.enable], ['loki', true], x.name);
  assert.equal(ann.filter((x) => /배포/.test(x.name)).length, 1);
  assert.equal(ann.filter((x) => /장애 주입/.test(x.name)).length, 1);
  const ops = ann.filter((x) => /ops_event/.test(x.expr));
  assert.equal(ops.length, 1);
  assert.match(ops[0].name, /운영 사건/);
  return onsale[0];
}

test("V-T47 ② 온세일 공용 대시보드가 '온세일 공용' 폴더에 있고 주석 셋이 있다", () => {
  checkOnsale(generated());
  const rel = checkOnsale(REPO);
  // 생성 파일에서 운영 사건 주석을 지우면 --check가 1
  const root = fixture();
  const d = JSON.parse(readIn(root, `${DASH}/${rel}`));
  const edited = { ...d, annotations: { list: d.annotations.list.filter((x) => !/ops_event/.test(x.expr)) } };
  writeIn(root, `${DASH}/${rel}`, `${JSON.stringify(edited, null, 2)}\n`);
  const r = cli('--check', '--root', root);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /다르다: .*onsale/);
});

test('V-T47 ③ 서비스 대시보드는 CODEOWNERS 주인 팀 폴더에 있고 공급자는 화면 고침을 저장하지 않는다', () => {
  for (const root of [REPO, generated()]) {
    const all = files(root);
    for (const s of [...serviceMapFromDoc(REPO), 'example-svc', 'v0-monolith']) assert.ok(all.includes(`${ownerTeam(REPO, s)}/${s}.json`), `${s} → ${ownerTeam(REPO, s)}: ${all.join(',')}`);
  }
  // 공급자는 모두 화면 고침을 저장하지 않고, 대시보드가 있는 폴더마다 하나다
  const providers = parse(readIn(REPO, PROVIDERS)).providers;
  for (const p of providers) assert.equal(p.allowUiUpdates, false, p.name);
  const folders = [...new Set(files(REPO).map((f) => f.split('/')[0]))].sort();
  assert.deepEqual(providers.map((p) => p.options.path.split('/').at(-1)).sort(), folders);
  // 팀을 바꾸면 폴더가 따라간다: CODEOWNERS에서 ticket-svc 주인을 구매 팀으로 바꾼다
  const root = fixture();
  writeIn(root, '.github/CODEOWNERS', readIn(root, '.github/CODEOWNERS').replace(/^(\/services\/ticket-svc\/\s+)@peaket\/ticketing$/m, '$1@peaket/purchase'));
  assert.equal(ownerTeam(root, 'ticket-svc'), 'purchase');
  const moved = cli('--check', '--root', root);
  assert.equal(moved.status, 1, moved.out);
  assert.match(moved.out, /대상에 없는 대시보드: .*ticketing[\\/]ticket-svc\.json/);
  assert.match(moved.out, /없다: .*purchase[\\/]ticket-svc\.json/);
  assert.equal(cli('--root', root).status, 0);
  assert.ok(files(root).includes('purchase/ticket-svc.json'));
  assert.ok(!existsSync(join(root, DASH, 'ticketing')), '비게 된 폴더는 지운다');
  assert.equal(cli('--check', '--root', root).status, 0);
  // 서비스 폴더 줄의 주인이 팀 하나가 아니면(두 팀) 원천을 정할 수 없어 2
  const two = fixture();
  writeIn(two, '.github/CODEOWNERS', readIn(two, '.github/CODEOWNERS').replace(/^(\/services\/queue-svc\/\s+)@peaket\/queue$/m, '$1@peaket/queue @peaket/purchase'));
  assert.equal(cli('--check', '--root', two).status, 2);
});
