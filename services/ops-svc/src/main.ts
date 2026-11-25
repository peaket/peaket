// ops-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// 앱 포트(관제 HTTP /v1/ops/commands)와 관리 포트(/metrics, /ready)는 서비스 뼈대가 연다.
// 회차 취소 환불 gRPC(PEAKET_PURCHASE_GRPC_ADDR, BAT-425 GAT-130)와 판매 중지·재개 제어 gRPC(PEAKET_*_CONTROL_GRPC_ADDR, BAT-465 R-584)를 싣는다.
// 명령 요청·결과 사건은 Kafka(ops.command-events)로도 받는다(HTTP /internal/v1/ops/command-events와 같은 처리기).
// 종료 세션 목록(ADR-0333 결정 2): 듣기 전에 제어 토픽(설정·종료 세션) 소비를 켜고, 서비스를 닫은 뒤 끈다.
// CS 처리함(F-06-2 GAT-280): 공휴일 파일(PEAKET_HOLIDAY_CALENDAR_FILE)로 영업일 달력을 만들고(staging·prod는 없거나 못 읽으면 시작하지 않는다),
// 건 요청은 Kafka support.cases-requested로도 받는다(내부 HTTP와 같은 처리기). 기한 알림 1분 배경 작업은 CasesModule 수명주기가 켠다.
// 추가 검증 이의(F-06-7): queue·trust·identity gRPC 포트(cs-appeal-wiring.ts)를 AppModule에 넘기고 보낼 호출 배경 작업(10초)도 CasesModule이 켠다.
// staging·prod는 PEAKET_QUEUE_GRPC_URL·PEAKET_TRUST_GRPC_URL이 없으면 서비스를 만들기 전에 시작하지 않는다.
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { assertInternalGrpcToken, createDatabase, createExternalHttpClient, createHotRedis, createService, loadLogPseudonymizer, reauthJtiStoreFromEnv, tenantRateLimitRedisUrlFromEnv } from '@peaket/platform';
import { startServiceControlSync } from '@peaket/platform/stream-worker';
import { AppModule } from './app.module.js';
import { GrpcControlTransport } from './adapters/grpc-control-sender.js';
import { controlTargetsFromEnv } from './adapters/control-targets.js';
import { GrpcEventRefunds } from './adapters/grpc-event-refunds.js';
import { GrpcAdminAuthz } from './adapters/identity-admin-authz.js';
import { GrpcIdentityAdminAccounts } from './modules/admin-accounts/adapters/grpc-identity-admin-accounts.js';
import { HttpCommandExecutor } from './adapters/http-command-executor.js';
import { assertOpsPartnerRole } from './adapters/db/database-role.js';
import { reauthWiring } from './reauth-wiring.js';
import { eventCancellationDepsFromEnv, partnerDatabaseUrlFromEnv, partnerRoleCheckRequired, requireCoreEventStatusUrl } from './event-cancellation-wiring.js';
import { kafkaConsumersFromEnv, type OpsConsumers, startOpsConsumers } from './consumers/index.js';
import { AuditSignals, auditEnvName } from './modules/audit/index.js';
import { CORE_APPLY_RETRY_MS, EventCancellations, PromEventCancellationSignals } from './modules/event-cancellations/index.js';
import { AwsWafIpSets, ControlFanout, ControlPreviewDryRunSource, DrizzleApplyChecks, DrizzleControlDeliveries, GrpcPgAssignmentCheck, GrpcPgSwitchResolver, HttpCoreSaleStart, HttpOnsaleScheduleSource, PromCommandSignals, settingsProbeFromEnv, wafIpSetsConfigFromEnv, type HandleCommandEvent } from './modules/commands/index.js';
import { DrizzleOpsAlertStore } from './modules/alerts/index.js';
import { GrpcPurchasePriorityGrants, HttpPurchasePriorityGrants, HttpQueuePriorityGrantCopies } from './modules/priority/index.js';
import { GrpcTicketScannerDevices } from './modules/scanner-devices/index.js';
import { HttpPayoutPaymentClient, JwksApprovalVerifier } from './modules/payouts/index.js';
import { PromBotReviewSignals } from './modules/bot-review/index.js';
import { botReviewLabelsFromEnv, botReviewSourceFromEnv } from './bot-review-wiring.js';
import { realtimeTableFromEnv } from './rt-wiring.js';
import { HttpCoreContract } from './adapters/http-core-contract.js';
import { PromCsCaseSignals, PromCsDispatchSignals, ReceiveCaseRequested, loadBusinessCalendar } from './modules/cases/index.js';
import { csAppealPortsFromEnv } from './cs-appeal-wiring.js';

