// 관측 저장소·exporter·신호 연결 설정 정적 검사의 명령줄 시험(V-T50 ①②⑥, docs/verification.md V-T50, docs/observability.md §1 '관측 저장소 설정
// 원천과 로컬 확인'·§2·§7·§8·§9, ADR-0125 결정 4, ASVS v5.0.0-16.2.4). 계획 docs/review/plans/F-01-4.md §5·§6.
// 검사를 바깥에서 돌린다: node tools/ci/observability-stores.mjs --check --root <임시 저장소>, --render <loki|tempo> --root <임시 저장소>.
// 임시 저장소에는 도구가 읽는 셋(deploy/platform/observability/, docs/observability.md, ADR-0125)만 복사하고 사례마다 한 곳을 바꾼다.
// 끝 코드 0 통과, 1 위반('막음: <파일>: <까닭>'), 2 인자·읽기·YAML 오류.
// 단언 값(복제 수·보존·라벨 넷·한도 넷·exemplar 이름·상위 N·YACE 지표)은 시험이 정본 문서에서 따로 읽는다(도구의 상수를 가져오지 않는다).
// 설정 키 이름은 각 도구 설정 문서의 이름이다(Mimir·Loki의 replication_factor·zone_awareness_enabled, Loki limits_config·otlp_config,
// Tempo block_retention·ingest.kafka·metrics_generator, postgres_exporter --collector.stat_statements*, YACE discovery.jobs).
// 실행(저장소 뿌리): node --test tools/ci/observability-stores.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { tempDir } from './git-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'observability-stores.mjs');
const CONFIG_SCRIPT = join(HERE, 'observability-config.mjs');
const REPO = resolve(HERE, '..', '..');

const OBS = 'deploy/platform/observability';
const MIMIR = `${OBS}/mimir/config.yaml`;
const LOKI = `${OBS}/loki/config.yaml`;
const LOKI_LOCAL = `${OBS}/loki/local.yaml`;
const TEMPO = `${OBS}/tempo/config.yaml`;
const TEMPO_LOCAL = `${OBS}/tempo/local.yaml`;
const PG_EXPORTER = `${OBS}/exporters/postgres-exporter.yaml`;
const YACE = `${OBS}/exporters/yace.yaml`;
const DATASOURCES = `${OBS}/grafana/provisioning/datasources.yaml`;
const DATASOURCES_PLATFORM = `${OBS}/grafana/provisioning/datasources-platform.yaml`;
const REMOTE_WRITE = `${OBS}/prometheus/remote-write.yaml`;
const DOC = 'docs/observability.md';
const ADR = 'docs/adr/0125-entry-path-head-sampling-collector-sizing-shared-sample-threshold.md';

// ---------- 도구 부르기 ----------
function cli(script, ...args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: REPO });
  return { status: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
}
const check = (root) => (root ? cli(SCRIPT, '--check', '--root', root) : cli(SCRIPT, '--check'));
const render = (store, root) => (root ? cli(SCRIPT, '--render', store, '--root', root) : cli(SCRIPT, '--render', store));
const blocked = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('막음:'));

// ---------- 임시 저장소 ----------
const readIn = (root, rel) => readFileSync(join(root, rel), 'utf8');
const writeIn = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const yamlIn = (root, rel) => parse(readIn(root, rel));
/** YAML 파일을 읽어 바꾸고 쓴다(주석은 잃어도 된다) */
function editYaml(root, rel, fn) {
  const doc = parse(readIn(root, rel));
  fn(doc);
  writeIn(root, rel, stringify(doc));
}
function fixture() {
  const root = tempDir('observability-stores-');
  cpSync(join(REPO, OBS), join(root, OBS), { recursive: true });
  for (const rel of [DOC, ADR]) writeIn(root, rel, readIn(REPO, rel));
  return root;
}
/** 결과가 1이고 막은 줄 가운데 하나가 그 파일을 말한다 */
function assertBlocked(root, file, what) {
  const r = check(root);
  assert.equal(r.status, 1, `${what}: 끝 코드 1이어야 한다\n${r.out}`);
  const lines = blocked(r.out);
  assert.ok(lines.some((l) => l.startsWith(`막음: ${file}: `)), `${what}: '막음: ${file}: …' 줄이 없다\n${r.out}`);
  return lines;
}
/** 한 사례: 새 임시 저장소에서 fn으로 한 곳을 바꾸고 막히는지 본다 */
function blocks(file, what, fn) {
  const root = fixture();
  fn(root);
  return assertBlocked(root, file, what);
}

