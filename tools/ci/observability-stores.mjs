#!/usr/bin/env node
// 관측 저장소·exporter·신호 연결 설정 정적 검사와 로컬 판 겹치기(V-T50 ①②⑥, docs/observability.md §1 '관측 저장소 설정 원천과 로컬 확인',
// ADR-0125 결정 4, ASVS v5.0.0-16.2.4, 기능 F-01-4). 클러스터 없이 deploy/platform/observability/ 아래 원천을 정본 문서의 값과 견준다.
// - Mimir(mimir/config.yaml): 복제 수가 §1 Mimir 줄의 'N중 복제'이고 영역 인식이 켜져 있는지
// - Loki(loki/config.yaml): 복제·영역 인식(§1), 보존(§9 '정형 로그' 행), 한도 넷(ADR-0125 결정 4), 인증 끔, OTLP 색인 라벨이 §7 '라벨 허용 목록'과
//   같고 기본 색인 목록·서비스 이름 지어 붙이기가 꺼져 있는지
// - Tempo(tempo/config.yaml): 보존(§9 '분산 트레이스' 행), 쓰기 큐 주소가 관측 전용 Kafka 변수인지, 처리기가 서비스 그래프와 그 연결 지표뿐인지,
//   원격 쓰기가 Mimir raw 하나뿐인지(prometheus/remote-write.yaml의 mimir-raw 주소)
// - 운영 판의 로컬 값: 메모리 링(inmemory), 복제 1, 파일 저장소, Tempo의 Kafka 끔
// - 로컬 판(loki/local.yaml·tempo/local.yaml): 겹친 결과가 운영 판의 한도·라벨·보존·처리기·원격 쓰기 테넌트를 덮지 않는지
// - exporter(exporters/postgres-exporter.yaml·yace.yaml): 쿼리 통계 켬·쿼리 문장 끔·상위 N(§8 '쿼리 통계 예외'), YACE는 §8 지표 출처 표의 CloudFront 두 줄만
// - Grafana 신호 연결(grafana/provisioning/datasources*.yaml): exemplar traceId → Tempo(§2), Tempo 서비스 지도 → Mimir raw·노드 그래프,
//   Tempo → Pyroscope, Loki traceId 파생 필드 → Tempo, Tempo → Loki(같은 traceId), 연결이 가리키는 데이터 소스가 있고 같은 조직(orgId)에 있는지
// - 게이트웨이 수집기의 자원 속성→Loki 라벨 넷은 collector-config.mjs --check가 본다(F-01-9)
// 겹치기(--render): 운영 판 위에 로컬 판을 깊게 합친다. 표는 키마다 합치고, 목록과 값은 로컬 판이 통째로 바꾸며, 로컬 판의 값 null은 그 키를 지운다.
// 쓰는 법(저장소 뿌리에서):
//   node tools/ci/observability-stores.mjs --check [--root <저장소>]           끝 코드 0 통과, 1 위반('막음: <파일>: <까닭>'), 2 인자·읽기·YAML 오류
//   node tools/ci/observability-stores.mjs --render <loki|tempo> [--root <저장소>]  표준 출력에 겹친 YAML, 끝 코드 0, 모르는 이름·읽기 실패 2
// 읽는 파일: deploy/platform/observability/ 아래, docs/observability.md, docs/adr/0125-…md뿐이다.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments, stringify } from 'yaml';

const USAGE = '쓰는 법: node tools/ci/observability-stores.mjs --check [--root <저장소>] | --render <loki|tempo> [--root <저장소>]';
const OBS = 'deploy/platform/observability';
const MIMIR = `${OBS}/mimir/config.yaml`;
const LOKI = `${OBS}/loki/config.yaml`;
const TEMPO = `${OBS}/tempo/config.yaml`;
const LOCAL = { loki: `${OBS}/loki/local.yaml`, tempo: `${OBS}/tempo/local.yaml` };
const PROD = { loki: LOKI, tempo: TEMPO };
const PG_EXPORTER = `${OBS}/exporters/postgres-exporter.yaml`;
const YACE = `${OBS}/exporters/yace.yaml`;
const DATASOURCES = `${OBS}/grafana/provisioning/datasources.yaml`;
const DATASOURCES_PLATFORM = `${OBS}/grafana/provisioning/datasources-platform.yaml`;
const REMOTE_WRITE = `${OBS}/prometheus/remote-write.yaml`;
const DOC = 'docs/observability.md';
const ADR = 'docs/adr/0125-entry-path-head-sampling-collector-sizing-shared-sample-threshold.md';