const SERVICE = 'ops-svc';
assertInternalGrpcToken(process.env);
const reauthStartup = reauthWiring(process.env);
const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');
const identityUrl = process.env.PEAKET_IDENTITY_GRPC_URL;
if (!identityUrl) throw new Error('PEAKET_IDENTITY_GRPC_URL이 없다(identity AdminAuthzService host:port)');

// CS 처리함 영업일 달력(ADR-0364 결정 1). 파일을 못 읽거나 staging·prod에 파일이 없으면 여기서 시작 실패다
const caseCalendar = loadBusinessCalendar(process.env, (path) => readFileSync(path, 'utf8'));
const caseSignals = new PromCsCaseSignals();
// 추가 검증 이의 처리 포트(F-06-7). staging·prod에서 queue·trust 주소가 없으면 여기서 시작 실패다
const csAppealPorts = csAppealPortsFromEnv(process.env);
const csDispatchSignals = new PromCsDispatchSignals();
const database = createDatabase({ url, applicationName: SERVICE });
// 파트너 회차 취소 경로의 DB 풀(ops_partner 역할 사용자, 행 보안의 대상, 웨이브 끝 리뷰 S2·authz-matrix §5.3). 운영은 PEAKET_PARTNER_DATABASE_URL이 없으면 시작하지 않고,
// local·ci는 관제 풀을 함께 쓴다(그때 행 보안은 시험하지 않는다)
const partnerUrl = partnerDatabaseUrlFromEnv(process.env, url);
const partnerDatabase = partnerUrl === url ? database : createDatabase({ url: partnerUrl, applicationName: `${SERVICE}-partner`, max: 5 });
// 파트너 풀의 DB 역할 시작 검사(W9-fix3 F1, authz-matrix §5.3 끝 '시작 검사'). 파트너 주소가 있으면 관제 주소와 같아도 요청을 받기 전에 보고, 어긋나면 시작하지 않는다
const partnerRoleChecked = partnerRoleCheckRequired(process.env);
if (partnerRoleChecked) await assertOpsPartnerRole(partnerDatabase);
// 회차 취소 지표(확정 실패 뒤 되돌리기 저장 실패, 웨이브 끝 리뷰 K4). 서비스를 만든 뒤 레지스트리에 붙인다
const eventCancellationSignals = new PromEventCancellationSignals();
const adminAuthz = new GrpcAdminAuthz(identityUrl);
// 관리 계정 REST(ADR-0322). identity AdminAccountService·AdminDesignationService·AdminSessionService 클라이언트
const adminIdentity = new GrpcIdentityAdminAccounts(identityUrl);
const purchaseUrl = process.env.PEAKET_PURCHASE_HTTP_URL;
const purchaseGrpcAddr = process.env.PEAKET_PURCHASE_GRPC_ADDR;
const coreUrl = process.env.PEAKET_CORE_HTTP_URL;
const queueUrl = process.env.PEAKET_QUEUE_HTTP_URL;
const paymentUrl = process.env.PEAKET_PAYMENT_HTTP_URL;
const internalToken = process.env.PEAKET_INTERNAL_TOKEN;
// 회차 취소 일괄 환불 gRPC(BAT-425 GAT-130). 주소가 없으면 EVENT_CANCEL은 내부 HTTP 호환 경로로 물러난다.
const refunds = purchaseGrpcAddr ? new GrpcEventRefunds({ address: purchaseGrpcAddr }) : undefined;
// queue-svc 클라이언트는 판매 중지·재개 집행(BAT-465 R-584)과 우선 구매 사본(GAT-135)이 함께 쓴다. 요청마다 자기 마감을 넘긴다.
const queueClient = queueUrl ? createExternalHttpClient({ provider: 'queue-svc', baseUrl: queueUrl, timeoutCapMs: 5_000 }) : undefined;
// 제어 gRPC 정본(ADR-0102, F-02-1 ADR-0365 결정 3·4): 받는 쪽마다 준비된 모든 파드를 대상 찾기로 풀어(local·ci 주소 목록, 운영 헤드리스 DNS) 원장 판으로 보낸다.
// local·ci 밖에서 받는 쪽 주소 설정이 없으면 여기서 시작이 실패한다. 판매 중지·재개는 purchase·queue 설정이 다 있을 때만 이 길이다(없으면 HTTP 호환 경로).
const controlTargets = controlTargetsFromEnv(process.env);
const controlTransport = new GrpcControlTransport();
const previewSource = new ControlPreviewDryRunSource({ targets: controlTargets.targets, transport: controlTransport });
const controlFanout = new ControlFanout({ targets: controlTargets.targets, transport: controlTransport, deliveries: new DrizzleControlDeliveries(database), clock: { now: () => Date.now() } });
const saleControlWired = !controlTargets.missing.includes('purchase-svc') && !controlTargets.missing.includes('queue-svc');
const executor = new HttpCommandExecutor({
  ...(purchaseUrl ? { purchase: createExternalHttpClient({ provider: 'purchase-svc', baseUrl: purchaseUrl, timeoutCapMs: 30_000 }) } : {}),
  ...(coreUrl ? { core: createExternalHttpClient({ provider: 'core-svc', baseUrl: coreUrl, timeoutCapMs: 5_000 }) } : {}),
  ...(refunds ? { refunds } : {}),
  ...(queueClient ? { queue: queueClient } : {}),
  ...(saleControlWired ? { controlDelivery: controlFanout } : {}),
  internalToken,
});
// 명령 12 온세일 윈도우(core-svc 판매 설정)·하위 결제사 판정(payment-svc gRPC CheckEventPgAssignment), BAT-360 ADR-0349 결정 2·3.
// 주소가 없으면 그 원천이 없는 닫힌 쪽이라 명령 12 미리보기·접수·실행이 503이다. 설정 사건은 같은 트랜잭션의 ops Outbox로 내고 릴레이(dist/relay.js)가 보낸다
const paymentGrpcAddr = process.env.PEAKET_PAYMENT_GRPC_ADDR;
const pgAssignmentCheck = paymentGrpcAddr ? new GrpcPgAssignmentCheck({ address: paymentGrpcAddr }) : undefined;
// 명령 6 대체 결제사 전환의 갈 곳 묻기(payment-svc ResolvePgSwitch, F-02-2 ADR-0366 결정 5). 받는 쪽 주소는 PEAKET_PAYMENT_CONTROL_GRPC_ADDRS·_DNS(controlTargetsFromEnv)다
const pgSwitchResolver = paymentGrpcAddr ? new GrpcPgSwitchResolver({ address: paymentGrpcAddr }) : undefined;
const pgAssignment = {
  ...(coreUrl ? { onsale: new HttpCoreSaleStart(createExternalHttpClient({ provider: 'core-svc', baseUrl: coreUrl, timeoutCapMs: 5_000 }), internalToken) } : {}),
  ...(pgAssignmentCheck ? { pgCheck: pgAssignmentCheck } : {}),
};
// 명령 4 만료 확인(ADR-0349 결정 10): 정비 바퀴가 관제용 WAF IP 집합 둘(PEAKET_WAF_IPSET_V4·V6·SCOPE)을 읽기만 한다. 없으면 명령 4를 AUTO_EXPIRED로 적지 않는다
const wafConfig = wafIpSetsConfigFromEnv(process.env, { envName: auditEnvName(process.env) });
const wafIpSets = wafConfig ? new AwsWafIpSets(wafConfig) : undefined;
const purchasePriority = purchaseGrpcAddr ? new GrpcPurchasePriorityGrants(purchaseGrpcAddr) : undefined;
const priority =
  (purchasePriority || purchaseUrl) && queueClient
    ? {
        purchase:
          purchasePriority ?? new HttpPurchasePriorityGrants(createExternalHttpClient({ provider: 'purchase-svc', baseUrl: purchaseUrl!, timeoutCapMs: 5_000 }), internalToken),
        copies: new HttpQueuePriorityGrantCopies(queueClient, internalToken),
      }
    : undefined;
