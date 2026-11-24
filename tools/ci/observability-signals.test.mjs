// F-01-9 정적 검사 시험(V-T50 ⑨, docs/verification.md:671, docs/observability.md:124·127·578, 계획 docs/review/plans/F-01-9.md §6).
// 도구를 바깥에서 부른다: node tools/ci/collector-config.mjs --check --root <임시 저장소>,
// node tools/ci/observability-stores.mjs --check --root <임시 저장소>. 임시 저장소에는 두 도구가 읽는 파일만 복사하고 사례마다 한 곳을 바꾼다.
// - 게이트웨이 수집기는 Loki 라벨 넷(namespace·service·env·cluster)을 자원 속성에서 복사해야 한다(클러스터는 PEAKET_CLUSTER).
// - Loki 데이터 소스의 traceId 파생 필드 → Tempo, Tempo의 tracesToLogsV2 → Loki 연결이 있어야 한다.
// 끝 코드 0 통과, 1 위반('막음: <파일>: <까닭>'), 2 인자·읽기·YAML 오류.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { tempDir } from './git-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const COLLECTOR_TOOL = join(HERE, 'collector-config.mjs');
const STORES_TOOL = join(HERE, 'observability-stores.mjs');
const REPO = resolve(HERE, '..', '..');

const OBS = 'deploy/platform/observability';
const COLLECTOR = `${OBS}/collector`;
const GATEWAY = `${COLLECTOR}/gateway.yaml`;
const DATASOURCES_PLATFORM = `${OBS}/grafana/provisioning/datasources-platform.yaml`;
const DOC = 'docs/observability.md';
const ADR = 'docs/adr/0125-entry-path-head-sampling-collector-sizing-shared-sample-threshold.md';
const OPENAPI = 'docs/api/openapi.yaml';
const PII = 'packages/platform/src/pii-patterns.json';
/** 계획 §5가 정한 처리기 이름 */
const LABELS_PROCESSOR = 'transform/loki-labels';

const cli = (script, ...args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: REPO });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const collectorCheck = (root) => cli(COLLECTOR_TOOL, '--check', ...(root ? ['--root', root] : []));
const storesCheck = (root) => cli(STORES_TOOL, '--check', ...(root ? ['--root', root] : []));
const blocked = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('막음:'));

const readIn = (root, rel) => readFileSync(join(root, rel), 'utf8');
const writeIn = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const yamlIn = (root, rel) => parse(readIn(root, rel));
function editYaml(root, rel, fn) {
  const doc = parse(readIn(root, rel));
  fn(doc);
  writeIn(root, rel, stringify(doc));
}

function fixture() {
  const root = tempDir('observability-signals-');
  cpSync(join(REPO, OBS), join(root, OBS), { recursive: true });
  for (const rel of [DOC, ADR, OPENAPI, PII]) writeIn(root, rel, readIn(REPO, rel));
  return root;
}
function assertBlocked(result, file, what) {
  assert.equal(result.status, 1, `${what}: 끝 코드 1이어야 한다\n${result.out}`);
  const lines = blocked(result.out);
  assert.ok(lines.some((l) => l.startsWith(`막음: ${file}: `)), `${what}: '막음: ${file}: …' 줄이 없다\n${result.out}`);
  return lines;
}
function blocks(file, what, fn) {
  const root = fixture();
  fn(root);
  return assertBlocked(file === GATEWAY ? collectorCheck(root) : storesCheck(root), file, what);
}

/** 게이트웨이 로그 파이프라인의 처리기 목록(이름이 logs이거나 logs/…인 파이프라인) */
const logPipeline = (doc) => {
  const entries = Object.entries(doc.service?.pipelines ?? {}).filter(([name]) => name === 'logs' || name.startsWith('logs/'));
  assert.ok(entries.length > 0, '게이트웨이에 로그 파이프라인이 없다');
  return entries[0][1];
};
const tracePipelines = (doc) => Object.entries(doc.service?.pipelines ?? {}).filter(([name]) => name === 'traces' || name.startsWith('traces/'));
/** 처리기의 로그 문장 목록(불변) */
const statements = (doc) => (doc.processors?.[LABELS_PROCESSOR]?.log_statements ?? []).flatMap((g) => g.statements ?? []);