// ---------- 값 안 찾기·바꾸기(설정 배치가 달라도 같은 키를 찾는다) ----------
/** 객체 안에서 이름이 key인 모든 칸: [{ parent, key, value }] */
function findKeys(value, key, out = []) {
  if (Array.isArray(value)) for (const v of value) findKeys(v, key, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === key) out.push({ parent: value, key: k, value: v });
      findKeys(v, key, out);
    }
  }
  return out;
}
/** 이름이 key인 칸을 모두 바꾼다. 하나도 없으면 시험이 틀린 것이므로 실패한다 */
function setEvery(doc, key, value, file) {
  const hits = findKeys(doc, key);
  assert.ok(hits.length > 0, `${file}에 ${key}가 없다(설정 원천을 먼저 만든다)`);
  for (const h of hits) h.parent[h.key] = value;
  return hits.length;
}
/** 경로를 따라 만들며 값을 둔다 */
function setPath(doc, path, value) {
  let o = doc;
  for (const k of path.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[path.at(-1)] = value;
}
const getPath = (doc, path) => path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), doc);
/** 깊이 끝까지 모든 문자열 */
function* strings(value) {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) yield* strings(v);
}

/** '30d'·'720h'·'2w' 기간을 일로 */
function days(text) {
  const m = /^(\d+)(d|h|w)$/.exec(String(text ?? '').trim());
  assert.ok(m, `기간 꼴이 아니다: ${text}`);
  return Number(m[1]) * { d: 1, h: 1 / 24, w: 7 }[m[2]];
}
/** '15MB'·'15MiB'·바이트 수를 MB 수로(MB = 10^6, MiB = 2^20 바이트 둘 다 받는다) */
function megabytes(value) {
  if (typeof value === 'number') {
    if (value % 2 ** 20 === 0) return value / 2 ** 20;
    return value / 1e6;
  }
  const m = /^(\d+(?:\.\d+)?)\s*(MB|MiB)$/i.exec(String(value ?? '').trim());
  assert.ok(m, `크기 꼴이 아니다: ${value}`);
  return Number(m[1]);
}