// 재인증 검증기는 결제사 HTTP URL과 분리한다(OPSV-05). identity JWKS만 있으면 회차 취소 확정의 패스키 재인증이 결제 URL 없이도 돈다.
// 재인증 jti 1회용(SEC-03). 주소가 없으면 local·ci용 메모리 기록을 쓰고, 운영은 닫힌 저장소를 쓴다.
const reauthRedisUrl = process.env.PEAKET_REAUTH_REDIS_URL;
const reauthRedis = reauthRedisUrl ? await createHotRedis({ url: reauthRedisUrl }) : undefined;
// 테넌트 한도 Redis(BAT-173 리뷰 RV-01): 재인증 jti Redis는 서비스별 Redis일 수 있어 테넌트 카운터를 두면 `rl:tenant:*`가 쪼개진다.
// `PEAKET_TENANT_REDIS_URL`(세션·캐시 클러스터)이 먼저이고 staging·prod·demo는 없으면 시작하지 않는다. local·ci만 재인증 Redis로 닫힌 대역을 쓴다.
const tenantRedisUrl = tenantRateLimitRedisUrlFromEnv(process.env, { fallbackUrl: reauthRedisUrl });
const tenantRedis = tenantRedisUrl ? await createHotRedis({ url: tenantRedisUrl }) : undefined;
const reauth = process.env.PEAKET_IDENTITY_JWKS_URL
  ? new JwksApprovalVerifier({
      jwksUrl: process.env.PEAKET_IDENTITY_JWKS_URL,
      issuer: process.env.PEAKET_IDENTITY_ISSUER ?? 'https://identity.peaket.example',
      jti: reauthJtiStoreFromEnv(process.env, reauthRedis),
    })
  : undefined;
