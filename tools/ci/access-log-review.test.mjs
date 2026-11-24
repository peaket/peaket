// F-01-8 구현 리뷰 IR-01~IR-13 재현 시험(2026-11-24).
// 실제 저장소의 설정 글·게이트웨이 접근 로그 형식·표 DDL·경보 식·identity 호출부·CLI를 읽어
// 리뷰가 지적한 결함이 다시 생기면 실패한다. 정본 값은 docs/observability.md §5·§7, docs/infra.md §4.1·§6,
// docs/data.md §1, docs/api/openapi.yaml·asyncapi.yaml에서 읽는다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const cfg = () => read('deploy/platform/observability/collector/access-log.yaml');
const gateways = () => read('deploy/gateways/00-common.yaml');
const alerts = () => read('deploy/platform/observability/alerts/access-log.yaml');
const ddl = () => read('data/clickhouse/access-log/001_access_log.sql');
const users = () => read('data/clickhouse/access-log/002_users.sql');
const identity = () => read('services/identity-svc/src/modules/session/legal-access-log.ts');
const createSession = () => read('services/identity-svc/src/modules/session/application/create-session.ts');
const adminLogin = () => read('services/identity-svc/src/modules/admin/application/login-password-step.ts');
const adminSecond = () => read('services/identity-svc/src/modules/admin/application/login-second-step.ts');
const adminReauth = () => read('services/identity-svc/src/modules/admin/application/reauthenticate-admin.ts');
const adminRefresh = () => read('services/identity-svc/src/modules/admin/application/refresh-admin-session.ts');
const adminEnd = () => read('services/identity-svc/src/modules/admin/application/end-admin-session.ts');
const openapi = () => read('docs/api/openapi.yaml');

test('IR-01 게이트웨이 접근 로그에 kind가 있고 수집기 법정 필터가 게이트웨이 줄을 버리지 않는다', () => {
  const g = gateways();
  assert.match(g, /kind:\s*"?envoy-access"?/, '게이트웨이 JSON에 kind: envoy-access가 없다');
  assert.match(g, /requestId:/, '게이트웨이 JSON에 requestId가 없다');
  assert.match(g, /userAgent:/, '게이트웨이 JSON에 userAgent가 없다');
  const c = cfg();
  // 법정 필터는 게이트웨이(kind=envoy-access)와 identity(kind=legal-access) 둘 다 남긴다
  assert.match(c, /filter\/legal-only:[\s\S]*?envoy-access[\s\S]*?legal-access/);
  assert.doesNotMatch(c, /attributes\["kind"\] != "envoy-access" and attributes\["kind"\] != "legal-access"/);
});

test('IR-02 수집기가 게이트웨이의 camelCase 칸을 법정 칸으로 옮긴다', () => {
  const c = cfg();
  for (const [from, to] of [
    ['time', 'ts'],
    ['clientIp', 'client_ip'],
    ['durationMs', 'duration_ms'],
    ['edgeBotLabels', 'edge_bot_labels'],
    ['requestId', 'request_id'],
    ['userAgent', 'user_agent'],
  ]) {
    assert.match(c, new RegExp(`attributes\\["${from}"\\]`), `수집기가 게이트웨이 칸 ${from}을 읽지 않는다`);
    assert.match(c, new RegExp(`attributes\\["${to}"\\]`), `수집기가 법정 칸 ${to}을 만들지 않는다`);
  }
  // 원문 IP·단말·요청 ID가 표에 닿게 지우지 않는다
  assert.doesNotMatch(c, /delete_key\(attributes, "client_ip"\)/);
  assert.doesNotMatch(c, /delete_key\(attributes, "user_agent"\)/);
  assert.doesNotMatch(c, /delete_key\(attributes, "request_id"\)/);
});

test('IR-03 kubelet 경로 글롭이 <namespace>_<pod>_<uid> 순서와 identity core 네임스페이스를 쓴다', () => {
  const c = cfg();
  assert.match(c, /\/var\/log\/pods\/envoy-gateway-system_\*_\*\/envoy\/\*\.log/);
  assert.match(c, /\/var\/log\/pods\/core_identity-svc-\*_\*\/identity-svc\/\*\.log/);
  assert.doesNotMatch(c, /\*_envoy-gateway-system_\*/);
  assert.doesNotMatch(c, /\*_identity_\*/);
});