/** Tempo 관측 전용 Kafka 주소 변수(§1)와 쓰면 안 되는 거래·텔레메트리 Kafka 변수 */
const OBS_KAFKA = '${PEAKET_OBS_KAFKA_BROKERS}';
const TRADE_KAFKA = /(^|[^_])PEAKET_KAFKA_BROKERS/;
/**
 * Tempo metrics-generator 처리기: 서비스 그래프와 그 연결 지표(§1·§6). 처리기 이름은 도구의 이름이다.
 * Tempo 3.1.1은 연결 지표 traces_service_graph_connection_info를 처리기 목록의 하위 이름 service-graphs-connection-info로 켠다
 */
const SERVICE_GRAPH_PROCESSORS = ['service-graphs', 'service-graphs-connection-info'];
/** 원격 쓰기·데이터 소스 테넌트 머리 */
const TENANT_HEADER = 'X-Scope-OrgID';
const RAW_TENANT = 'raw';
/** §8 지표 출처 표의 '1분 합계'·'1분 평균'(YACE 지표 칸의 period·statistics) */
const MINUTE = 60;
const LOKI_LIMIT_KEYS = ['ingestion_rate_mb', 'ingestion_burst_size_mb', 'per_stream_rate_limit', 'per_stream_rate_limit_burst'];
const DS_TYPES = { tempo: 'tempo', prometheus: 'prometheus', pyroscope: 'grafana-pyroscope-datasource', loki: 'loki' };

/** 읽기 실패(끝 코드 2) */
class ReadError extends Error {}

const readText = (root, rel) => {
  const file = join(root, rel);
  if (!existsSync(file)) throw new ReadError(`${rel}이 없다`);
  return readFileSync(file, 'utf8');
};

/** YAML 문서 하나(표). 해석 오류·여러 문서·표가 아님은 읽기 실패 */
function readYaml(root, rel) {
  const docs = parseAllDocuments(readText(root, rel));
  for (const d of docs) if (d.errors.length) throw new ReadError(`${rel}: YAML을 읽지 못했다: ${d.errors[0].message}`);
  const values = docs.map((d) => d.toJS()).filter((x) => x !== null && x !== undefined);
  if (values.length !== 1 || !isMap(values[0])) throw new ReadError(`${rel}: YAML 표 문서 하나여야 한다(지금 ${values.length}개)`);
  return values[0];
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const getPath = (doc, path) => path.reduce((o, k) => (isMap(o) ? o[k] : undefined), doc);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => [...a].sort();

/** 이름이 key인 모든 칸의 값(깊이 끝까지) */
function findKeys(value, key, out = []) {
  if (Array.isArray(value)) for (const v of value) findKeys(v, key, out);
  else if (isMap(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === key) out.push(v);
      findKeys(v, key, out);
    }
  }
  return out;
}

/** 값 안의 모든 문자열 */
function* strings(value) {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (isMap(value)) for (const v of Object.values(value)) yield* strings(v);
}

/** '30d'·'720h'·'2w'·'336h0m0s' 꼴 기간을 일로. 꼴이 아니면 undefined */
export function durationDays(text) {
  const s = String(text ?? '').trim();
  if (!/^(\d+(w|d|h|m|s))+$/.test(s)) return undefined;
  const unit = { w: 7, d: 1, h: 1 / 24, m: 1 / 1440, s: 1 / 86400 };
  let days = 0;
  for (const m of s.matchAll(/(\d+)(w|d|h|m|s)/g)) days += Number(m[1]) * unit[m[2]];
  return Math.round(days * 1e6) / 1e6;
}

/** '15MB'·'15MiB'·바이트 수를 MB 수로(Loki 크기 꼴. MB·MiB 둘 다 같은 수로 읽는다). 꼴이 아니면 undefined */
function megabytes(value) {
  if (typeof value === 'number') return value % 2 ** 20 === 0 ? value / 2 ** 20 : value / 1e6;
  const m = /^(\d+(?:\.\d+)?)\s*(MB|MiB)$/i.exec(String(value ?? '').trim());
  return m ? Number(m[1]) : undefined;
}

// ---------- 정본에서 읽는 값 ----------

