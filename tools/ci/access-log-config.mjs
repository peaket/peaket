#!/usr/bin/env node
// F-01-8 법정 접속기록 갈래·access_log 표·권한·하루 사본·조사 사본 정적 검사(BUILD_ORDER OPS-070).
// 쓰는 법: node tools/ci/access-log-config.mjs [--root <저장소>]
//   --root   저장소 뿌리(기본은 이 파일이 있는 곳의 두 단계 위)
// 끝 코드: 0 통과, 1 위반(모두 '막음: <저장소 기준 경로>: <까닭>'), 2 인자 오류·읽을 파일 없음·정본 값 없음
// 정본 값은 docs/observability.md §5·§7, docs/infra.md §6, docs/data.md §1, docs/api/asyncapi.yaml에서 읽는다.
// 수집기 파일은 tools/ci/collector-config.mjs가 보는 agent.yaml과 따로 access-log.yaml에 있다(겹쳐 읽는다).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDocument } from 'yaml';
import { runIfMain } from './entry.mjs';

const USAGE = '쓰는 법: node tools/ci/access-log-config.mjs [--root <저장소>]';
const HERE = dirname(fileURLToPath(import.meta.url));

const FILES = {
  agent: 'deploy/platform/observability/collector/agent.yaml',
  cfg: 'deploy/platform/observability/collector/access-log.yaml',
  local: 'deploy/platform/observability/collector/local/access-log.yaml',
  jobs: 'deploy/platform/observability/access-log/jobs.yaml',
  alerts: 'deploy/platform/observability/alerts/access-log.yaml',
  ddl: 'data/clickhouse/access-log/001_access_log.sql',
  users: 'data/clickhouse/access-log/002_users.sql',
  readme: 'data/clickhouse/access-log/README.md',
  identity: 'services/identity-svc/src/modules/session/legal-access-log.ts',
  analytics: 'services/analytics-ingest/src/worker.ts',
  obs: 'docs/observability.md',
  data: 'docs/data.md',
  infra: 'docs/infra.md',
  asyncapi: 'docs/api/asyncapi.yaml',
};

export class ReadError extends Error {}

const lf = (s) => s.replace(/\r\n/g, '\n');
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readText(root, rel) {
  const file = join(root, rel);
  if (!existsSync(file)) throw new ReadError(`${rel}이 없다`);
  return lf(readFileSync(file, 'utf8'));
}

function parseYaml(text, rel) {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ReadError(`${rel}: YAML을 읽지 못했다: ${doc.errors[0].message.split('\n')[0]}`);
  const v = doc.toJS();
  return isObj(v) ? v : {};
}

function lineWith(text, needle, what) {
  const line = text.split('\n').find((l) => l.includes(needle));
  if (!line) throw new ReadError(`${what}에서 "${needle}"이 든 줄을 찾지 못했다`);
  return line;
}

const getIn = (o, path) => path.reduce((x, k) => (x == null ? undefined : x[k]), o);
const cronOf = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new ReadError(`시각이 HH:MM 꼴이 아니다: ${hhmm}`);
  return `${Number(m[2])} ${Number(m[1])} * * *`;
};