test('IR-04 ClickHouse exporter의 고정 칸과 표·materialized view가 맞고 IP를 검증해 넣는다', () => {
  const c = cfg();
  assert.match(c, /logs_table_name:\s*access_log_otel/);
  assert.match(c, /create_schema:\s*false/);
  const d = ddl();
  // exporter 기본 로그 표의 고정 칸
  for (const col of ['Timestamp', 'TraceId', 'SpanId', 'TraceFlags', 'SeverityText', 'SeverityNumber', 'ServiceName', 'Body', 'ResourceAttributes', 'LogAttributes'])
    assert.match(d, new RegExp(`\\b${col}\\b`), `원천 표에 exporter 고정 칸 ${col}이 없다`);
  assert.match(d, /CREATE TABLE IF NOT EXISTS access_log\.access_log_otel/);
  assert.match(d, /CREATE TABLE IF NOT EXISTS access_log\.access_log\b/);
  assert.match(d, /CREATE MATERIALIZED VIEW IF NOT EXISTS access_log\.access_log_from_otel/);
  assert.match(d, /toIPv6OrNull\(LogAttributes\['client_ip'\]\)/);
  assert.match(d, /Nullable\(IPv6\)/);
  // 표 스키마가 exporter와 어긋난 채 block_on_overflow만 남지 않게, 표 이름이 원천 표를 가리킨다
  assert.doesNotMatch(c, /logs_table_name:\s*access_log\s*$/m);
});

test('IR-05 일반 로그 갈래가 게이트웨이 원문을 Loki로 보내지 않고 IP·조사 칸을 지운다', () => {
  const c = cfg();
  assert.match(c, /filter\/drop-envoy-access:[\s\S]*?clientIp/);
  assert.match(c, /filter\/drop-envoy-access:[\s\S]*?envoy-access/);
  // 일반 변환은 정규화된 client_ip를 쓰고, IPv6 여러 꼴을 /48로 바꾼다
  assert.match(c, /transform\/access-general:[\s\S]*?client_ip/);
  assert.match(c, /replace_pattern\(attributes\["client_ip"\][^\n]*\(\[0-9a-fA-F\]\{1,4\}:\)\{2\}/);
  assert.match(c, /::\/48/);
  // 원문 IP 필드(clientIp)를 지우기만 하고 Loki로 보내지 않는다
  assert.match(c, /delete_key\(attributes, "clientIp"\)/);
  // 본문(원래 JSON)에도 원문 IP·조사 칸이 남지 않게 본문을 비운다
  assert.match(c, /transform\/access-general:[\s\S]*?set\(body, ""\)/);
});

test('IR-06 조사 경로가 openapi의 실제 경로·메서드와 맞는다', () => {
  const c = cfg();
  const o = openapi();
  const paths = [
    '/v1/events/{eventId}/holds',
    '/v1/holds/{holdId}',
    '/v1/holds/{holdId}/extension',
    '/v1/events/{eventId}/seatmap-snapshot',
    '/v1/orders',
    '/v1/orders/{orderId}/payments',
    '/v1/orders/{orderId}/payment-acceptance',
    '/v1/tickets/{ticketId}/transfers',
    '/v1/tickets/{ticketId}/returns',
  ];
  for (const p of paths) assert.ok(o.includes(`  ${p}:`), `openapi에 ${p}가 없다`);
  for (const p of paths) {
    const piece = p.replace(/\{[^}]+\}/g, '[^/]+');
    assert.ok(c.includes(piece), `조사 경로 ${p}의 조각이 설정에 없다`);
  }
  assert.match(c, /"HOLD"\) where IsMatch\(attributes\["path"\], "\^\/v1\/events\/\[\^\/\]\+\/holds\$"\) and attributes\["method"\] == "POST"/);
  assert.match(c, /"HOLD_RELEASE"\) where IsMatch\(attributes\["path"\], "\^\/v1\/holds\/\[\^\/\]\+\$"\) and attributes\["method"\] == "DELETE"/);
  assert.match(c, /"SEATMAP_SNAPSHOT"\) where IsMatch\(attributes\["path"\], "\^\/v1\/events\/\[\^\/\]\+\/seatmap-snapshot\$"/);
  assert.match(c, /"PAYMENT_ATTEMPT"\) where IsMatch\(attributes\["path"\], "\^\/v1\/orders\/\[\^\/\]\+\/payments\$"/);
  assert.match(c, /"PAYMENT_ACCEPTANCE"\) where IsMatch\(attributes\["path"\], "\^\/v1\/orders\/\[\^\/\]\+\/payment-acceptance\$"/);
});

test('IR-07 Kafka 조사 사본이 body를 계약 칸 map으로 만들어 raw로 보낸다', () => {
  const c = cfg();
  assert.match(c, /set\(body, attributes\)/);
  assert.match(c, /keep_keys\(body, \[[^\]]*"ts"[^\]]*"requestId"[^\]]*"gateway"[^\]]*"routeKind"[^\]]*"status"[^\]]*"ip"[^\]]*\]\)/);
  assert.match(c, /logs:\n\s+topic: investigation\.requests\n\s+encoding: raw/);
});