/** docs/observability.md·ADR-0125에서 검사 값을 읽는다. 못 읽으면 ReadError */
export function readCanon(root) {
  const lines = readText(root, DOC).split(/\r?\n/);
  const need = (cond, what) => {
    if (!cond) throw new ReadError(`${DOC}: ${what}을 읽지 못했다`);
  };
  const line = (re, what) => {
    const l = lines.find((x) => re.test(x));
    need(l, what);
    return l;
  };
  const int = (re, text, what) => {
    const n = Number(re.exec(text ?? '')?.[1]);
    need(Number.isInteger(n) && n > 0, what);
    return n;
  };
  const stores = line(/^\s*- Mimir: 고전 구조/, "§1 'Mimir: 고전 구조' 줄");
  const mimirRf = int(/인제스터 영역 인식\s*(\d)중 복제/, stores, "§1 Mimir 'N중 복제'");
  const lokiRf = int(/Loki: 영역 인식\s*(\d)중 복제/, stores, "§1 'Loki: 영역 인식 N중 복제'");
  const labelLine = line(/^\|\s*Loki 라벨 허용 목록/, "§7 'Loki 라벨 허용 목록' 행");
  const labels = [...labelLine.split('만 쓴다')[0].matchAll(/`([a-z]+)`/g)].map((m) => m[1]);
  need(labels.length > 0, '§7 Loki 라벨 이름');
  const exemplarName = /exemplar\(`(\w+)`·`spanId`\)/.exec(line(/OpenMetrics exemplar\(`/, "§2 'OpenMetrics exemplar' 줄"))?.[1];
  need(exemplarName, '§2 exemplar 이름');
  const top = int(/상위\s*(\d+)\s*개/, line(/^- 쿼리 통계 예외/, "§8 '쿼리 통계 예외' 줄"), "§8 '상위 N개'");
  const quotaSource = line(/^\s*\|\s*CloudFront 배포별 한도 사용률/, '§8 지표 출처 표의 CloudFront 한도 사용률 줄').split('|')[2] ?? '';
  const edgeSource = line(/^\s*\|\s*엣지에서 끝난 실패/, '§8 지표 출처 표의 엣지에서 끝난 실패 줄').split('|')[2] ?? '';
  const region = /CloudWatch\(([a-z0-9-]+)\)/.exec(quotaSource)?.[1];
  need(region, '§8 CloudFront CloudWatch 지역');
  const quotaMetrics = [...new Set([...quotaSource.matchAll(/CloudFront `(\w+)`/g)].map((m) => m[1]))];
  need(quotaMetrics.length > 0, '§8 한도 사용률 줄의 CloudFront 지표');
  const edgeMetrics = [...new Set([...edgeSource.split('를 1분마다')[0].matchAll(/`(\w*(?:ErrorRate|Requests))`/g)].map((m) => m[1]))];
  need(edgeMetrics.length > 0, '§8 엣지 실패 줄의 지표');
  const edgeDelaySec = int(/`delay` (\d+)분/, edgeSource, '§8 엣지 실패 줄의 delay') * 60;
  const edgeDists = /([a-z]+)·([a-z]+) 두 배포만/.exec(edgeSource)?.slice(1);
  need(edgeDists, "§8 엣지 실패 줄의 'a·b 두 배포만'");
  const retention = (row) => {
    const l = line(new RegExp(`^\\|\\s*${row}\\s*\\|`), `§9 보존 표 '${row}' 행`);
    return int(/(\d+)\s*일/, l.split('|')[3], `§9 '${row}' 행의 보존 일 수`);
  };
  const adr = readText(root, ADR).split(/\r?\n/);
  const limitLine = adr.find((l) => /^\s*- Loki 한도:/.test(l));
  if (!limitLine) throw new ReadError(`${ADR}: 결정 4의 'Loki 한도' 줄이 없다`);
  const limits = {
    ingestion_rate_mb: Number(/`ingestion_rate_mb` (\d+)/.exec(limitLine)?.[1]),
    ingestion_burst_size_mb: Number(/`ingestion_burst_size_mb` (\d+)/.exec(limitLine)?.[1]),
    per_stream_rate_limit: Number(/`per_stream_rate_limit` (\d+)MB/.exec(limitLine)?.[1]),
    per_stream_rate_limit_burst: Number(/`per_stream_rate_limit_burst` (\d+)MB/.exec(limitLine)?.[1]),
  };
  for (const [k, v] of Object.entries(limits)) if (!(v > 0)) throw new ReadError(`${ADR}: 'Loki 한도' 줄에서 ${k}를 읽지 못했다`);
  return {
    mimirRf, lokiRf, labels, exemplarName, top, region, quotaMetrics, edgeMetrics, edgeDelaySec, edgeDists, limits,
    lokiRetention: retention('정형 로그'),
    tempoRetention: retention('분산 트레이스'),
  };
}

// ---------- 겹치기 ----------

/** 운영 판 위에 로컬 판: 표는 키마다 합치고, 목록과 값은 로컬 판이 바꾸며, 로컬 판의 null은 그 키를 지운다 */
export function overlay(base, over) {
  if (!isMap(base) || !isMap(over)) return structuredClone(over);
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (!(k in over)) out[k] = structuredClone(v);
    else if (over[k] !== null) out[k] = overlay(v, over[k]);
  }
  for (const [k, v] of Object.entries(over)) if (!(k in base) && v !== null) out[k] = structuredClone(v);
  return out;
}

function mergedLocal(root, store) {
  if (!(store in LOCAL)) throw new ReadError(`로컬 판이 없는 저장소: ${store}(loki·tempo만)`);
  return overlay(readYaml(root, PROD[store]), readYaml(root, LOCAL[store]));
}

/** 겹친 로컬 판 YAML 글. 같은 입력이면 같은 글이다 */
export function renderLocalConfig(root, store) {
  const head = `# 생성: node tools/ci/observability-stores.mjs --render ${store}(${PROD[store]} 위에 ${LOCAL[store]}). 손으로 고치지 않는다\n`;
  return head + stringify(mergedLocal(root, store), { lineWidth: 0 });
}

// ---------- 검사 ----------

/** 위반 목록(빈 배열이면 통과). 각 항목은 '<파일>: <까닭>'. 읽기 실패는 ReadError로 던진다 */
export function checkObservabilityStores(root) {
  const canon = readCanon(root);
  const problems = [];
  const bad = (file, why) => problems.push(`${file}: ${why}`);
  const mimir = readYaml(root, MIMIR);
  const loki = readYaml(root, LOKI);
  const tempo = readYaml(root, TEMPO);
  const pgExporter = readYaml(root, PG_EXPORTER);
  const yace = readYaml(root, YACE);
  const lokiLocal = mergedLocal(root, 'loki');
  const tempoLocal = mergedLocal(root, 'tempo');
  const rawUrl = (readYaml(root, REMOTE_WRITE).remote_write ?? []).find((w) => w?.headers?.[TENANT_HEADER] === RAW_TENANT)?.url;
  if (!rawUrl) throw new ReadError(`${REMOTE_WRITE}: 테넌트 ${RAW_TENANT}로 보내는 원격 쓰기 주소가 없다`);

  // --- 복제·영역 인식·로컬 값(Mimir·Loki) ---
  for (const [file, doc, rf, what] of [[MIMIR, mimir, canon.mimirRf, 'Mimir'], [LOKI, loki, canon.lokiRf, 'Loki']]) {
    const rfs = findKeys(doc, 'replication_factor');
    if (rfs.length === 0) bad(file, `replication_factor가 없다(${what}은 ${rf}중 복제, observability §1)`);
    for (const v of rfs) if (v !== rf) bad(file, `replication_factor ${v}가 ${DOC} §1의 ${rf}중 복제와 다르다`);
    const zones = findKeys(doc, 'zone_awareness_enabled');
    if (zones.length === 0) bad(file, 'zone_awareness_enabled가 없다(영역 인식 복제, observability §1)');
    for (const v of zones) if (v !== true) bad(file, `zone_awareness_enabled가 ${v}다(영역 인식을 켠다, observability §1)`);
  }
  if (getPath(mimir, ['ingester', 'ring', 'replication_factor']) === undefined) bad(MIMIR, 'ingester.ring.replication_factor가 없다(인제스터 링 복제, observability §1)');
  for (const [file, doc] of [[MIMIR, mimir], [LOKI, loki], [TEMPO, tempo]]) {
    if ([...strings(doc)].includes('inmemory')) bad(file, '운영 판에 메모리 링(inmemory)이 있다(로컬 판 값)');
  }
  for (const v of findKeys(mimir, 'backend')) if (v === 'filesystem') bad(MIMIR, '운영 판 저장소가 파일(filesystem)이다(로컬 값, 객체 저장소를 쓴다)');
  for (const v of findKeys(loki, 'object_store')) if (v === 'filesystem' || v === 'inmemory') bad(LOKI, `운영 판 object_store가 ${v}다(로컬 값, 객체 저장소를 쓴다)`);
  if (findKeys(loki, 'filesystem').length > 0) bad(LOKI, '운영 판에 파일 저장소(filesystem) 설정이 있다(로컬 값)');
  const traceBackend = getPath(tempo, ['storage', 'trace', 'backend']);
  if (traceBackend === 'local' || traceBackend === 'filesystem' || traceBackend === undefined) bad(TEMPO, `운영 판 storage.trace.backend가 ${traceBackend ?? '없음'}이다(로컬 값, 객체 저장소를 쓴다)`);

  // --- Loki 보존·한도·인증·색인 라벨 ---
  const lokiDays = durationDays(getPath(loki, ['limits_config', 'retention_period']));
  if (lokiDays !== canon.lokiRetention) bad(LOKI, `limits_config.retention_period ${lokiDays ?? '없음'}일이 ${DOC} §9 '정형 로그' 행의 ${canon.lokiRetention}일과 다르다`);
  if (getPath(loki, ['compactor', 'retention_enabled']) !== true) bad(LOKI, 'compactor.retention_enabled가 true가 아니다(보존 기간이 지나도 지우지 않는다)');
  for (const k of LOKI_LIMIT_KEYS) {
    const v = getPath(loki, ['limits_config', k]);
    const mb = k.endsWith('_mb') ? (typeof v === 'number' ? v : undefined) : megabytes(v);
    if (mb !== canon.limits[k]) bad(LOKI, `limits_config.${k} ${v ?? '없음'}이 ${ADR} 결정 4의 ${canon.limits[k]}${k.endsWith('_mb') ? '' : 'MB'}와 다르다`);
  }
  if (loki.auth_enabled !== false) bad(LOKI, 'auth_enabled가 false가 아니다(한 테넌트로 받는다, observability §1)');
  const otlp = getPath(loki, ['limits_config', 'otlp_config']);
  const ra = getPath(otlp, ['resource_attributes']);
  if (getPath(ra, ['ignore_defaults']) !== true) bad(LOKI, 'limits_config.otlp_config.resource_attributes.ignore_defaults가 true가 아니다(기본 색인 목록이 라벨을 더한다)');
  const indexItems = (ra?.attributes_config ?? []).filter((x) => x?.action === 'index_label');
  if (indexItems.length !== 1) bad(LOKI, `OTLP 자원 속성 index_label 항목이 하나가 아니다(${indexItems.length}개)`);
  else {
    const item = indexItems[0];
    const attrs = Array.isArray(item.attributes) ? item.attributes : [];
    if (item.regex !== undefined) bad(LOKI, 'OTLP index_label 항목에 regex가 있다(이름을 적은 넷만)');
    if (!same(sorted(attrs), sorted(canon.labels)) || new Set(attrs).size !== attrs.length) bad(LOKI, `색인 라벨 ${attrs.join(',')}이 ${DOC} §7 라벨 허용 목록 ${canon.labels.join(',')}과 다르다`);
  }
  for (const part of ['scope_attributes', 'log_attributes']) {
    for (const x of getPath(otlp, [part]) ?? []) if (x?.action === 'index_label') bad(LOKI, `otlp_config.${part}에 index_label이 있다(라벨은 자원 속성 넷뿐)`);
  }
  const discover = getPath(loki, ['limits_config', 'discover_service_name']);
  if (!Array.isArray(discover) || discover.length !== 0) bad(LOKI, `limits_config.discover_service_name이 빈 목록이 아니다(서비스 이름을 지어 붙이지 않는다): ${JSON.stringify(discover)}`);

  // --- Tempo 보존·쓰기 큐·처리기·원격 쓰기 ---
  const tempoChecks = (file, doc, local) => {
    const retention = findKeys(doc, 'block_retention');
    if (retention.length !== 1) bad(file, `block_retention이 하나가 아니다(${retention.length}개)`);
    for (const v of retention) if (durationDays(v) !== canon.tempoRetention) bad(file, `block_retention ${v}가 ${DOC} §9 '분산 트레이스' 행의 ${canon.tempoRetention}일과 다르다`);
    const lists = [...findKeys(doc, 'processors'), ...findKeys(doc, 'metrics_generator_processors')].filter((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (lists.length !== 1) bad(file, `metrics-generator 처리기 목록이 하나가 아니다(${lists.length}개)`);
    for (const l of lists) if (!same(sorted(l), sorted(SERVICE_GRAPH_PROCESSORS))) bad(file, `처리기 ${l.join(',')}가 서비스 그래프와 연결 지표(${SERVICE_GRAPH_PROCESSORS.join(',')})뿐이 아니다(observability §1·§6)`);
    const rws = findKeys(doc, 'remote_write').filter(Array.isArray);
    if (rws.length !== 1 || rws[0].length !== 1) bad(file, `원격 쓰기가 하나가 아니다(${rws.map((r) => r.length).join(',') || 0}개, Mimir ${RAW_TENANT} 하나뿐)`);
    for (const w of rws.flat()) {
      if (!same(w?.headers, { [TENANT_HEADER]: RAW_TENANT })) bad(file, `원격 쓰기 머리 ${JSON.stringify(w?.headers)}가 ${TENANT_HEADER}: ${RAW_TENANT} 하나가 아니다`);
      if (!local && w?.url !== rawUrl) bad(file, `원격 쓰기 주소 ${w?.url}가 ${REMOTE_WRITE}의 ${RAW_TENANT} 주소 ${rawUrl}와 다르다`);
    }
  };
  tempoChecks(TEMPO, tempo, false);
  const kafka = getPath(tempo, ['ingest', 'kafka', 'address']);
  if (kafka !== OBS_KAFKA) bad(TEMPO, `ingest.kafka.address가 ${kafka ?? '없음(Kafka 쓰기 끔)'}이다(관측 전용 Kafka ${OBS_KAFKA}, observability §1)`);
  if ([...strings(tempo)].some((s) => TRADE_KAFKA.test(s))) bad(TEMPO, '거래·텔레메트리 Kafka 변수 PEAKET_KAFKA_BROKERS를 쓴다(관측 전용 Kafka와 엮지 않는다)');

  // --- 로컬 판이 운영 판의 한도·라벨·보존·처리기·테넌트를 덮지 않는다 ---
  if (!same(lokiLocal.limits_config, loki.limits_config)) bad(LOCAL.loki, '겹친 로컬 판의 limits_config가 운영 판과 다르다(한도·라벨·보존은 덮지 않는다)');
  tempoChecks(LOCAL.tempo, tempoLocal, true);
  if ([...strings(tempoLocal)].some((s) => s.includes('KAFKA_BROKERS'))) bad(LOCAL.tempo, '겹친 로컬 판에 Kafka 주소가 남는다(로컬 판은 모놀리식, Kafka 없음)');

  // --- postgres_exporter ---
  const keys = sorted(Object.keys(pgExporter));
  if (!same(keys, ['args', 'image'])) bad(PG_EXPORTER, `칸이 image·args가 아니다: ${keys.join(',')}(접속 주소는 환경 변수 DATA_SOURCE_NAME으로)`);
  if (typeof pgExporter.image !== 'string' || !/:[^:@/]+@sha256:[0-9a-f]{64}$/.test(pgExporter.image)) bad(PG_EXPORTER, `image ${pgExporter.image}가 판과 다이제스트로 고정되어 있지 않다`);
  const args = Array.isArray(pgExporter.args) ? pgExporter.args.map(String) : [];
  if (!args.includes('--collector.stat_statements')) bad(PG_EXPORTER, '쿼리 통계 수집기(--collector.stat_statements)가 켜져 있지 않다(observability §8)');
  if (args.includes('--no-collector.stat_statements')) bad(PG_EXPORTER, '쿼리 통계 수집기를 끈다(--no-collector.stat_statements)');
  if (args.some((a) => /include_query/.test(a))) bad(PG_EXPORTER, '쿼리 문장 싣기(include_query)를 켠다(observability §8: 쿼리 문장은 라벨에 싣지 않는다)');
  const limits = args.filter((a) => /^--collector\.stat_statements\.limit(=|$)/.test(a));
  if (limits.length !== 1 || limits[0] !== `--collector.stat_statements.limit=${canon.top}`) bad(PG_EXPORTER, `상위 한도가 ${DOC} §8의 ${canon.top}개가 아니다: ${limits.join(' ') || '없음'}`);
  if (args.some((a) => /:\/\/|DATA_SOURCE/.test(a))) bad(PG_EXPORTER, '인자에 접속 주소가 있다(환경 변수 DATA_SOURCE_NAME으로)');

  // --- YACE ---
  const jobs = Array.isArray(yace?.discovery?.jobs) ? yace.discovery.jobs : [];
  const names = (j) => (Array.isArray(j?.metrics) ? j.metrics : []).map((m) => m?.name);
  if (jobs.length !== 2) bad(YACE, `수집 작업이 둘이 아니다(${jobs.length}개, §8 지표 출처 표의 CloudFront 두 줄만)`);
  const quota = jobs.filter((j) => !(j?.searchTags?.length > 0));
  const edge = jobs.filter((j) => j?.searchTags?.length > 0);
  if (quota.length !== 1) bad(YACE, `모든 배포를 보는 한도 사용률 작업이 하나가 아니다(${quota.length}개)`);
  if (edge.length !== 1) bad(YACE, `태그로 배포를 고르는 엣지 실패 작업이 하나가 아니다(${edge.length}개)`);
  for (const j of jobs) {
    if (j?.type !== 'AWS/CloudFront') bad(YACE, `작업 종류 ${j?.type}가 AWS/CloudFront가 아니다`);
    if (!same(j?.regions, [canon.region])) bad(YACE, `지역 ${JSON.stringify(j?.regions)}가 ${canon.region} 하나가 아니다(CloudFront 지표는 그 지역에만 있다)`);
    for (const m of Array.isArray(j?.metrics) ? j.metrics : []) {
      const stat = /ErrorRate$/.test(m?.name) ? 'Average' : 'Sum';
      if (!same(m?.statistics, [stat]) || m?.period !== MINUTE) bad(YACE, `지표 ${m?.name}이 1분 ${stat === 'Sum' ? '합계' : '평균'}(statistics [${stat}], period ${MINUTE})가 아니다`);
    }
  }
  if (quota.length === 1) {
    if (!same(sorted(names(quota[0])), sorted(canon.quotaMetrics))) bad(YACE, `한도 사용률 작업의 지표 ${names(quota[0]).join(',')}가 §8의 ${canon.quotaMetrics.join(',')}와 다르다(조회 요금)`);
    if (quota[0].delay !== undefined && quota[0].delay !== 0) bad(YACE, `한도 사용률 작업에 delay ${quota[0].delay}가 있다`);
  }
  if (edge.length === 1) {
    const e = edge[0];
    if (!same(sorted(names(e)), sorted(canon.edgeMetrics))) bad(YACE, `엣지 실패 작업의 지표 ${names(e).join(',')}가 §8의 ${canon.edgeMetrics.join(',')}와 다르다(조회 요금)`);
    if (e.delay !== canon.edgeDelaySec) bad(YACE, `엣지 실패 작업의 delay ${e.delay}가 §8의 ${canon.edgeDelaySec}초와 다르다`);
    const tags = e.searchTags;
    const picked = tags.length === 1 ? /^\^\(([a-z|]+)\)\$$/.exec(String(tags[0]?.value ?? ''))?.[1]?.split('|') : undefined;
    if (!picked || !same(sorted(picked), sorted(canon.edgeDists)) || new Set(picked).size !== picked.length) bad(YACE, `엣지 실패 작업이 고르는 배포가 §8의 ${canon.edgeDists.join('·')} 둘이 아니다: ${JSON.stringify(tags)}`);
  }

  // --- Grafana 신호 연결 ---
  const datasources = [];
  for (const rel of [DATASOURCES, DATASOURCES_PLATFORM]) for (const ds of readYaml(root, rel).datasources ?? []) datasources.push({ ...ds, file: rel });
  const byUid = new Map(datasources.map((d) => [d.uid, d]));
  const tenantOf = (d) => {
    for (const [k, v] of Object.entries(d?.jsonData ?? {})) {
      const n = /^httpHeaderName(\d+)$/.exec(k)?.[1];
      if (n && v === TENANT_HEADER) return d?.secureJsonData?.[`httpHeaderValue${n}`];
    }
    return undefined;
  };
  /** from이 가리키는 uid가 있고 type이며 같은 조직인지. 맞으면 그 데이터 소스 */
  const points = (from, uid, type, what) => {
    const to = byUid.get(uid);
    if (!to) bad(from.file, `${from.uid}의 ${what}이 없는 데이터 소스 ${uid}를 가리킨다`);
    else if (to.type !== type) bad(from.file, `${from.uid}의 ${what}이 ${type}이 아닌 ${uid}(${to.type})를 가리킨다`);
    else if (to.orgId !== from.orgId) bad(from.file, `${from.uid}(조직 ${from.orgId})의 ${what}이 다른 조직 ${to.orgId}의 ${uid}를 가리킨다`);
    else return to;
    return undefined;
  };
  for (const [rel, uid] of [[DATASOURCES, 'prometheus'], [DATASOURCES_PLATFORM, 'mimir-raw']]) {
    const ds = datasources.find((d) => d.uid === uid && d.file === rel);
    if (!ds) {
      bad(rel, `데이터 소스 ${uid}가 없다(exemplar → Tempo 연결을 둘 곳)`);
      continue;
    }
    const dests = ds.jsonData?.exemplarTraceIdDestinations;
    if (!Array.isArray(dests) || dests.length !== 1) {
      bad(rel, `${uid}의 exemplarTraceIdDestinations가 하나가 아니다(exemplar ${canon.exemplarName} → Tempo, observability §2)`);
      continue;
    }
    if (dests[0]?.name !== canon.exemplarName) bad(rel, `${uid}의 exemplar 이름 ${dests[0]?.name}이 ${DOC} §2의 ${canon.exemplarName}과 다르다`);
    points(ds, dests[0]?.datasourceUid, DS_TYPES.tempo, 'exemplar 연결');
  }
  const tempos = datasources.filter((d) => d.type === DS_TYPES.tempo);
  if (tempos.length === 0) bad(DATASOURCES_PLATFORM, 'Tempo 데이터 소스가 없다');
  for (const t of tempos) {
    const j = t.jsonData ?? {};
    const map = j.serviceMap?.datasourceUid;
    if (!map) bad(t.file, `${t.uid}에 서비스 지도(serviceMap.datasourceUid)가 없다`);
    else {
      const to = points(t, map, DS_TYPES.prometheus, '서비스 지도');
      if (to && tenantOf(to) !== RAW_TENANT) bad(t.file, `${t.uid}의 서비스 지도가 Mimir ${RAW_TENANT}가 아닌 테넌트 ${tenantOf(to) ?? '없음'}의 ${map}를 가리킨다(서비스 그래프는 raw에만 쓴다)`);
    }
    if (j.nodeGraph?.enabled !== true) bad(t.file, `${t.uid}의 노드 그래프(nodeGraph.enabled)가 켜져 있지 않다`);
    const prof = j.tracesToProfiles?.datasourceUid;
    if (!prof) bad(t.file, `${t.uid}에 프로파일 연결(tracesToProfiles.datasourceUid)이 없다`);
    else points(t, prof, DS_TYPES.pyroscope, '프로파일 연결');
  }
  // Loki의 traceId 파생 필드 → Tempo, Tempo → Loki(같은 traceId). §1 'Grafana 신호 연결'·§2 '신호 연결', V-T50 ⑨
  const lokiDs = datasources.find((d) => d.uid === 'loki');
  if (!lokiDs) bad(DATASOURCES_PLATFORM, 'Loki 데이터 소스가 없다(traceId 파생 필드를 둘 곳)');
  else {
    const fields = lokiDs.jsonData?.derivedFields;
    if (!Array.isArray(fields) || fields.length !== 1) bad(lokiDs.file, `${lokiDs.uid}의 derivedFields가 하나가 아니다(traceId → Tempo, observability §1)`);
    else {
      const f = fields[0];
      if (f?.name !== canon.exemplarName) bad(lokiDs.file, `${lokiDs.uid}의 파생 필드 이름 ${f?.name ?? '없음'}이 ${DOC} §2의 ${canon.exemplarName}과 다르다`);
      if (typeof f?.matcherRegex !== 'string' || !f.matcherRegex.includes('traceId')) bad(lokiDs.file, `${lokiDs.uid}의 파생 필드 matcherRegex가 로그 줄의 traceId를 찾지 않는다`);
      points(lokiDs, f?.datasourceUid, DS_TYPES.tempo, 'traceId 파생 필드');
    }
  }
  for (const t of tempos) {
    const logs = t.jsonData?.tracesToLogsV2;
    if (!isMap(logs)) bad(t.file, `${t.uid}에 로그 연결(tracesToLogsV2)이 없다(같은 traceId의 로그를 Loki에서 찾는다, observability §1)`);
    else {
      if (logs.filterByTraceID !== true) bad(t.file, `${t.uid}의 tracesToLogsV2가 traceId로 거르지 않는다(filterByTraceID)`);
      points(t, logs.datasourceUid, DS_TYPES.loki, '로그 연결');
    }
  }
  // 그 밖의 연결(datasourceUid)도 있는 데이터 소스와 같은 조직을 가리킨다
  for (const d of datasources) {
    for (const uid of findKeys(d.jsonData ?? {}, 'datasourceUid')) {
      const to = byUid.get(uid);
      if (!to) bad(d.file, `${d.uid}의 연결이 없는 데이터 소스 ${uid}를 가리킨다`);
      else if (to.orgId !== d.orgId) bad(d.file, `${d.uid}(조직 ${d.orgId})의 연결이 다른 조직 ${to.orgId}의 ${uid}를 가리킨다`);
    }
  }
  return [...new Set(problems)];
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let mode;
  let store;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check' && !mode) mode = 'check';
    else if (a === '--render' && !mode && argv[i + 1]) {
      mode = 'render';
      store = argv[++i];
    } else if (a === '--root' && argv[i + 1]) root = resolve(argv[++i]);
    else {
      console.error(`observability-stores: 모르는 인자 ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (!mode) {
    console.error(USAGE);
    return 2;
  }
  try {
    if (mode === 'render') {
      if (!(store in LOCAL)) {
        console.error(`observability-stores: 로컬 판이 없는 이름 ${store}(loki·tempo만)\n${USAGE}`);
        return 2;
      }
      process.stdout.write(renderLocalConfig(root, store));
      return 0;
    }
    const problems = checkObservabilityStores(root);
    if (problems.length) {
      console.error(`observability-stores: 관측 저장소 설정 위반 ${problems.length}건`);
      for (const p of problems) console.error(`막음: ${p}`);
      return 1;
    }
    console.log('observability-stores: 통과(Mimir·Loki·Tempo 복제·보존·한도·라벨·쓰기 큐·처리기·원격 쓰기, 로컬 판, exporter 인자, Grafana 신호 연결)');
    return 0;
  } catch (e) {
    if (e instanceof ReadError) {
      console.error(`observability-stores: 읽지 못했다: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

// 끝 코드는 exitCode로 둔다(--render의 표준 출력이 관으로 갈 때 다 쓰기 전에 끝내지 않는다)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