// 지급 승인 업무(BAT-610 잔여). payment-svc 내부 경로가 없으면 지급 실행은 503이고, 재인증 JWKS가 없으면 승인은 403이다.
const payouts = paymentUrl
  ? {
      payments: new HttpPayoutPaymentClient(paymentUrl, internalToken),
      ...(reauth ? { reauth } : {}),
    }
  : undefined;
// 계약 조건 변경 승인(BAT-615): core 계약 적용·취소. 주소가 없으면 그 경로가 503이고 시작은 막지 않는다
const approvals = {
  ...(coreUrl ? { core: new HttpCoreContract(createExternalHttpClient({ provider: 'core-svc', baseUrl: coreUrl, timeoutCapMs: 3_000 }), internalToken) } : {}),
  ...(reauth ? { reauth } : {}),
};
if (!coreUrl) console.warn(JSON.stringify({ level: 'warn', kind: 'approval-wiring', msg: 'PEAKET_CORE_HTTP_URL이 없어 계약 승인 적용·반려가 503이다' }));
// core 회차 상태 반영(BAT-420-rest GAT-110): 주소가 없으면 local·ci만 경고로 시작하고 그 밖은 여기서 시작 실패다
const coreEventStatusWarning = requireCoreEventStatusUrl(process.env);
// 회차 취소 요청(BAT-420 GAT-110): 파트너 소속 확인(core 판매 설정)·확정 때 판매 멈춤(판매 중지 집행)·판정 미리보기와 진행률(purchase gRPC).
// 판매 중지 확인과 CS '판정 대기' 건은 AppModule이 같은 DB로 기본을 채운다.
// 환급 미룸(holds, BAT-420 몫 D)은 같은 purchase gRPC 클라이언트의 SetEventRefundHold다. 없으면 CANCEL 요청·판정·확정이 503이다.
const { holds, ...cancellationDeps } = eventCancellationDepsFromEnv({ env: process.env, executor, ...(refunds ? { refunds } : {}), ...(internalToken ? { internalToken } : {}) });
const eventCancellations = {
  ...(refunds ? { refunds } : {}),
  ...(reauth ? { reauth } : {}),
  ...cancellationDeps,
  ...(holds ? { holds } : {}),
  revertFailures: eventCancellationSignals.revertFailures,
  coreApplyFailures: eventCancellationSignals.coreApplyFailures,
};
/** AppModule이 만든 명령 사건 처리기(Kafka 소비자가 HTTP와 같은 객체를 쓴다) */
let commandEvents: HandleCommandEvent | undefined;
// 관제 스캐너 기기 경계(BAT-450): ops-svc가 권한·감사를 맡고 ticket-svc ScannerDeviceService gRPC가 원장을 쓴다.
const ticketGrpcUrl = process.env.PEAKET_TICKET_GRPC_URL;
const scannerDevices = ticketGrpcUrl ? new GrpcTicketScannerDevices({ address: ticketGrpcUrl }) : undefined;
// 감사 체크포인트 서명 키는 이 프로세스에 없다: 서명·게시는 게시 작업(dist/jobs/audit-anchor.js)만 한다(BAT-360, ADR-0348 결정 1·4).
// 봇 표본 검토(BAT-197 BOT-080): 후보 원장(ClickHouse, OPS-220 적재)과 trust-svc ApplyLabel을 조립한다.
// 주소가 없으면 닫힌 대역으로 시작하고 그 경로만 503이다(진행은 배치가 없어 404).
const botReviewSignals = new PromBotReviewSignals();
const botReviewSource = botReviewSourceFromEnv(process.env);
const botReviewLabels = botReviewLabelsFromEnv(process.env);
const botReviewActorRef = loadLogPseudonymizer(process.env).pseudonymizer;
// 관제 실시간 표(OPS-160, F-04-1): rt 뷰 0.5초 조회 보드와 파트너 판매 현황. 소속 확인은 회차 취소와 같은 core 판매 설정 클라이언트다
const realtimeTable = realtimeTableFromEnv(process.env, { ...(cancellationDeps.owners ? { owners: cancellationDeps.owners } : {}) });
// 명령·감사 체인 지표(BAT-355): ops_command_dry_run_unavailable_total, ops_audit_mac_lag_seconds, ops_audit_kms_failover_total. 서비스를 만든 뒤 레지스트리에 붙인다
const commandSignals = new PromCommandSignals();
const auditSignals = new AuditSignals();
const service = await createService({
  name: SERVICE,
  adminAuthz,
  // 파트너 테넌트당 600회/분 공용 가드(BAT-173, D-T50 ⑦). 재인증 Redis가 아니라 `PEAKET_TENANT_REDIS_URL`의 세션·캐시 Redis다(RV-01)
  ...(tenantRedis ? { tenantRateLimit: { redis: tenantRedis } } : {}),
  module: AppModule.register({
    database,
    partnerDatabase,
    executor,
    ...(priority ? { priority } : {}),
    ...(scannerDevices ? { scannerDevices } : {}),
    ...(payouts ? { payouts } : {}),
    approvals,
    adminAccounts: { identity: adminIdentity, ...(reauth ? { reauth } : {}) },
    eventCancellations,
    realtimeTable: realtimeTable.deps,
    botReview: {
      source: botReviewSource.source,
      ...(botReviewLabels ? { labels: botReviewLabels } : {}),
      signals: botReviewSignals,
      accountRef: (accountId: string) => botReviewActorRef.ref(accountId),
    },
    onCommandEvent: (h) => (commandEvents = h),
    commandExtras: { signals: commandSignals, pgAssignment, ...(wafIpSets ? { blockIpSets: wafIpSets } : {}), dryRunSources: { ADMISSION_TARGET: previewSource, KILL_SWITCH: previewSource }, settingsApply: { probe: settingsProbeFromEnv(process.env), store: new DrizzleApplyChecks(database), alerts: new DrizzleOpsAlertStore(database) }, ...(coreUrl ? { onsaleSchedule: { source: new HttpOnsaleScheduleSource({ baseUrl: coreUrl, token: process.env.PEAKET_INTERNAL_TOKEN }) } } : {}), control: { fanout: controlFanout, deliveries: new DrizzleControlDeliveries(database), ...(pgSwitchResolver ? { pgSwitch: pgSwitchResolver } : {}), simulatorPg: ['local', 'ci'].includes(process.env.PEAKET_ENV ?? '') } },
    auditSignals,
    calendar: caseCalendar,
    caseSignals,
    csAppeals: {
      ...(csAppealPorts.appeals ? { appeals: csAppealPorts.appeals } : {}),
      ...(csAppealPorts.labels ? { labels: csAppealPorts.labels } : {}),
      ...(csAppealPorts.evidence ? { evidence: csAppealPorts.evidence } : {}),
      ...(csAppealPorts.holds ? { holds: csAppealPorts.holds } : {}),
      signals: csDispatchSignals,
    },
  }),
});
eventCancellationSignals.register(service.metrics.registry);
botReviewSignals.register(service.metrics.registry);
commandSignals.register(service.metrics.registry);
auditSignals.register(service.metrics.registry);
caseSignals.register(service.metrics.registry);
realtimeTable.signals.register(service.metrics.registry);
realtimeTable.deps.board.setLog(service.logger);
for (const warning of realtimeTable.warnings) service.logger.warn({}, warning);
csDispatchSignals.register(service.metrics.registry);
if (csAppealPorts.missing.length > 0) {
  service.logger.warn({ missing: csAppealPorts.missing }, '추가 검증 이의 처리 주소가 없어 그 보낼 호출을 NOT_CONFIGURED로 쌓아 둔다(local·ci·demo만 허락한다)');
}
if (!caseCalendar.fromFile) service.logger.warn({}, 'PEAKET_HOLIDAY_CALENDAR_FILE이 없어 CS 처리함 기한을 주말만 빼고 센다(local·ci만 허락한다)');
if (botReviewSource.warning) service.logger.warn({}, botReviewSource.warning);
if (!botReviewLabels) service.logger.warn({}, 'PEAKET_TRUST_GRPC_URL이 없어 표본 판정 HUMAN·BOT이 503 bot-review-label-unavailable이다(UNDECIDED는 기록된다)');
if (!partnerRoleChecked) service.logger.warn({}, 'PEAKET_PARTNER_DATABASE_URL이 없어 파트너 회차 취소 경로가 관제 DB 풀을 함께 쓴다(local·ci만, 행 보안은 앱 대조만 남는다)');
if (!purchaseGrpcAddr) service.logger.warn({}, 'PEAKET_PURCHASE_GRPC_ADDR이 없어 회차 취소 환불 gRPC를 쓰지 않는다(내부 HTTP 호환 경로)');
if (!purchaseUrl && !purchaseGrpcAddr) service.logger.warn({}, 'PEAKET_PURCHASE_HTTP_URL·PEAKET_PURCHASE_GRPC_ADDR이 없어 EVENT_CANCEL 실행을 하지 않는다');
if (!coreUrl) service.logger.warn({}, 'PEAKET_CORE_HTTP_URL이 없어 SCALE_CHANGE 실행을 하지 않는다');
if (!wafIpSets) service.logger.warn({}, 'PEAKET_WAF_IPSET_V4·PEAKET_WAF_IPSET_V6이 없어 만료가 지난 명령 4를 AUTO_EXPIRED로 적지 않는다(ACKED 그대로)');
if (!coreUrl || !pgAssignmentCheck) service.logger.warn({}, 'PEAKET_CORE_HTTP_URL·PEAKET_PAYMENT_GRPC_ADDR이 없어 명령 12(PG_ASSIGN) 미리보기·접수·실행이 503이다');
if (!purchaseUrl || !queueUrl) service.logger.warn({}, 'PEAKET_PURCHASE_HTTP_URL·PEAKET_QUEUE_HTTP_URL이 없어 SALE_STOP·SALE_RESUME 실행을 하지 않는다');
if (!priority) service.logger.warn({}, 'PEAKET_PURCHASE_HTTP_URL·PEAKET_QUEUE_HTTP_URL이 없어 우선 구매 권리 발급·회수를 열지 않는다');
if (!scannerDevices) service.logger.warn({}, 'PEAKET_TICKET_GRPC_URL이 없어 관제 스캐너 기기 경로(/v1/ops/scanner-devices)를 열지 않는다');
if (!cancellationDeps.owners) service.logger.warn({}, 'PEAKET_CORE_HTTP_URL이 없어 파트너 회차 취소 요청·상태가 503 authz-unavailable이다');
if (!cancellationDeps.stopper) service.logger.warn({}, '판매 중지 집행 길(purchase·queue HTTP 또는 제어 gRPC)이 없어 회차 취소 확정이 503 sale-stop-unavailable이다');
if (!cancellationDeps.reader) service.logger.warn({}, 'PEAKET_PURCHASE_GRPC_ADDR이 없어 회차 취소 판정 미리보기가 503 event-refund-unavailable이다');
if (!reauth) service.logger.warn({}, 'PEAKET_IDENTITY_JWKS_URL이 없어 회차 취소 요청·확정이 503 reauth-unavailable이다');
for (const warning of reauthStartup.warnings) service.logger.warn({}, warning);
if (coreEventStatusWarning) service.logger.warn({}, coreEventStatusWarning);
if (controlTargets.missing.length > 0) service.logger.warn({ services: controlTargets.missing }, '제어 gRPC 받는 쪽 주소 설정(PEAKET_<서비스>_CONTROL_GRPC_ADDRS)이 없어 그 받는 쪽으로 가는 명령이 ack 시한에 FAILED다(local·ci만)');
// 종료 세션 목록(ADR-0333 결정 2): 듣기 전에 두 제어 토픽을 읽기 시작한다(다 읽어야 /ready 200). 브로커가 없으면 local·ci만 경고로 끄고 그 밖은 여기서 시작에 실패한다
const controlSync = startServiceControlSync(service, process.env);
await service.listen();
// core 회차 상태 반영 다시 하기(1분 [가정], BAT-420-rest GAT-110, R-T41 ③). 잡기 뒤 미루기(SKIP LOCKED)라 파드 여럿이 함께 돌려도 한 요청은 한쪽만 부른다
const coreApplyTimer = cancellationDeps.core
  ? setInterval(() => {
      void service.app
        .get(EventCancellations)
        .retryCoreApply()
        .catch((err: unknown) => service.logger.warn({ event: 'event-cancellation-core-apply-tick-failed', err: err instanceof Error ? err.name : 'unknown' }, 'core 반영 다시 하기 한 바퀴가 실패했다'));
    }, CORE_APPLY_RETRY_MS)
  : undefined;