test('IR-08 관리 계정 로그인·갱신·로그아웃이 is_admin=1 접속기록 줄을 남긴다', () => {
  assert.match(identity(), /is_admin/);
  for (const [name, text, needle] of [
    ['login-password-step', adminLogin(), 'recordLegalAccess'],
    ['login-second-step', adminSecond(), 'recordLegalAccess'],
    ['refresh-admin-session', adminRefresh(), 'recordLegalAccess'],
    ['end-admin-session', adminEnd(), 'recordLegalAccess'],
    ['reauthenticate-admin', adminReauth(), 'recordLegalAccess'],
  ]) {
    assert.match(text, new RegExp(needle), `${name}이 접속기록 줄을 쓰지 않는다`);
    assert.match(text, /isAdmin:\s*true/, `${name}이 is_admin=1을 표시하지 않는다`);
  }
  assert.match(ddl(), /is_admin UInt8/);
  assert.match(ddl(), /LogAttributes\['is_admin'\]/);
});

test('IR-09 법정 경보가 수집기의 exporter·receiver 라벨로 거른다', () => {
  const a = alerts();
  assert.doesNotMatch(a, /pipeline="/, 'pipeline 라벨은 수집기 지표에 없다');
  assert.match(a, /exporter="clickhouse\/access-log"/);
  assert.match(a, /exporter="kafka\/investigation"/);
  assert.match(a, /receiver="?filelog\/envoy-legal"?/);
  assert.match(a, /receiver="?filelog\/identity-legal"?/);
});

test('IR-10 사본 지연 경보가 전날 날짜와 06:00을 보고 지표 없음도 울린다', () => {
  const a = alerts();
  assert.match(a, /absent\(access_log_export_last_success_timestamp\)/);
  assert.match(a, /hour\(vector\(time\(\)\) \+ 9 \* 3600\)\s*>=\s*6/);
  assert.match(a, /year\(access_log_export_last_success_timestamp \+ 9 \* 3600\)/);
  assert.match(a, /month\(access_log_export_last_success_timestamp \+ 9 \* 3600\)/);
  assert.match(a, /day_of_month\(access_log_export_last_success_timestamp \+ 9 \* 3600\)/);
  assert.doesNotMatch(a, /time\(\)\s*-\s*access_log_export_last_success_timestamp\s*>\s*6\s*\*\s*3600/);
});

test('IR-11 사용자 비밀번호가 고정 값이 아니고 IPv6 /48 마스킹이 여러 꼴을 잡는다', () => {
  const u = users();
  assert.doesNotMatch(u, /change-me-in-inf-020/);
  assert.match(u, /\$\{PEAKET_AL_[A-Z_]+_PASSWORD\}/);
  const c = cfg();
  assert.match(c, /\^\(\[0-9a-fA-F\]\{1,4\}:\[0-9a-fA-F\]\{1,4\}\)::\.\*\$/);
  assert.match(c, /\^\(\[0-9a-fA-F\]\{1,4\}\)::\.\*\$/);
});

test('IR-12 대조 실행기가 원천 0을 통과로 세지 않고 중복 seq를 경보로 세지 않는다', () => {
  const cli = join(ROOT, 'tools/local/access-log-jobs.mjs');
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  // 원천 0(확인 불가)은 실패다
  const zero = run(['--reconcile', '--ingress', '0', '--rows', '0']);
  assert.equal(zero.status, 1, `원천 0의 끝 코드가 ${zero.status}다: ${zero.stdout}${zero.stderr}`);
  // 중복 seq는 정상 재전송이라 경보로 세지 않는다
  const dup = run(['--reconcile', '--ingress', '100', '--rows', '100', '--seq', '1,2,2,3']);
  assert.equal(dup.status, 0, `중복 seq의 끝 코드가 ${dup.status}다: ${dup.stdout}${dup.stderr}`);
  // 빠진 seq는 실패다
  const gap = run(['--reconcile', '--ingress', '100', '--rows', '100', '--seq', '1,3']);
  assert.equal(gap.status, 1);
  // ClickHouse·Envoy를 읽는 길이 있어야 V-T21·V-T23을 끝까지 돌린다
  const src = read('tools/local/access-log-jobs.mjs');
  assert.match(src, /--clickhouse/);
  assert.match(src, /--envoy/);
  assert.match(src, /fetch\(/);
});

test('IR-13 identity 줄이 재인증·로그아웃·갱신에 IP·단말을 싣고 seq를 파일에 이어 쓴다', () => {
  for (const [name, text] of [
    ['reauthenticate-admin', adminReauth()],
    ['end-admin-session', adminEnd()],
    ['refresh-admin-session', adminRefresh()],
  ]) {
    assert.match(text, /clientIp/, `${name}이 client_ip를 넘기지 않는다`);
    assert.match(text, /userAgent/, `${name}이 user_agent를 넘기지 않는다`);
  }
  const c = createSession();
  assert.doesNotMatch(c, /requestId:\s*r\.sessionId/, '로그인 request_id가 세션 ID다');
  assert.match(c, /requestId:\s*i\.requestId/);
  assert.match(identity(), /statePath|PEAKET_LEGAL_ACCESS_SEQ_FILE/);
  assert.match(identity(), /readFileSync|existsSync/);
});
