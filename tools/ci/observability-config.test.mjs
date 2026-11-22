// 관측 설정 정적 검사의 명령줄 시험(V-T47 ④⑤, docs/verification.md V-T47, docs/observability.md §9 보존 표·'Grafana 권한', ADR-0356 결정 2·3,
// ASVS v5.0.0-16.4.2).
// 검사를 바깥에서 돌린다: node tools/ci/observability-config.mjs --check --root <임시 저장소>. 임시 저장소에는 deploy/platform/observability/,
// deploy/local/dashboards/, docs/observability.md(보존 표), infra/stacks/global/github/teams.json(가상 팀)을 복사하고 사례마다 한 곳을 바꾼다.
// 끝 코드 0 통과, 1 위반('막음: <파일>: <까닭>'), 2 인자·읽기 오류. 보존 값은 정본 보존 표('시계열 메트릭' 행: 원본 90일, 5분 집계 13개월)에서 적는다.
// 실행(저장소 뿌리): node --test tools/ci/observability-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments, stringify } from 'yaml';
import { tempDir } from './git-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'observability-config.mjs');
const REPO = resolve(HERE, '..', '..');

const OBS = 'deploy/platform/observability';
const ACCESS = `${OBS}/grafana/access.yaml`;
const DATASOURCES = `${OBS}/grafana/provisioning/datasources.yaml`;
const DATASOURCES_PLATFORM = `${OBS}/grafana/provisioning/datasources-platform.yaml`;
const PROVIDERS = `${OBS}/grafana/provisioning/dashboards.yaml`;
const OVERRIDES = `${OBS}/mimir/runtime-overrides.yaml`;
const REMOTE_WRITE = `${OBS}/prometheus/remote-write.yaml`;
const AGG_RULES = `${OBS}/rules/agg5m.yaml`;
const DASH = 'deploy/local/dashboards';
const DOC = 'docs/observability.md';