// ---------- 정본에서 읽은 값 ----------
const docLines = () => readIn(REPO, DOC).split(/\r?\n/);
/** §9 보존 표의 한 행 셋째 칸(보존)의 일 수 */
function retentionDays(row) {
  const line = docLines().find((l) => new RegExp(`^\\|\\s*${row}\\s*\\|`).test(l));
  assert.ok(line, `${DOC} §9 보존 표에 '${row}' 행이 없다`);
  const cell = line.split('|')[3];
  const m = /(\d+)\s*일/.exec(cell);
  assert.ok(m, `'${row}' 행 보존 칸에 'N일'이 없다: ${cell}`);
  return Number(m[1]);
}
const CANON = (() => {
  const lines = docLines();
  const stores = lines.find((l) => /^\s*- Mimir: 고전 구조/.test(l));
  assert.ok(stores, `${DOC} §1 'Mimir: 고전 구조' 줄이 없다`);
  const mimirRf = Number(/인제스터 영역 인식\s*(\d)중 복제/.exec(stores)?.[1]);
  const lokiRf = Number(/Loki: 영역 인식\s*(\d)중 복제/.exec(stores)?.[1]);
  const labelLine = lines.find((l) => /^\|\s*Loki 라벨 허용 목록/.test(l));
  assert.ok(labelLine, `${DOC} §7 'Loki 라벨 허용 목록' 행이 없다`);
  const labels = [...labelLine.split('만 쓴다')[0].matchAll(/`([a-z]+)`/g)].map((m) => m[1]);
  const exemplarLine = lines.find((l) => /OpenMetrics exemplar\(`/.test(l));
  const exemplarName = /exemplar\(`(\w+)`·`spanId`\)/.exec(exemplarLine ?? '')?.[1];
  const topLine = lines.find((l) => /^- 쿼리 통계 예외/.test(l));
  const top = Number(/상위\s*(\d+)\s*개/.exec(topLine ?? '')?.[1]);
  const quotaRow = lines.find((l) => /^\s*\|\s*CloudFront 배포별 한도 사용률/.test(l));
  const edgeRow = lines.find((l) => /^\s*\|\s*엣지에서 끝난 실패/.test(l));
  assert.ok(quotaRow && edgeRow, `${DOC} §8 지표 출처 표의 CloudFront 두 줄이 없다`);
  const quotaSource = quotaRow.split('|')[2];
  const edgeSource = edgeRow.split('|')[2];
  const quotaMetrics = [...new Set([...quotaSource.matchAll(/CloudFront `(\w+)`/g)].map((m) => m[1]))];
  const edgeMetrics = [...new Set([...edgeSource.split('를 1분마다')[0].matchAll(/`(\w*(?:ErrorRate|Requests))`/g)].map((m) => m[1]))].sort();
  const edgeDelayMin = Number(/`delay` (\d+)분/.exec(edgeSource)?.[1]);
  const region = /CloudWatch\(([a-z0-9-]+)\)/.exec(quotaSource)?.[1];
  const adr = readIn(REPO, ADR).split(/\r?\n/);
  const limitLine = adr.find((l) => /^\s*- Loki 한도:/.test(l));
  const defaultLine = adr.find((l) => /Loki 기본 한도는/.test(l));
  assert.ok(limitLine && defaultLine, `${ADR} 결정 4의 'Loki 한도' 줄이나 맥락의 기본 한도 줄이 없다`);
  const limits = {
    ingestion_rate_mb: Number(/`ingestion_rate_mb` (\d+)/.exec(limitLine)?.[1]),
    ingestion_burst_size_mb: Number(/`ingestion_burst_size_mb` (\d+)/.exec(limitLine)?.[1]),
    per_stream_rate_limit: Number(/`per_stream_rate_limit` (\d+)MB/.exec(limitLine)?.[1]),
    per_stream_rate_limit_burst: Number(/`per_stream_rate_limit_burst` (\d+)MB/.exec(limitLine)?.[1]),
  };
  const defaults = {
    ingestion_rate_mb: Number(/테넌트 초당 (\d+)MB\(`ingestion_rate_mb`/.exec(defaultLine)?.[1]),
    ingestion_burst_size_mb: Number(/`ingestion_rate_mb`, 순간 (\d+)MB\)/.exec(defaultLine)?.[1]),
    per_stream_rate_limit: Number(/스트림 하나 초당 (\d+)MB\(`per_stream_rate_limit`/.exec(defaultLine)?.[1]),
    per_stream_rate_limit_burst: Number(/`per_stream_rate_limit`, 순간 (\d+)MB\)/.exec(defaultLine)?.[1]),
  };
  const c = {
    mimirRf, lokiRf, labels, exemplarName, top, quotaMetrics, edgeMetrics, edgeDelaySec: edgeDelayMin * 60, region, limits, defaults,
    lokiRetention: retentionDays('정형 로그'),
    tempoRetention: retentionDays('분산 트레이스'),
  };
  // 읽기 확인: 정본 문장이 바뀌어 못 읽으면(NaN·빈 목록) 여기서 멈춘다. 값 자체는 정본이 정한다
  for (const [k, v] of Object.entries({ mimirRf, lokiRf, top: c.top, edgeDelaySec: c.edgeDelaySec, lokiRetention: c.lokiRetention, tempoRetention: c.tempoRetention, ...limits, ...Object.fromEntries(Object.entries(defaults).map(([dk, dv]) => [`default_${dk}`, dv])) })) {
    assert.ok(Number.isInteger(v) && v > 0, `정본에서 ${k}를 읽지 못했다: ${v}`);
  }
  assert.ok(labels.length > 0 && quotaMetrics.length > 0 && edgeMetrics.length > 0 && exemplarName && region, JSON.stringify(c));
  // 대조 사례가 뜻을 가지려면 기본 한도가 정한 한도와 달라야 한다
  for (const k of Object.keys(limits)) assert.notEqual(defaults[k], limits[k], k);
  return c;
})();

// ---------- 설정 안의 자리(도구 설정 문서의 이름) ----------
/** Loki OTLP 받기의 자원 속성 설정(limits_config.otlp_config.resource_attributes) */
const lokiResourceAttrs = (doc) => getPath(doc, ['limits_config', 'otlp_config', 'resource_attributes']);
/** 색인 라벨로 두는 항목(action index_label)의 attributes 목록 */
function lokiIndexLabels(doc) {
  const ra = lokiResourceAttrs(doc);
  const items = (ra?.attributes_config ?? []).filter((x) => x.action === 'index_label');
  assert.equal(items.length, 1, `Loki otlp_config.resource_attributes.attributes_config에 index_label 항목이 하나여야 한다: ${JSON.stringify(ra)}`);
  return items[0];
}
/**
 * Tempo metrics-generator 처리기 이름: 서비스 그래프와 그 연결 지표 하위 이름(docs/observability.md §1·§6의 '연결 지표도 켠다').
 * Tempo v3.1.1은 연결 지표 traces_service_graph_connection_info를 처리기 목록의 하위 이름 service-graphs-connection-info로 켠다
 * (grafana/tempo v3.1.1 modules/generator/instance.go updateServiceGraphsSubprocessors, processor/processor_names.go, 2026-11-23 확인).
 * span 지표 처리기는 없다
 */
const SERVICE_GRAPH_PROCESSORS = ['service-graphs', 'service-graphs-connection-info'];
/** Tempo metrics-generator 처리기 목록(overrides의 processors·metrics_generator_processors) */
function tempoProcessorLists(doc) {
  const lists = [...findKeys(doc, 'processors'), ...findKeys(doc, 'metrics_generator_processors')].filter((h) => Array.isArray(h.value) && h.value.every((v) => typeof v === 'string'));
  return lists;
}
/** Tempo 원격 쓰기 목록(metrics_generator.storage.remote_write) */
const tempoRemoteWrites = (doc) => findKeys(doc, 'remote_write').filter((h) => Array.isArray(h.value));
/** YACE 작업 둘: 한도 사용률(Requests만)·엣지 실패(502ErrorRate가 있는 작업) */
function yaceJobs(doc) {
  const jobs = doc?.discovery?.jobs ?? [];
  const names = (j) => (j.metrics ?? []).map((m) => m.name);
  return { jobs, edge: jobs.find((j) => names(j).includes('502ErrorRate')), quota: jobs.find((j) => !names(j).includes('502ErrorRate')), names };
}
const mimirRawUrl = () => parse(readIn(REPO, REMOTE_WRITE)).remote_write.find((w) => w.name === 'mimir-raw').url;

// ---------- 시험 ----------

test('V-T50 ① 관측 저장소 설정이 §1·§9와 어긋나면 막는다', () => {
  // 실제 저장소는 위반 0
  const real = check();
  assert.equal(real.status, 0, real.out);
  assert.deepEqual(blocked(real.out), []);

  // 실제 원천이 정본 값을 담는다(검사가 느슨해도 원천이 틀리면 여기서 보인다)
  const mimir = yamlIn(REPO, MIMIR);
  const loki = yamlIn(REPO, LOKI);
  const tempo = yamlIn(REPO, TEMPO);
  for (const [file, doc, rf] of [[MIMIR, mimir, CANON.mimirRf], [LOKI, loki, CANON.lokiRf]]) {
    const rfs = findKeys(doc, 'replication_factor').map((h) => h.value);
    assert.ok(rfs.length > 0 && rfs.every((v) => v === rf), `${file} replication_factor ${rfs}`);
    const zones = findKeys(doc, 'zone_awareness_enabled').map((h) => h.value);
    assert.ok(zones.length > 0 && zones.every((v) => v === true), `${file} zone_awareness_enabled ${zones}`);
    assert.ok(![...strings(doc)].includes('inmemory'), `${file} 운영 판에 inmemory`);
  }
  assert.equal(days(getPath(loki, ['limits_config', 'retention_period'])), CANON.lokiRetention);
  for (const [k, mb] of Object.entries(CANON.limits)) {
    const v = getPath(loki, ['limits_config', k]);
    assert.equal(k.endsWith('_mb') ? v : megabytes(v), mb, `Loki limits_config.${k}`);
  }
  assert.equal(getPath(loki, ['auth_enabled']), false);
  assert.equal(lokiResourceAttrs(loki).ignore_defaults, true);
  assert.deepEqual([...lokiIndexLabels(loki).attributes].sort(), [...CANON.labels].sort());
  assert.deepEqual(getPath(loki, ['limits_config', 'discover_service_name']), []);
  const retention = findKeys(tempo, 'block_retention').map((h) => days(h.value));
  assert.deepEqual(retention, [CANON.tempoRetention]);
  assert.deepEqual(findKeys(tempo, 'address').filter((h) => /KAFKA/.test(String(h.value))).map((h) => h.value), ['${PEAKET_OBS_KAFKA_BROKERS}']);
  assert.ok(![...strings(tempo)].some((s) => /(^|[^_])PEAKET_KAFKA_BROKERS/.test(s)), 'Tempo가 거래 Kafka 변수를 쓴다');
  assert.deepEqual(tempoProcessorLists(tempo).map((h) => [...h.value].sort()), [SERVICE_GRAPH_PROCESSORS]);
  const rw = tempoRemoteWrites(tempo);
  assert.equal(rw.length, 1);
  assert.equal(rw[0].value.length, 1);
  assert.deepEqual([rw[0].value[0].url, rw[0].value[0].headers], [mimirRawUrl(), { 'X-Scope-OrgID': 'raw' }]);

  // 복제·영역 인식(Mimir·Loki 각각)
  for (const file of [MIMIR, LOKI]) {
    blocks(file, `${file} 복제 2`, (r) => editYaml(r, file, (d) => setEvery(d, 'replication_factor', 2, file)));
    blocks(file, `${file} 영역 인식 끔`, (r) => editYaml(r, file, (d) => setEvery(d, 'zone_awareness_enabled', false, file)));
  }
  // Loki 보존: 30일(정본)의 양쪽 경계는 막고, 같은 30일을 시간으로 적은 것은 통과
  for (const v of [`${CANON.lokiRetention - 1}d`, `${CANON.lokiRetention + 1}d`]) {
    blocks(LOKI, `Loki 보존 ${v}`, (r) => editYaml(r, LOKI, (d) => setPath(d, ['limits_config', 'retention_period'], v)));
  }
  const hours = fixture();
  editYaml(hours, LOKI, (d) => setPath(d, ['limits_config', 'retention_period'], `${CANON.lokiRetention * 24}h`));
  const h = check(hours);
  assert.equal(h.status, 0, h.out);
  // Tempo 보존 13일
  blocks(TEMPO, 'Tempo 보존 13일', (r) => editYaml(r, TEMPO, (d) => setEvery(d, 'block_retention', `${(CANON.tempoRetention - 1) * 24}h`, TEMPO)));
  // Loki 한도 넷 각각을 기본값(ADR-0125 맥락)으로
  for (const [k, mb] of Object.entries(CANON.defaults)) {
    blocks(LOKI, `Loki ${k} ${mb}`, (r) => editYaml(r, LOKI, (d) => setPath(d, ['limits_config', k], k.endsWith('_mb') ? mb : `${mb}MB`)));
  }
  // Loki 색인 라벨: 하나 더함(level)·하나 뺌(cluster)·기본 색인 목록 켬·지어 붙인 서비스 이름 켬
  blocks(LOKI, 'Loki 라벨 level 더함', (r) => editYaml(r, LOKI, (d) => lokiIndexLabels(d).attributes.push('level')));
  blocks(LOKI, 'Loki 라벨 cluster 뺌', (r) =>
    editYaml(r, LOKI, (d) => {
      const item = lokiIndexLabels(d);
      item.attributes = item.attributes.filter((a) => a !== 'cluster');
    }),
  );
  blocks(LOKI, 'Loki 기본 색인 목록 켬', (r) => editYaml(r, LOKI, (d) => (lokiResourceAttrs(d).ignore_defaults = false)));
  blocks(LOKI, 'Loki discover_service_name 값', (r) => editYaml(r, LOKI, (d) => setPath(d, ['limits_config', 'discover_service_name'], ['service'])));
  // Tempo 쓰기 큐: 거래 Kafka 변수·고정 주소
  blocks(TEMPO, 'Tempo 거래 Kafka 변수', (r) => writeIn(r, TEMPO, readIn(r, TEMPO).replaceAll('PEAKET_OBS_KAFKA_BROKERS', 'PEAKET_KAFKA_BROKERS')));
  blocks(TEMPO, 'Tempo 고정 Kafka 주소', (r) => writeIn(r, TEMPO, readIn(r, TEMPO).replaceAll('${PEAKET_OBS_KAFKA_BROKERS}', 'kafka-obs.observability.svc:9092')));
  // 서비스 그래프 처리기 뺌·span 지표 처리기 더함
  blocks(TEMPO, 'Tempo 서비스 그래프 뺌', (r) =>
    editYaml(r, TEMPO, (d) => {
      for (const l of tempoProcessorLists(d)) l.parent[l.key] = l.value.filter((p) => !p.startsWith('service-graphs'));
    }),
  );
  blocks(TEMPO, 'Tempo 연결 지표 뺌', (r) =>
    editYaml(r, TEMPO, (d) => {
      for (const l of tempoProcessorLists(d)) l.parent[l.key] = l.value.filter((p) => p !== 'service-graphs-connection-info');
    }),
  );
  blocks(TEMPO, 'Tempo span 지표 더함', (r) =>
    editYaml(r, TEMPO, (d) => {
      for (const l of tempoProcessorLists(d)) l.value.push('span-metrics');
    }),
  );
  // 원격 쓰기: 테넌트 agg5m·둘째 원격 쓰기
  blocks(TEMPO, 'Tempo 원격 쓰기 agg5m', (r) => editYaml(r, TEMPO, (d) => setEvery(d, 'X-Scope-OrgID', 'agg5m', TEMPO)));
  blocks(TEMPO, 'Tempo 둘째 원격 쓰기', (r) =>
    editYaml(r, TEMPO, (d) => {
      const [w] = tempoRemoteWrites(d);
      w.value.push({ ...w.value[0], url: 'http://prometheus.observability.svc:9090/api/v1/write' });
    }),
  );
  // 운영 판의 로컬 값: 메모리 링·복제 1·파일 저장소, Tempo Kafka 끔
  blocks(LOKI, 'Loki 메모리 링', (r) => editYaml(r, LOKI, (d) => setPath(d, ['common', 'ring', 'kvstore', 'store'], 'inmemory')));
  blocks(MIMIR, 'Mimir 메모리 링', (r) => editYaml(r, MIMIR, (d) => setPath(d, ['ingester', 'ring', 'kvstore', 'store'], 'inmemory')));
  blocks(LOKI, 'Loki 복제 1', (r) => editYaml(r, LOKI, (d) => setEvery(d, 'replication_factor', 1, LOKI)));
  blocks(MIMIR, 'Mimir 복제 1', (r) => editYaml(r, MIMIR, (d) => setEvery(d, 'replication_factor', 1, MIMIR)));
  blocks(LOKI, 'Loki 파일 저장소', (r) => editYaml(r, LOKI, (d) => setEvery(d, 'object_store', 'filesystem', LOKI)));
  blocks(MIMIR, 'Mimir 파일 저장소', (r) => editYaml(r, MIMIR, (d) => setPath(d, ['blocks_storage', 'backend'], 'filesystem')));
  blocks(TEMPO, 'Tempo 파일 저장소', (r) => editYaml(r, TEMPO, (d) => setPath(d, ['storage', 'trace', 'backend'], 'local')));
  blocks(TEMPO, 'Tempo Kafka 끔', (r) => editYaml(r, TEMPO, (d) => delete d.ingest));

  // 두 군데를 깨면 막음 줄도 둘 이상이고 두 파일이 다 나온다
  const two = fixture();
  editYaml(two, MIMIR, (d) => setEvery(d, 'replication_factor', 2, MIMIR));
  editYaml(two, TEMPO, (d) => setEvery(d, 'block_retention', '24h', TEMPO));
  const lines = assertBlocked(two, MIMIR, '두 군데');
  assert.ok(lines.length >= 2, lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith(`막음: ${TEMPO}: `)), lines.join('\n'));
});

test('V-T50 ① 원천을 읽지 못하면 2이고 통과로 보지 않는다', () => {
  for (const rel of [MIMIR, LOKI, TEMPO, LOKI_LOCAL, PG_EXPORTER, YACE]) {
    const root = fixture();
    rmSync(join(root, rel));
    const r = check(root);
    assert.equal(r.status, 2, `${rel} 지움\n${r.out}`);
  }
  const broken = fixture();
  writeIn(broken, LOKI, `${readIn(broken, LOKI)}\nlimits_config: [깨진\n`);
  assert.equal(check(broken).status, 2);
  // 정본 행이 없다: §9 '정형 로그' 행, ADR-0125의 Loki 한도 줄
  const noRow = fixture();
  writeIn(noRow, DOC, readIn(noRow, DOC).replace(/^\| 정형 로그 \|/m, '| 로그 |'));
  assert.equal(check(noRow).status, 2, check(noRow).out);
  const noAdr = fixture();
  writeIn(noAdr, ADR, readIn(noAdr, ADR).replace(/^(\s*)- Loki 한도:/m, '$1- 한도:'));
  assert.equal(check(noAdr).status, 2, check(noAdr).out);
  rmSync(join(noAdr, ADR));
  assert.equal(check(noAdr).status, 2);
  // 인자 오류
  assert.equal(cli(SCRIPT).status, 2);
  assert.equal(cli(SCRIPT, '--bogus').status, 2);
});

test('V-T50 ① --render는 운영 판 위에 로컬 판을 겹치고 같은 입력이면 같은 글이다', async () => {
  const prod = yamlIn(REPO, LOKI);
  const first = render('loki');
  assert.equal(first.status, 0, first.out);
  const loki = parse(first.stdout);
  // 로컬 판 값: 메모리 링·복제 1
  assert.ok([...strings(loki)].includes('inmemory'), 'Loki 겹친 판에 inmemory 링이 없다');
  const rfs = findKeys(loki, 'replication_factor').map((x) => x.value);
  assert.ok(rfs.length > 0 && rfs.every((v) => v === 1), `겹친 Loki replication_factor ${rfs}`);
  // 로컬 판은 한도·라벨·보존을 덮지 않는다: 운영 판 값 그대로
  assert.deepEqual(loki.limits_config, prod.limits_config);
  assert.equal(days(loki.limits_config.retention_period), CANON.lokiRetention);
  assert.deepEqual([...lokiIndexLabels(loki).attributes].sort(), [...CANON.labels].sort());
  // 로컬 판 포트(계획 §5): HTTP 3100·gRPC 9095
  assert.deepEqual([loki.server?.http_listen_port, loki.server?.grpc_listen_port], [3100, 9095]);
  // 같은 입력이면 같은 바이트
  assert.equal(render('loki').stdout, first.stdout);
  const tempo = render('tempo');
  assert.equal(tempo.status, 0, tempo.out);
  assert.equal(render('tempo').stdout, tempo.stdout);
  const t = parse(tempo.stdout);
  // Tempo 로컬 판: Kafka 쓰기 없음, 원격 쓰기는 시험 Prometheus(peaket-prom:9090)로, 테넌트 머리는 운영 판 그대로, 보존은 운영 판 그대로
  assert.ok(![...strings(t)].some((s) => s.includes('PEAKET_OBS_KAFKA_BROKERS')), '로컬 판 Tempo가 Kafka 주소를 담는다');
  const rw = tempoRemoteWrites(t);
  assert.equal(rw.length, 1);
  assert.deepEqual(rw[0].value.map((w) => [w.url, w.headers]), [['http://peaket-prom:9090/api/v1/write', { 'X-Scope-OrgID': 'raw' }]]);
  assert.deepEqual(findKeys(t, 'block_retention').map((x) => days(x.value)), [CANON.tempoRetention]);
  assert.deepEqual(tempoProcessorLists(t).map((x) => [...x.value].sort()), [SERVICE_GRAPH_PROCESSORS]);

  // 겹치기 규칙: 표는 키마다 합치고, 목록과 값은 로컬 판이 통째로 바꾸며, 로컬 판에만 있는 키를 더한다
  const root = fixture();
  editYaml(root, LOKI, (d) => {
    d.memberlist = { join_members: ['a.obs', 'b.obs', 'c.obs'], bind_port: 7946 };
    d.server = { ...d.server, log_level: 'info', http_server_read_timeout: '30s' };
  });
  editYaml(root, LOKI_LOCAL, (d) => {
    d.memberlist = { join_members: ['local.obs'] };
    d.server = { ...d.server, log_level: 'debug' };
    d.analytics = { reporting_enabled: false };
  });
  const merged = render('loki', root);
  assert.equal(merged.status, 0, merged.out);
  const m = parse(merged.stdout);
  assert.deepEqual(m.memberlist, { join_members: ['local.obs'], bind_port: 7946 });
  assert.equal(m.server.log_level, 'debug');
  assert.equal(m.server.http_server_read_timeout, '30s');
  assert.deepEqual(m.analytics, { reporting_enabled: false });

  // 함수 꼴(계획 §5): 명령줄과 같은 글, 실제 저장소 위반 0
  const mod = await import(pathToFileURL(SCRIPT).href);
  assert.equal(mod.renderLocalConfig(REPO, 'loki').trimEnd(), first.stdout.trimEnd());
  assert.deepEqual(mod.checkObservabilityStores(REPO), []);

  // 모르는 이름·로컬 판 없음 → 2
  assert.equal(render('bogus').status, 2);
  assert.equal(render('mimir').status, 2);
  const noLocal = fixture();
  rmSync(join(noLocal, TEMPO_LOCAL));
  assert.equal(render('tempo', noLocal).status, 2);
});

test('V-T50 ② [ASVS v5.0.0-16.2.4] 신호 연결이 빠지거나 없는 데이터 소스를 가리키면 막는다', () => {
  const real = check();
  assert.equal(real.status, 0, real.out);
  // F-01-2의 검사도 연결을 더한 실제 저장소에서 그대로 0
  const f012 = cli(CONFIG_SCRIPT, '--check');
  assert.equal(f012.status, 0, f012.out);

  // 실제 원천: exemplar traceId → tempo(Prometheus·Mimir 원본), Tempo 서비스 지도 → mimir-raw, 노드 그래프, 프로파일 → pyroscope
  const ds = (root, rel, uid) => yamlIn(root, rel).datasources.find((d) => d.uid === uid);
  const want = [{ name: CANON.exemplarName, datasourceUid: 'tempo' }];
  assert.deepEqual(ds(REPO, DATASOURCES, 'prometheus').jsonData.exemplarTraceIdDestinations, want);
  assert.deepEqual(ds(REPO, DATASOURCES_PLATFORM, 'mimir-raw').jsonData.exemplarTraceIdDestinations, want);
  const tempo = ds(REPO, DATASOURCES_PLATFORM, 'tempo').jsonData;
  assert.deepEqual([tempo.serviceMap?.datasourceUid, tempo.nodeGraph?.enabled, tempo.tracesToProfiles?.datasourceUid], ['mimir-raw', true, 'pyroscope']);

  const edit = (rel, uid, fn) => (r) => editYaml(r, rel, (d) => fn(d.datasources.find((x) => x.uid === uid)));
  blocks(DATASOURCES, 'Prometheus exemplar 뺌', edit(DATASOURCES, 'prometheus', (d) => delete d.jsonData.exemplarTraceIdDestinations));
  blocks(DATASOURCES_PLATFORM, 'Mimir 원본 exemplar 뺌', edit(DATASOURCES_PLATFORM, 'mimir-raw', (d) => delete d.jsonData.exemplarTraceIdDestinations));
  blocks(DATASOURCES, 'exemplar 이름 trace_id', edit(DATASOURCES, 'prometheus', (d) => (d.jsonData.exemplarTraceIdDestinations[0].name = 'trace_id')));
  blocks(DATASOURCES_PLATFORM, 'exemplar가 없는 데이터 소스', edit(DATASOURCES_PLATFORM, 'mimir-raw', (d) => (d.jsonData.exemplarTraceIdDestinations[0].datasourceUid = 'tempo-missing')));
  blocks(DATASOURCES_PLATFORM, '서비스 지도 agg5m', edit(DATASOURCES_PLATFORM, 'tempo', (d) => (d.jsonData.serviceMap.datasourceUid = 'mimir-agg5m')));
  blocks(DATASOURCES_PLATFORM, '서비스 지도 없는 데이터 소스', edit(DATASOURCES_PLATFORM, 'tempo', (d) => (d.jsonData.serviceMap.datasourceUid = 'mimir-missing')));
  blocks(DATASOURCES_PLATFORM, '노드 그래프 끔', edit(DATASOURCES_PLATFORM, 'tempo', (d) => (d.jsonData.nodeGraph.enabled = false)));
  blocks(DATASOURCES_PLATFORM, '프로파일 연결 뺌', edit(DATASOURCES_PLATFORM, 'tempo', (d) => delete d.jsonData.tracesToProfiles));
  // 가리키는 데이터 소스(Tempo)를 다른 조직(orgId 2)으로 옮긴다: Prometheus·Mimir 원본의 exemplar가 다른 조직을 가리킨다
  blocks(DATASOURCES_PLATFORM, 'Tempo 다른 조직', edit(DATASOURCES_PLATFORM, 'tempo', (d) => (d.orgId = 2)));
  // 가리키는 Pyroscope를 다른 조직으로
  blocks(DATASOURCES_PLATFORM, 'Pyroscope 다른 조직', edit(DATASOURCES_PLATFORM, 'pyroscope', (d) => (d.orgId = 2)));
});

test('V-T50 ⑥ exporter 인자가 §8과 어긋나면 막는다', () => {
  const real = check();
  assert.equal(real.status, 0, real.out);

  // 실제 원천: postgres_exporter는 쿼리 통계 켬·쿼리 문장 끔·상위 20, 접속 주소 없음
  const pg = yamlIn(REPO, PG_EXPORTER);
  assert.deepEqual(Object.keys(pg).sort(), ['args', 'image']);
  assert.ok(pg.args.includes('--collector.stat_statements'), pg.args.join(' '));
  assert.ok(pg.args.includes(`--collector.stat_statements.limit=${CANON.top}`), pg.args.join(' '));
  assert.ok(!pg.args.includes('--collector.stat_statements.include_query'), pg.args.join(' '));
  assert.ok(!pg.args.some((a) => /postgres(ql)?:\/\/|DATA_SOURCE/.test(a)), '인자에 접속 주소가 있다');
  // 실제 원천: YACE는 §8 표의 두 줄만(us-east-1, 한도 사용률 Requests 1분 합계 하나, 엣지 실패 셋을 delay 5분으로)
  const y = yaceJobs(yamlIn(REPO, YACE));
  assert.equal(y.jobs.length, 2);
  for (const j of y.jobs) assert.deepEqual(j.regions, [CANON.region]);
  assert.deepEqual(y.names(y.quota), CANON.quotaMetrics);
  assert.deepEqual(y.quota.metrics.map((x) => [x.statistics, x.period]), [[['Sum'], 60]]);
  assert.deepEqual([...y.names(y.edge)].sort(), CANON.edgeMetrics);
  assert.equal(y.edge.delay, CANON.edgeDelaySec);

  const pgArgs = (fn) => (r) => editYaml(r, PG_EXPORTER, (d) => (d.args = fn(d.args)));
  const without = (re) => (a) => a.filter((x) => !re.test(x));
  blocks(PG_EXPORTER, '쿼리 문장 싣기 켬', pgArgs((a) => [...without(/include_query/)(a), '--collector.stat_statements.include_query']));
  blocks(PG_EXPORTER, '상위 21', pgArgs((a) => [...without(/stat_statements\.limit/)(a), `--collector.stat_statements.limit=${CANON.top + 1}`]));
  blocks(PG_EXPORTER, '상위 한도 없음', pgArgs(without(/stat_statements\.limit/)));
  blocks(PG_EXPORTER, '쿼리 통계 수집기 끔', pgArgs((a) => [...without(/^--(no-)?collector\.stat_statements$/)(a), '--no-collector.stat_statements']));
  // 상위 20(정본 값 그대로, 경계 안쪽)은 통과
  const ok = fixture();
  editYaml(ok, PG_EXPORTER, (d) => (d.args = [...d.args.filter((x) => !/stat_statements\.limit/.test(x)), `--collector.stat_statements.limit=${CANON.top}`]));
  assert.equal(check(ok).status, 0, check(ok).out);

  const yace = (fn) => (r) => editYaml(r, YACE, (d) => fn(yaceJobs(d)));
  blocks(YACE, 'CloudFront 지표 하나 더함', yace((j) => j.quota.metrics.push({ ...j.quota.metrics[0], name: 'BytesDownloaded' })));
  blocks(YACE, '첫 작업에 502ErrorRate', yace((j) => j.quota.metrics.push({ ...j.quota.metrics[0], name: '502ErrorRate', statistics: ['Average'] })));
  blocks(YACE, 'delay 0', yace((j) => (j.edge.delay = 0)));
  blocks(YACE, '둘째 작업에 세 번째 배포', yace((j) => {
    let changed = 0;
    for (const t of j.edge.searchTags ?? []) {
      if (typeof t.value === 'string' && t.value.includes('api')) {
        t.value = t.value.replace('api', 'api|static');
        changed++;
      }
    }
    assert.ok(changed > 0, `YACE 엣지 작업 searchTags에 queue·api 고르기가 없다: ${JSON.stringify(j.edge.searchTags)}`);
  }));
  blocks(YACE, '세 번째 작업', yace((j) => j.jobs.push({ ...j.quota, metrics: [{ ...j.quota.metrics[0], name: 'TotalErrorRate' }] })));
});