test('V-T50 ⑨ 게이트웨이 수집기가 Loki 라벨 넷을 달지 않으면 막는다', () => {
  const real = collectorCheck();
  assert.equal(real.status, 0, real.out);
  assert.deepEqual(blocked(real.out), []);

  // 실제 원천: 라벨 넷과 원천 속성·클러스터 환경 변수가 있다
  const doc = yamlIn(REPO, GATEWAY);
  const body = statements(doc).join('\n');
  for (const [label, src] of [
    ['namespace', 'k8s.namespace.name'],
    ['service', 'service.name'],
    ['env', 'deployment.environment'],
  ]) {
    assert.match(body, new RegExp(`set\\(resource\\.attributes\\["${label}"\\], resource\\.attributes\\["${src.replace(/\./g, '\\.')}"\\]\\)`), `${label} ← ${src}`);
  }
  assert.match(body, /set\(resource\.attributes\["cluster"\], "\$\{env:PEAKET_CLUSTER\}"\)/, 'cluster ← PEAKET_CLUSTER');
  assert.ok(logPipeline(doc).processors.includes(LABELS_PROCESSOR), '로그 파이프라인에 라벨 처리기가 없다');

  blocks(GATEWAY, '라벨 처리기 뺌', (r) => editYaml(r, GATEWAY, (d) => delete d.processors[LABELS_PROCESSOR]));
  blocks(GATEWAY, 'namespace 문장 뺌', (r) =>
    editYaml(r, GATEWAY, (d) => {
      d.processors[LABELS_PROCESSOR].log_statements[0].statements = statements(d).filter((s) => !s.includes('"namespace"'));
    }),
  );
  blocks(GATEWAY, 'service 원천을 파드 이름으로', (r) =>
    editYaml(r, GATEWAY, (d) => {
      d.processors[LABELS_PROCESSOR].log_statements[0].statements = statements(d).map((s) => s.replace('resource.attributes["service.name"]', 'resource.attributes["k8s.pod.name"]'));
    }),
  );
  blocks(GATEWAY, 'cluster 문장 뺌', (r) =>
    editYaml(r, GATEWAY, (d) => {
      d.processors[LABELS_PROCESSOR].log_statements[0].statements = statements(d).filter((s) => !s.includes('PEAKET_CLUSTER'));
    }),
  );
  blocks(GATEWAY, '로그 파이프라인에서 뺌', (r) =>
    editYaml(r, GATEWAY, (d) => {
      logPipeline(d).processors = logPipeline(d).processors.filter((p) => p !== LABELS_PROCESSOR);
    }),
  );
  blocks(GATEWAY, '추적 파이프라인에 더함', (r) =>
    editYaml(r, GATEWAY, (d) => {
      for (const [, p] of tracePipelines(d)) p.processors = [...p.processors, LABELS_PROCESSOR];
    }),
  );
  const broken = fixture();
  writeIn(broken, GATEWAY, `${readIn(broken, GATEWAY)}\nprocessors: [깨진\n`);
  assert.equal(collectorCheck(broken).status, 2);
});

test('V-T50 ⑨ Loki↔Tempo 신호 연결이 빠지거나 다른 데이터 소스를 가리키면 막는다', () => {
  const real = storesCheck();
  assert.equal(real.status, 0, real.out);
  assert.deepEqual(blocked(real.out), []);

  // 실제 원천: Loki traceId 파생 필드 → tempo, Tempo tracesToLogsV2 → loki(같은 traceId)
  const ds = (root, uid) => yamlIn(root, DATASOURCES_PLATFORM).datasources.find((d) => d.uid === uid);
  const derived = ds(REPO, 'loki').jsonData.derivedFields;
  assert.equal(derived.length, 1);
  assert.deepEqual([derived[0].name, derived[0].datasourceUid], ['traceId', 'tempo']);
  assert.match(String(derived[0].matcherRegex), /traceId/);
  const toLogs = ds(REPO, 'tempo').jsonData.tracesToLogsV2;
  assert.deepEqual([toLogs.datasourceUid, toLogs.filterByTraceID], ['loki', true]);

  const edit = (uid, fn) => (r) =>
    editYaml(r, DATASOURCES_PLATFORM, (d) => {
      fn(d.datasources.find((x) => x.uid === uid));
    });
  blocks(DATASOURCES_PLATFORM, 'Loki 파생 필드 뺌', edit('loki', (d) => delete d.jsonData.derivedFields));
  blocks(DATASOURCES_PLATFORM, '파생 필드 이름 바꿈', edit('loki', (d) => (d.jsonData.derivedFields[0].name = 'trace_id')));
  blocks(DATASOURCES_PLATFORM, '파생 필드 정규식 뺌', edit('loki', (d) => delete d.jsonData.derivedFields[0].matcherRegex));
  blocks(DATASOURCES_PLATFORM, '파생 필드가 없는 Tempo', edit('loki', (d) => (d.jsonData.derivedFields[0].datasourceUid = 'tempo-missing')));
  blocks(DATASOURCES_PLATFORM, 'Tempo 로그 연결 뺌', edit('tempo', (d) => delete d.jsonData.tracesToLogsV2));
  blocks(DATASOURCES_PLATFORM, 'traceId로 거르지 않음', edit('tempo', (d) => (d.jsonData.tracesToLogsV2.filterByTraceID = false)));
  blocks(DATASOURCES_PLATFORM, 'Tempo 로그 연결이 없는 Loki', edit('tempo', (d) => (d.jsonData.tracesToLogsV2.datasourceUid = 'loki-missing')));
  blocks(DATASOURCES_PLATFORM, '다른 조직의 Tempo', edit('tempo', (d) => (d.orgId = 2)));
});