function cli(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const check = (root) => cli('--check', '--root', root);
const blocked = (out) => out.split('\n').filter((l) => l.startsWith('막음:'));
const readIn = (root, rel) => readFileSync(join(root, rel), 'utf8');
const writeIn = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
/** YAML 파일을 읽어 바꾸고 쓴다(주석은 잃어도 된다) */
function editYaml(root, rel, fn) {
  const doc = parse(readIn(root, rel));
  fn(doc);
  writeIn(root, rel, stringify(doc));
}
function fixture() {
  const root = tempDir('observability-config-');
  for (const rel of [OBS, DASH]) cpSync(join(REPO, rel), join(root, rel), { recursive: true });
  for (const rel of [DOC, 'infra/stacks/global/github/teams.json']) writeIn(root, rel, readIn(REPO, rel));
  return root;
}
/** 결과가 1이고 막은 줄 가운데 하나가 파일·까닭에 맞는다 */
function assertBlocked(root, file, why) {
  const r = check(root);
  assert.equal(r.status, 1, r.out);
  const lines = blocked(r.out);
  assert.ok(lines.some((l) => l.startsWith(`막음: ${file}: `) && why.test(l)), `${file} ${why}\n${r.out}`);
  return lines;
}
const pgUid = (root) => parse(readIn(root, DATASOURCES)).datasources.find((d) => /postgres/.test(d.type)).uid;
/** 기본 조직 폴더의 대시보드 하나(platform 팀 폴더) */
const basicDashboard = (root) => `${DASH}/platform/${readdirSync(join(root, DASH, 'platform')).find((f) => f.endsWith('.json'))}`;

test('V-T47 ④ [ASVS v5.0.0-16.4.2] PostgreSQL 데이터 소스나 그 uid를 가리키는 대시보드가 기본 조직에 있으면 막는다', () => {
  // 실제 저장소는 위반 0
  const real = cli('--check');
  assert.equal(real.status, 0, real.out);
  assert.deepEqual(blocked(real.out), []);
  // 원천의 조직 둘(observability §9: 기본 'PEAKET 관측', 제한 'PEAKET 제한')과, PostgreSQL 쿼리 문장이 제한 조직에 있는 것
  const access = parse(readIn(REPO, ACCESS));
  assert.deepEqual(access.orgs.map((o) => [o.name, o.restricted]), [['PEAKET 관측', false], ['PEAKET 제한', true]]);
  const restrictedId = access.orgs.find((o) => o.restricted).id;
  const pg = parse(readIn(REPO, DATASOURCES)).datasources.filter((d) => /postgres/.test(d.type));
  assert.deepEqual(pg.map((d) => d.orgId), [restrictedId]);

  // 길 1: 데이터 소스 배치. PostgreSQL 데이터 소스를 기본 조직(1)으로 옮긴다
  const moved = fixture();
  editYaml(moved, DATASOURCES, (d) => {
    for (const ds of d.datasources) if (/postgres/.test(ds.type)) ds.orgId = 1;
  });
  assertBlocked(moved, DATASOURCES, /PostgreSQL 데이터 소스 .*제한 조직 밖/);
  // 운영 판 파일에 기본 조직 PostgreSQL을 더해도 막는다(종류 이름 postgres)
  const platformPg = fixture();
  editYaml(platformPg, DATASOURCES_PLATFORM, (d) => d.datasources.push({ name: 'Aurora', uid: 'aurora-pg', orgId: 1, type: 'postgres', url: 'aurora:5432' }));
  assertBlocked(platformPg, DATASOURCES_PLATFORM, /aurora-pg.*제한 조직 밖/);
  // 조직을 적지 않은 데이터 소스는 기본 조직에 실리므로 막는다
  const noOrg = fixture();
  editYaml(noOrg, DATASOURCES, (d) => {
    for (const ds of d.datasources) if (/postgres/.test(ds.type)) delete ds.orgId;
  });
  assertBlocked(noOrg, DATASOURCES, /orgId가 없다/);

  // 길 2: 기본 조직 대시보드가 그 uid를 가리킨다(객체 꼴과 글자 꼴 둘 다)
  for (const form of ['object', 'string']) {
    const root = fixture();
    const rel = basicDashboard(root);
    const d = JSON.parse(readIn(root, rel));
    const uid = pgUid(root);
    d.panels.push({ id: 99, type: 'table', title: '쿼리 문장', datasource: form === 'object' ? { type: 'grafana-postgresql-datasource', uid } : uid, targets: [{ refId: 'A', rawSql: 'select 1' }] });
    writeIn(root, rel, `${JSON.stringify(d, null, 2)}\n`);
    assertBlocked(root, rel, new RegExp(`PostgreSQL 데이터 소스 ${uid}`));
  }

  // 제한 조직 대시보드가 다른 uid(Prometheus)와 PostgreSQL을 함께 쓰는 것은 허용한다
  const allowed = fixture();
  editYaml(allowed, ACCESS, (a) => a.folders.push({ uid: 'db-owners', title: 'DB 담당', org: restrictedId }));
  editYaml(allowed, PROVIDERS, (p) =>
    p.providers.push({ name: 'db-owners', orgId: restrictedId, folder: 'DB 담당', folderUid: 'db-owners', type: 'file', disableDeletion: true, allowUiUpdates: false, options: { path: '/var/lib/grafana/dashboards/db-owners' } }),
  );
  writeIn(allowed, `${DASH}/db-owners/statements.json`, `${JSON.stringify({ uid: 'peaket-db-statements', title: '쿼리 문장', panels: [{ datasource: { uid: pgUid(allowed) } }, { datasource: { uid: 'prometheus' } }] }, null, 2)}\n`);
  const ok = check(allowed);
  assert.equal(ok.status, 0, ok.out);
  // 같은 대시보드를 기본 조직 공급자로 실으면 막는다
  editYaml(allowed, PROVIDERS, (p) => {
    p.providers.find((x) => x.name === 'db-owners').orgId = 1;
  });
  editYaml(allowed, ACCESS, (a) => {
    a.folders.find((f) => f.uid === 'db-owners').org = 1;
  });
  assertBlocked(allowed, `${DASH}/db-owners/statements.json`, /제한 조직 밖\(orgId 1\)/);
});

test('V-T47 ④ 공급자는 화면 고침을 저장하지 않고 폴더마다 하나이며 조직 원천이 틀리면 막는다', () => {
  const ui = fixture();
  editYaml(ui, PROVIDERS, (p) => {
    p.providers[0].allowUiUpdates = true;
  });
  assertBlocked(ui, PROVIDERS, /allowUiUpdates/);
  // 공급자 없는 대시보드 폴더
  const orphan = fixture();
  writeIn(orphan, `${DASH}/commerce/x.json`, '{}');
  assertBlocked(orphan, `${DASH}/commerce`, /공급자가 없다/);
  // 조직이 둘(기본 하나·제한 하나)이 아니다
  const oneOrg = fixture();
  editYaml(oneOrg, ACCESS, (a) => {
    for (const o of a.orgs) o.restricted = false;
  });
  assertBlocked(oneOrg, ACCESS, /기본 하나·제한 하나/);
  // 팀이 가상 팀 목록과 다르다
  const team = fixture();
  editYaml(team, ACCESS, (a) => {
    a.teams = a.teams.filter((t) => t.slug !== 'data');
  });
  assertBlocked(team, ACCESS, /가상 팀/);
});

test('V-T47 ⑤ 테넌트 보존이 보존 표와 같고 agg5m에는 5분 집계만 간다', () => {
  // 정본 보존 표 '시계열 메트릭' 행: 원본 90일, 5분 집계 13개월
  const row = readIn(REPO, DOC).split(/\r?\n/).find((l) => l.startsWith('| 시계열 메트릭 |'));
  assert.match(row, /원본 90일, 5분 집계 13개월/);
  const overrides = parse(readIn(REPO, OVERRIDES)).overrides;
  assert.equal(overrides.raw.compactor_blocks_retention_period, '90d');
  // 13개월은 어느 달 셈으로도 365일보다 길다(모자라게 지우지 않는다)
  assert.ok(Number(/^(\d+)d$/.exec(overrides.agg5m.compactor_blocks_retention_period)[1]) >= 13 * 30);

  // 보존을 바꾸면 1
  for (const [tenant, value] of [['raw', '30d'], ['agg5m', '365d'], ['raw', '90']]) {
    const root = fixture();
    editYaml(root, OVERRIDES, (o) => {
      o.overrides[tenant].compactor_blocks_retention_period = value;
    });
    assertBlocked(root, OVERRIDES, new RegExp(`테넌트 ${tenant}`));
  }
  // 정본을 바꾸면 파일이 그대로여도 1(검사가 코드 상수가 아니라 보존 표를 읽는다)
  const doc = fixture();
  writeIn(doc, DOC, readIn(doc, DOC).replace('원본 90일, 5분 집계 13개월', '원본 120일, 5분 집계 13개월'));
  assertBlocked(doc, OVERRIDES, /테넌트 raw의 보존 90일이 .*120일/);
  // 보존 표 행을 읽지 못하면 2
  const noRow = fixture();
  writeIn(noRow, DOC, readIn(noRow, DOC).replace('| 시계열 메트릭 |', '| 지표 |'));
  assert.equal(check(noRow).status, 2);

  // 원격 쓰기: agg5m 거름을 넓히면(원본이 agg5m으로 간다) 1
  for (const regex of ['.+', 'agg5m:.+|http_server_.+', 'agg5m.+']) {
    const root = fixture();
    editYaml(root, REMOTE_WRITE, (w) => {
      w.remote_write.find((r) => r.headers['X-Scope-OrgID'] === 'agg5m').write_relabel_configs[0].regex = regex;
    });
    assertBlocked(root, REMOTE_WRITE, /agg5m 원격 쓰기/);
  }
  // 거름을 빼거나, 남기기가 아니라 버리기면 1
  for (const edit of [(r) => delete r.write_relabel_configs, (r) => (r.write_relabel_configs[0].action = 'drop')]) {
    const root = fixture();
    editYaml(root, REMOTE_WRITE, (w) => edit(w.remote_write.find((r) => r.headers['X-Scope-OrgID'] === 'agg5m')));
    assertBlocked(root, REMOTE_WRITE, /agg5m 원격 쓰기/);
  }
  // raw를 거르거나, 테넌트 하나가 빠지거나, 모르는 테넌트로 보내면 1
  const rawFiltered = fixture();
  editYaml(rawFiltered, REMOTE_WRITE, (w) => {
    w.remote_write.find((r) => r.headers['X-Scope-OrgID'] === 'raw').write_relabel_configs = [{ source_labels: ['__name__'], regex: 'up', action: 'drop' }];
  });
  assertBlocked(rawFiltered, REMOTE_WRITE, /원본\(raw\)/);
  const missing = fixture();
  editYaml(missing, REMOTE_WRITE, (w) => {
    w.remote_write = w.remote_write.filter((r) => r.headers['X-Scope-OrgID'] !== 'agg5m');
  });
  assertBlocked(missing, REMOTE_WRITE, /테넌트 agg5m/);
  const extra = fixture();
  editYaml(extra, REMOTE_WRITE, (w) => w.remote_write.push({ name: 'mimir-long', url: 'http://mimir/api/v1/push', headers: { 'X-Scope-OrgID': 'long' } }));
  assertBlocked(extra, REMOTE_WRITE, /모르는 테넌트/);

  // agg5m: 앞머리 규칙을 30초 묶음(다른 파일)에 두거나, 5분 묶음의 간격을 바꾸면 1
  const fast = fixture();
  writeIn(fast, `${OBS}/rules/fast.yaml`, stringify({ apiVersion: 'monitoring.coreos.com/v1', kind: 'PrometheusRule', metadata: { name: 'fast' }, spec: { groups: [{ name: 'fast', interval: '30s', rules: [{ record: 'agg5m:queue_depth:max', expr: 'max(queue_depth)' }] }] } }));
  assertBlocked(fast, `${OBS}/rules/fast.yaml`, /agg5m:queue_depth:max.*5분/);
  for (const interval of ['1m', undefined]) {
    const root = fixture();
    const docs = parseAllDocuments(readIn(root, AGG_RULES)).map((d) => d.toJS());
    if (interval) docs[0].spec.groups[0].interval = interval;
    else delete docs[0].spec.groups[0].interval;
    writeIn(root, AGG_RULES, stringify(docs[0]));
    assertBlocked(root, AGG_RULES, /평가 간격 5분이 아닌/);
  }
  // 5분 집계 규칙이 하나도 없으면(보낼 것이 없다) 1
  const none = fixture();
  rmSync(join(none, AGG_RULES));
  assertBlocked(none, `${OBS}/rules`, /agg5m: 기록 규칙이 하나도 없다/);
});

test('V-T47 ⑤ 원천을 읽지 못하면 2이고, CI tools-check가 이 검사와 대시보드 대조를 돌린다', () => {
  const noAccess = fixture();
  rmSync(join(noAccess, ACCESS));
  assert.equal(check(noAccess).status, 2);
  const badYaml = fixture();
  writeIn(badYaml, OVERRIDES, 'overrides:\n  raw: [\n');
  assert.equal(check(badYaml).status, 2);
  const badJson = fixture();
  writeIn(badJson, basicDashboard(badJson), '{ not json');
  assert.equal(check(badJson).status, 2);
  assert.equal(cli().status, 2, '--check 없이는 돌지 않는다');
  assert.equal(cli('--check', '--bogus').status, 2);
  const workflow = readIn(REPO, '.github/workflows/tools-check.yml');
  assert.match(workflow, /^\s+- run: node tools\/ci\/observability-config\.mjs --check\s*$/m);
  assert.match(workflow, /^\s+- run: node tools\/local\/dashboards\.mjs --check\s*$/m);
});