coreApplyTimer?.unref();

// 명령 요청·결과 사건 소비자(ops.command-events, BAT-465 R-584). HTTP 수신기와 같은 처리기를 쓴다.
let consumers: OpsConsumers | undefined;
try {
  const kafka = kafkaConsumersFromEnv(process.env);
  if (!kafka.enabled) {
    service.logger.warn({}, kafka.warning);
  } else if (commandEvents) {
    const pod = (process.env.PEAKET_POD ?? process.env.HOSTNAME ?? 'local').slice(0, 64);
    consumers = startOpsConsumers({
      env: kafka.env,
      brokers: kafka.brokers,
      clientId: `${SERVICE}-${kafka.env}-${pod}`,
      ...(kafka.auth ? { auth: kafka.auth } : {}),
      database,
      handler: commandEvents,
      // CS 처리함 건 요청(support.cases-requested): 내부 HTTP와 같은 처리기(ADR-0364 결정 4)
      cases: service.app.get(ReceiveCaseRequested),
      logger: service.logger,
    });
    consumers.started.catch((err: unknown) => service.logger.error({ err }, 'ops.command-events·support.cases-requested 소비자 시작 실패'));
  }
} catch (err) {
  // 설정 오류는 시작 실패다(조용히 사건을 잃지 않는다)
  service.logger.error({ err }, 'Kafka 소비자 설정이 올바르지 않다');
  throw err;
}