/** 정본에서 읽는 값(문서 값을 코드에 옮겨 적지 않는다) */
export function canonFrom(root) {
  const obs = readText(root, FILES.obs);
  const data = readText(root, FILES.data);
  const infra = readText(root, FILES.infra);
  const asyncapi = readText(root, FILES.asyncapi);

  const num = (re, text, what) => {
    const m = re.exec(text);
    if (!m) throw new ReadError(`${what}에서 값을 찾지 못했다`);
    return m;
  };
  const m = num(/모자란 비율이 ([\d.]+)%를 넘으면/, obs, `${FILES.obs} §7 ④`);
  const w = num(/대조 잡이 (\d+)분마다 (\d+)분 전의 (\d+)분 칸을 본다/, obs, `${FILES.obs} §7 ④`);
  const a = num(/다음 날 (\d{2}:\d{2})에는/, obs, `${FILES.obs} §7 ④`);
  const copyLine = lineWith(infra, 'access-log-export', `${FILES.infra} §6 접속기록 DB`);
  const c = num(/매일 (\d{2}:\d{2}) \[가정\]/, copyLine, `${FILES.infra} §6 하루 사본`);
  const r = num(/3개월 보존이 끝난 뒤 (\d+)일 \[가정\]/, copyLine, `${FILES.infra} §6 하루 사본 보존`);
  const missLine = lineWith(obs, 'access_log_export_last_success_timestamp', `${FILES.obs} §5 법정 신호`);
  const miss = num(/(\d{2}:\d{2})까지 없다/, missLine, `${FILES.obs} §5 하루 사본 지연`);
  const ttl = num(/최소 (\d+)개월 보존/, data, `${FILES.data} §1 시스템 접속기록`);
  const kinds = num(/routeKind: \{ type: string, enum: \[([^\]]+)\]/, asyncapi, `${FILES.asyncapi} InvestigationRequest.routeKind`);  for (const n of ['access_log_shortfall_ratio', 'access_log_seq_gaps_total']) if (!obs.includes(n)) throw new ReadError(`${FILES.obs}에서 ${n}을 찾지 못했다`);
  if (!copyLine.includes('Parquet')) throw new ReadError(`${FILES.infra} §6에서 하루 사본 Parquet을 찾지 못했다`);
  if (!copyLine.includes('S3 Object Lock 준수 모드')) throw new ReadError(`${FILES.infra} §6에서 Object Lock 준수 모드를 찾지 못했다`);

  return {
    shortfallThreshold: Number(m[1]) / 100,
    windowPeriodMinutes: Number(w[1]),
    windowOffsetMinutes: Number(w[2]),
    windowMinutes: Number(w[3]),
    anchorCron: cronOf(a[1]),
    copyCron: cronOf(c[1]),
    missingBy: miss[1],
    retention: `P${ttl[1]}M${r[1]}D`,
    retentionMonths: Number(ttl[1]),
    retentionExtraDays: Number(r[1]),
    routeKinds: kinds[1].split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter((x) => /^[A-Z_]+$/.test(x)),
  };
}