process.once('SIGTERM', () => {
  if (coreApplyTimer) clearInterval(coreApplyTimer);
  void (async () => {
    try {
      await consumers?.stop();
    } catch (err) {
      service.logger.error({ err }, 'ops.command-events 소비자 종료 실패');
    }
    try {
      await service.close();
    } catch (err) {
      service.logger.error({ err }, 'ops-svc 종료 실패');
    } finally {
      try {
        refunds?.close();
        purchasePriority?.close();
      } catch (err) {
        service.logger.error({ err }, '회차 취소 환불·우선 구매 gRPC 클라이언트 닫기 실패');
      }
      try {
        controlTransport.close();
      } catch (err) {
        service.logger.error({ err }, '제어 gRPC 클라이언트 닫기 실패');
      }
      scannerDevices?.close();
      pgAssignmentCheck?.close();
      pgSwitchResolver?.close();
      botReviewLabels?.close();
      csAppealPorts.close();
      adminIdentity.close();
      adminAuthz.close();
      // 종료 세션 목록 소비는 서비스를 닫은 뒤(처리 중인 요청이 끝난 뒤) 끈다
      await controlSync?.close();
      await tenantRedis?.close();
      await reauthRedis?.close();
      if (partnerDatabase !== database) await partnerDatabase.close();
      await database.close();
    }
  })();
});