/** 위반 목록(빈 배열이면 통과). 읽기 실패는 ReadError로 던진다 */
export function checkAccessLogConfig(root) {
  const canon = canonFrom(root);
  const cfgText = readText(root, FILES.cfg);
  const cfg = parseYaml(cfgText, FILES.cfg);
  readText(root, FILES.local); // 로컬 판이 있어야 Docker로 띄워 본다
  const agent = parseYaml(readText(root, FILES.agent), FILES.agent);
  const jobs = parseYaml(readText(root, FILES.jobs), FILES.jobs);
  const alerts = parseYaml(readText(root, FILES.alerts), FILES.alerts);
  const ddl = readText(root, FILES.ddl);
  const users = readText(root, FILES.users);
  readText(root, FILES.readme);
  const identity = readText(root, FILES.identity);
  const analytics = readText(root, FILES.analytics);

  const out = [];
  const bad = (rel, why) => out.push(`${rel}: ${why}`);

  const recv = cfg.receivers ?? {};
  const exp = cfg.exporters ?? {};
  const ext = cfg.extensions ?? {};
  const pipe = cfg.service?.pipelines ?? {};

  // --- 수신기: 법정 둘·조사 하나·일반 하나, 읽은 위치를 따로 ---
  const needReceiver = (name, storage) => {
    const r = recv[name];
    if (!isObj(r)) return bad(FILES.cfg, `수신기 ${name}이 없다`);
    if (r.storage !== storage) bad(FILES.cfg, `수신기 ${name}의 storage가 ${storage}가 아니다(${r.storage ?? '없음'})`);
    if (r.start_at !== 'beginning') bad(FILES.cfg, `수신기 ${name}의 start_at이 beginning이 아니다(${r.start_at ?? '없음'})`);
    if (r.compression !== 'auto') bad(FILES.cfg, `수신기 ${name}의 compression이 auto가 아니다(회전 파일을 읽는다, ${r.compression ?? '없음'})`);
    if (!Array.isArray(r.include) || r.include.length === 0) bad(FILES.cfg, `수신기 ${name}의 include가 비었다`);
  };
  needReceiver('filelog/envoy-legal', 'file_storage/access-legal');
  needReceiver('filelog/identity-legal', 'file_storage/access-legal-identity');
  needReceiver('filelog/envoy-investigation', 'file_storage/access-investigation');
  needReceiver('filelog/envoy-general', 'file_storage/access-general');
  // 읽은 위치·큐 디렉터리는 서로 달라야 한다(한 갈래가 막혀도 다른 갈래의 읽기가 멈추지 않는다)
  const dirs = ['file_storage/access-legal', 'file_storage/access-legal-identity', 'file_storage/access-investigation', 'file_storage/access-general'].map((n) => ext[n]?.directory);
  if (dirs.some((d) => typeof d !== 'string' || d === '')) bad(FILES.cfg, `file_storage 확장 넷과 directory가 필요하다(${JSON.stringify(dirs)})`);
  else if (new Set(dirs).size !== dirs.length) bad(FILES.cfg, '법정·조사·일반 file_storage의 directory가 서로 같다(갈래마다 따로 둔다)');

  // --- 법정 ClickHouse 내보내기: 잃지 않는 갈래 ---
  const ch = exp['clickhouse/access-log'];
  if (!isObj(ch)) bad(FILES.cfg, '내보내기 clickhouse/access-log가 없다');
  else {
    if (ch.database !== 'access_log' || ch.logs_table_name !== 'access_log_otel') bad(FILES.cfg, `법정 접속기록은 access_log 데이터베이스의 exporter 원천 표 access_log_otel로 보낸다(${ch.database ?? '없음'}.${ch.logs_table_name ?? '없음'})`);
    if (ch.sending_queue?.storage !== 'file_storage/access-legal') bad(FILES.cfg, 'clickhouse/access-log의 sending_queue.storage가 file_storage/access-legal가 아니다(디스크 큐)');
    if (ch.sending_queue?.block_on_overflow !== true) bad(FILES.cfg, 'clickhouse/access-log의 block_on_overflow가 true가 아니다(큐가 차면 버리지 않고 읽기를 멈춘다)');
    if (ch.retry_on_failure?.max_elapsed_time !== 0) bad(FILES.cfg, `clickhouse/access-log의 retry_on_failure.max_elapsed_time이 0이 아니다(${ch.retry_on_failure?.max_elapsed_time ?? '없음'})`);
  }

  // --- 조사 Kafka 내보내기: 버려도 법정 갈래를 막지 않는다 ---
  const kafka = exp['kafka/investigation'];
  if (!isObj(kafka)) bad(FILES.cfg, '내보내기 kafka/investigation이 없다');
  else {
    if (kafka.logs?.topic !== 'investigation.requests') bad(FILES.cfg, `kafka/investigation의 logs.topic이 investigation.requests가 아니다(${kafka.logs?.topic ?? '없음'})`);
    if (kafka.logs?.encoding !== 'raw') bad(FILES.cfg, `kafka/investigation의 logs.encoding이 raw가 아니다(로그 본문을 JSON으로 보낸다, ${kafka.logs?.encoding ?? '없음'})`);
    if (kafka.producer?.compression !== 'zstd') bad(FILES.cfg, `kafka/investigation의 producer.compression이 zstd가 아니다(${kafka.producer?.compression ?? '없음'})`);
    if (kafka.sending_queue?.storage !== 'file_storage/access-investigation') bad(FILES.cfg, 'kafka/investigation의 sending_queue.storage가 file_storage/access-investigation이 아니다');
    if (kafka.sending_queue?.block_on_overflow !== false) bad(FILES.cfg, 'kafka/investigation의 block_on_overflow가 false가 아니다(큐가 차면 새 줄을 버린다)');
    if (kafka.retry_on_failure?.max_elapsed_time !== '10m') bad(FILES.cfg, `kafka/investigation의 retry_on_failure.max_elapsed_time이 10m이 아니다(${kafka.retry_on_failure?.max_elapsed_time ?? '없음'})`);
  }

  // --- 파이프라인 ---
  const legal = pipe['logs/legal'];
  if (!isObj(legal)) bad(FILES.cfg, '파이프라인 logs/legal이 없다');
  else {
    const rs = legal.receivers ?? [];
    if (!rs.includes('filelog/envoy-legal') || !rs.includes('filelog/identity-legal')) bad(FILES.cfg, 'logs/legal은 게이트웨이·identity 법정 수신기를 모두 받는다');
    const pr = legal.processors ?? [];
    if (pr[0] !== 'memory_limiter') bad(FILES.cfg, `logs/legal의 처리기 첫째가 memory_limiter가 아니다(${pr[0] ?? '없음'})`);
    if (!pr.includes('filter/legal-only')) bad(FILES.cfg, 'logs/legal에 filter/legal-only가 없다');
    if (!pr.includes('transform/strip-investigation')) bad(FILES.cfg, 'logs/legal에 transform/strip-investigation이 없다');
    if (pr.some((p) => String(p).includes('sampler') || String(p).includes('tail_sampling'))) bad(FILES.cfg, `법정 갈래에는 표본 처리기를 두지 않는다(${pr.join(', ')})`);
    if (!isObj(legal.exporters) && legal.exporters?.length !== 1) bad(FILES.cfg, 'logs/legal의 내보내기는 clickhouse/access-log 하나다');
    if (JSON.stringify(legal.exporters) !== JSON.stringify(['clickhouse/access-log'])) bad(FILES.cfg, `logs/legal의 내보내기는 clickhouse/access-log 하나다(${JSON.stringify(legal.exporters)})`);
  }
  const inv = pipe['logs/investigation'];
  if (!isObj(inv)) bad(FILES.cfg, '파이프라인 logs/investigation이 없다');
  else {
    if (JSON.stringify(inv.receivers) !== JSON.stringify(['filelog/envoy-investigation'])) bad(FILES.cfg, `logs/investigation의 수신기는 filelog/envoy-investigation 하나다(${JSON.stringify(inv.receivers)})`);
    const pr = inv.processors ?? [];
    if (pr[0] !== 'memory_limiter') bad(FILES.cfg, `logs/investigation의 처리기 첫째가 memory_limiter가 아니다(${pr[0] ?? '없음'})`);
    if (!pr.includes('filter/investigation-routes')) bad(FILES.cfg, 'logs/investigation에 filter/investigation-routes가 없다');
    if (!pr.includes('transform/investigation')) bad(FILES.cfg, 'logs/investigation에 transform/investigation이 없다');
    if (JSON.stringify(inv.exporters) !== JSON.stringify(['kafka/investigation'])) bad(FILES.cfg, `logs/investigation의 내보내기는 kafka/investigation 하나다(${JSON.stringify(inv.exporters)})`);
  }
  const general = pipe['logs/access-general'];
  if (!isObj(general)) bad(FILES.cfg, '파이프라인 logs/access-general이 없다');
  else {
    if (!(general.processors ?? []).includes('transform/access-general')) bad(FILES.cfg, 'logs/access-general에 transform/access-general이 없다');
    if (JSON.stringify(general.exporters) !== JSON.stringify(['routing/access-general'])) bad(FILES.cfg, `logs/access-general의 내보내기는 routing/access-general이다(${JSON.stringify(general.exporters)})`);
    const sampled = pipe['logs/access-general-sampled'];
    if (!isObj(sampled) || !(sampled.processors ?? []).includes('probabilistic_sampler')) bad(FILES.cfg, 'logs/access-general-sampled에 표본 처리기(probabilistic_sampler)가 없다');
    const all = pipe['logs/access-general-all'];
    if (!isObj(all) || !(all.processors ?? []).includes('batch')) bad(FILES.cfg, 'logs/access-general-all(5xx 전수) 파이프라인이 없다');
    const routing = cfg.connectors?.['routing/access-general'];
    const cond = routing?.table?.[0]?.condition;
    if (typeof cond !== 'string' || !/attributes\["status"\]\s*>=\s*500/.test(cond)) bad(FILES.cfg, 'routing/access-general이 5xx를 전수 파이프라인으로 보내지 않는다');
  }
  // 일반 컨테이너 로그 갈래에서 법정 줄·접근 로그 줄을 뺀다(두 번 보내지 않는다)
  const plain = pipe.logs;
  if (!isObj(plain)) bad(FILES.cfg, 'agent.yaml의 logs 파이프라인을 겹쳐 읽은 결과가 없다');
  else {
    for (const f of ['filter/drop-legal', 'filter/drop-envoy-access']) if (!(plain.processors ?? []).includes(f)) bad(FILES.cfg, `일반 로그 파이프라인에 ${f}가 없다`);
    if (!(plain.processors ?? []).includes('k8s_attributes')) bad(FILES.cfg, '일반 로그 파이프라인의 쿠버네티스 메타데이터(k8s_attributes)를 잃었다');
  }
  if (!JSON.stringify(cfg.processors?.['filter/drop-legal'] ?? {}).includes('legal-access')) bad(FILES.cfg, 'filter/drop-legal이 본문의 legal-access 줄을 거르지 않는다(일반 Loki 갈래로 새지 않게)');
  if (!JSON.stringify(cfg.processors?.['filter/drop-envoy-access'] ?? {}).includes('envoy-access')) bad(FILES.cfg, 'filter/drop-envoy-access가 본문의 envoy-access 줄을 거르지 않는다(두 갈래로 두 번 가지 않게)');

  // --- 처리기 문장: 조사 칸 지우기·조사 경로·routeKind ---
  const statements = (name) => ((cfg.processors ?? {})[name]?.log_statements ?? []).flatMap((s) => s?.statements ?? []).map(String);
  const strip = statements('transform/strip-investigation');
  for (const k of ['ja4', 'asn', 'edge_bot_labels', 'sub', 'pid', 'jny'])
    if (!strip.some((s) => s.includes(`delete_key(attributes, "${k}")`))) bad(FILES.cfg, `transform/strip-investigation이 조사 칸 ${k}을 지우지 않는다`);
  const generalStatements = statements('transform/access-general');
  if (!generalStatements.some((s) => s.includes('replace_pattern(attributes["client_ip"]') && s.includes('0/24'))) bad(FILES.cfg, 'transform/access-general이 IPv4를 앞부분(/24)으로 바꾸지 않는다');
  if (!generalStatements.some((s) => s.includes('replace_pattern(attributes["client_ip"]') && s.includes('/48'))) bad(FILES.cfg, 'transform/access-general이 IPv6를 앞부분(/48)으로 바꾸지 않는다');
  const filterText = JSON.stringify(cfg.processors?.['filter/investigation-routes'] ?? {});
  if (!filterText.includes('status') || !filterText.includes('files')) bad(FILES.cfg, 'filter/investigation-routes가 상태 조회(status)·결과 파일(files)을 거르지 않는다');
  const invStatements = statements('transform/investigation');
  if (!invStatements.some((s) => s.includes('set(attributes["gateway"], "GW_QUEUE")'))) bad(FILES.cfg, 'transform/investigation이 gateway를 정하지 않는다');
  for (const kind of canon.routeKinds)
    if (!invStatements.some((s) => s.includes(`set(attributes["routeKind"], "${kind}")`))) bad(FILES.cfg, `transform/investigation에 routeKind ${kind} 경로가 없다(asyncapi InvestigationRequest.routeKind)`);
  if (!cfgText.includes('status >= 400')) bad(FILES.cfg, '법정 사본은 401·403 같은 status >= 400 줄도 남긴다(16.3.3)');

  // --- identity 접속기록 줄 계약 ---
  if (!identity.includes("kind: 'legal-access'")) bad(FILES.identity, "kind: 'legal-access' 줄이 없다");
  for (const k of ['event', 'result', 'provider', 'factors', 'failure', 'client_ip', 'user_agent', 'request_id', 'account_id', 'pod', 'ts']) if (!identity.includes(k)) bad(FILES.identity, `접속기록 줄에 ${k} 칸이 없다`);
  if (!identity.includes('seq:')) bad(FILES.identity, '파드마다 늘어나기만 하는 seq를 싣지 않는다');
  if (!identity.includes('factors: [...input.factors]')) bad(FILES.identity, 'factors를 입력에서 그대로 싣지 않는다');
  for (const secret of ["'token'", "'authorization'", "'cookie'"]) if (identity.includes(secret)) bad(FILES.identity, `접속기록 줄에 비밀 값 ${secret}을 싣지 않는다`);

  // --- 표·TTL·색인 ---
  if (!/CREATE TABLE IF NOT EXISTS access_log\.access_log/i.test(ddl)) bad(FILES.ddl, '표 access_log.access_log를 만들지 않는다');
  if (!/CREATE TABLE IF NOT EXISTS access_log\.access_log_otel/i.test(ddl)) bad(FILES.ddl, 'exporter 원천 표 access_log_otel을 만들지 않는다');
  if (!/CREATE MATERIALIZED VIEW IF NOT EXISTS access_log\.access_log_from_otel/i.test(ddl)) bad(FILES.ddl, '원천 표를 계약 표로 옮기는 materialized view가 없다');
  if (!/toIPv6OrNull\(LogAttributes\['client_ip'\]\)/.test(ddl)) bad(FILES.ddl, '원문 IP를 검증해 넣지 않는다(toIPv6OrNull)');
  if (!/ENGINE = ReplicatedMergeTree\('\/clickhouse\/tables\/\{shard\}\/access_log'/i.test(ddl)) bad(FILES.ddl, '계약 표 엔진이 ReplicatedMergeTree가 아니다(복제 2)');
  if (!/PARTITION BY toYYYYMMDD\(ts\)/.test(ddl)) bad(FILES.ddl, '하루 파티션(PARTITION BY toYYYYMMDD(ts))이 아니다(일 해시 앵커·3개월 보존)');
  if (!/ORDER BY ts/.test(ddl)) bad(FILES.ddl, 'ORDER BY가 ts가 아니다');
  if (!/client_ip TYPE bloom_filter/.test(ddl)) bad(FILES.ddl, '원문 IP 조회용 bloom_filter 색인이 없다');
  const ttl = /TTL toDateTime\(ts\) \+ INTERVAL (\d+) MONTH/.exec(ddl);
  if (!ttl) bad(FILES.ddl, 'TTL이 3개월 이상이 아니다(최소 보존을 줄이지 않는다)');
  else if (Number(ttl[1]) < canon.retentionMonths) bad(FILES.ddl, `TTL ${ttl[1]}개월이 최소 보존 ${canon.retentionMonths}개월보다 짧다`);

  // --- 사용자·권한 ---
  if (!/GRANT INSERT ON access_log\.access_log_otel TO al_ingest;/.test(users)) bad(FILES.users, 'al_ingest에 원천 표 access_log_otel INSERT를 주지 않는다');
  const ingestGrants = users.split('\n').filter((l) => /^\s*GRANT .* TO al_ingest;/i.test(l));
  if (ingestGrants.length !== 1) bad(FILES.users, `al_ingest는 INSERT 하나만 받는다(${ingestGrants.join(' / ')})`);
  if (!/GRANT SELECT ON access_log\.access_log TO al_admin_reader;/.test(users)) bad(FILES.users, 'al_admin_reader에 SELECT를 주지 않는다');
  if (!/CREATE ROW POLICY IF NOT EXISTS admin_rows_only ON access_log\.access_log FOR SELECT USING is_admin = 1 TO al_admin_reader;/.test(users)) bad(FILES.users, 'al_admin_reader의 행 정책(admin_rows_only, is_admin = 1)이 없다');
  if (!/GRANT SELECT ON access_log\.access_log TO al_investigation;/.test(users)) bad(FILES.users, 'al_investigation에 SELECT를 주지 않는다');
  if (!/TO al_migrator;/.test(users)) bad(FILES.users, '마이그레이션 역할 al_migrator의 권한이 없다');

  // --- 작업 설정: 정본 값과 같다 ---
  const rc = jobs.reconcile ?? {};
  if (rc.schedule !== `*/${canon.windowPeriodMinutes} * * * *`) bad(FILES.jobs, `reconcile.schedule이 ${canon.windowPeriodMinutes}분 주기가 아니다(window, ${rc.schedule ?? '없음'})`);
  if (rc.windowOffsetMinutes !== canon.windowOffsetMinutes) bad(FILES.jobs, `reconcile.windowOffsetMinutes가 ${canon.windowOffsetMinutes}이 아니다(window, ${rc.windowOffsetMinutes ?? '없음'})`);
  if (rc.windowMinutes !== canon.windowMinutes) bad(FILES.jobs, `reconcile.windowMinutes가 ${canon.windowMinutes}이 아니다(window, ${rc.windowMinutes ?? '없음'})`);
  if (rc.shortfallThreshold !== canon.shortfallThreshold) bad(FILES.jobs, `reconcile.shortfallThreshold가 ${canon.shortfallThreshold}이 아니다(shortfallThreshold, ${rc.shortfallThreshold ?? '없음'})`);
  if (rc.shortfallMetric !== 'access_log_shortfall_ratio') bad(FILES.jobs, 'reconcile.shortfallMetric이 access_log_shortfall_ratio가 아니다');
  if (rc.seqGapMetric !== 'access_log_seq_gaps_total') bad(FILES.jobs, 'reconcile.seqGapMetric이 access_log_seq_gaps_total이 아니다');
  if (jobs.anchor?.schedule !== canon.anchorCron) bad(FILES.jobs, `anchor.schedule이 ${canon.anchorCron}이 아니다(anchor, ${jobs.anchor?.schedule ?? '없음'})`);
  const cp = jobs.copy ?? {};
  if (cp.schedule !== canon.copyCron) bad(FILES.jobs, `copy.schedule이 ${canon.copyCron}이 아니다(copy, ${cp.schedule ?? '없음'})`);
  if (cp.format !== 'Parquet') bad(FILES.jobs, `copy.format이 Parquet이 아니다(${cp.format ?? '없음'})`);
  if (cp.objectLock !== 'COMPLIANCE') bad(FILES.jobs, `copy.objectLock이 COMPLIANCE가 아니다(${cp.objectLock ?? '없음'})`);
  if (cp.retention !== canon.retention) bad(FILES.jobs, `copy.retention이 ${canon.retention}이 아니다(retention, ${cp.retention ?? '없음'})`);
  if (cp.missingBy !== canon.missingBy) bad(FILES.jobs, `copy.missingBy가 ${canon.missingBy}이 아니다(missingBy, ${cp.missingBy ?? '없음'})`);
  if (cp.lastSuccessMetric !== 'access_log_export_last_success_timestamp') bad(FILES.jobs, 'copy.lastSuccessMetric이 access_log_export_last_success_timestamp가 아니다');
  if (!cp.writeRole || cp.writeRole === cp.restoreRole) bad(FILES.jobs, '사본 버킷 쓰기·복원 역할을 나누지 않는다');

  // --- 경보 규칙: 법정 신호 다섯과 조사 버림 ---
  const rules = (alerts.spec?.groups ?? []).flatMap((g) => g?.rules ?? []);
  const byAlert = new Map(rules.filter((r) => r?.alert).map((r) => [r.alert, r]));
  for (const name of ['AccessLogIngestFailures', 'AccessLogQueueHigh', 'AccessLogShortfall', 'AccessLogSeqGaps', 'AccessLogDailyCopyLate']) {
    const r = byAlert.get(name);
    if (!r) bad(FILES.alerts, `경보 ${name}이 없다`);
    else {
      if (r.labels?.severity !== 'sev2') bad(FILES.alerts, `경보 ${name}의 severity가 sev2가 아니다`);
      if (r.labels?.kind !== 'legal') bad(FILES.alerts, `경보 ${name}의 kind가 legal이 아니다`);
      for (const k of ['summary', 'runbook_url', 'dashboard_url']) if (!r.annotations?.[k]) bad(FILES.alerts, `경보 ${name}에 ${k} 주석이 없다`);
    }
  }
  const expressions = rules.map((r) => String(r?.expr ?? '')).join('\n');
  for (const metric of ['otelcol_exporter_enqueue_failed_log_records', 'otelcol_receiver_refused_log_records', 'otelcol_exporter_queue_size', 'otelcol_exporter_send_failed_log_records', 'access_log_shortfall_ratio', 'access_log_seq_gaps_total', 'access_log_export_last_success_timestamp', 'inv_copy_dropped_total'])
    if (!expressions.includes(metric)) bad(FILES.alerts, `법정 신호 지표 ${metric}을 쓰는 규칙이 없다`);
  const invDrop = byAlert.get('InvCopyDropped');
  if (!invDrop) bad(FILES.alerts, '경보 InvCopyDropped가 없다');
  else if (invDrop.labels?.severity !== 'sev3' || invDrop.labels?.kind !== 'hygiene') bad(FILES.alerts, 'InvCopyDropped는 SEV3 kind hygiene이다');

  // --- 분석 적재는 조사 토픽을 읽지 않는다(Q-T61 ④) ---
  const never = /export const NEVER_TOPICS = \[([^\]]*)\] as const;/.exec(analytics);
  if (!never || !never[1].includes("'investigation.requests'")) bad(FILES.analytics, 'NEVER_TOPICS에 investigation.requests가 없다(분석 적재가 읽지 않는다)');
  const telemetry = /export const TELEMETRY_TOPICS = \[([^\]]*)\] as const;/.exec(analytics);
  const trade = /export const TRADE_TOPICS = \[([^\]]*)\] as const;/.exec(analytics);
  for (const [name, m] of [['TELEMETRY_TOPICS', telemetry], ['TRADE_TOPICS', trade]]) {
    if (!m) bad(FILES.analytics, `${name}를 찾지 못했다`);
    else if (m[1].includes('investigation.requests')) bad(FILES.analytics, `${name}가 investigation.requests를 읽는다`);
  }

  // --- agent.yaml과의 겹침: 일반 로그 파이프라인이 있어야 한다 ---
  if (!isObj(agent.service?.pipelines?.logs)) bad(FILES.agent, 'agent.yaml의 logs 파이프라인이 없다');

  return out.sort(byText).map((s) => s.replace(/^([^:]+): /, '$1: '));
}

/** 저장소 기준 상대 경로 → 위반 글. 하나도 없으면 빈 배열 */
export function formatViolations(list) {
  return list.map((v) => `막음: ${v}`);
}

function main(argv) {
  let args;
  try {
    args = parseArgs({ args: argv, options: { root: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false, strict: true });
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (args.values.help) {
    console.log(USAGE);
    return 0;
  }
  const root = resolve(args.values.root ?? join(HERE, '..', '..'));
  if (!existsSync(root)) {
    console.error(`저장소가 없다: ${root}`);
    return 2;
  }
  let violations;
  try {
    violations = checkAccessLogConfig(root);
  } catch (err) {
    if (err instanceof ReadError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  if (violations.length === 0) {
    console.log('통과: 법정 접속기록 갈래·표·권한·하루 사본·조사 사본이 계약을 지킨다');
    return 0;
  }
  for (const v of violations) console.log(`막음: ${v}`);
  return 1;
}

runIfMain(import.meta.url, () => main(process.argv.slice(2)));
