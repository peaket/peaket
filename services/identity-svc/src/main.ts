// identity-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱 포트(REST: 팬 토큰 갱신 POST /v1/identity/access-tokens, 공개키 묶음 GET /internal/jwks/{set}.json)·관리 포트(/metrics, /ready)는
// 서비스 뼈대가, 업무 gRPC 포트는 이 파일이 연다.
import 'reflect-metadata';
import { type AdminAuthzPort, createDatabase, createHotRedis, createService, loadPlatformConfig, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { KMSClient } from '@aws-sdk/client-kms';
import { adminAuthConfigFromEnv, adminAuthzHandlers, adminMailerFromEnv, adminPepperFromEnv, CheckPasswordOnlyLogins, DispatchAdminNotices, GetAdminAuthz, hibpBreachListFromEnv, JoseAdminTokenSigner, kmsPepperClient, loadPolicyLists, PromAdminLoginSignals, RedisLoginCounters, totpSeedCipherFromEnv, turnstileFromEnv } from './modules/admin/index.js';
import { startGrpcServer } from './grpc-server.js';
import {
  AddProvider,
  CreateSession,
  EndSession,
  GetLinkProposal,
  ComputeContactRef,
  contactRefHandlers,
  GetInvestigationRefs,
  GetVerificationStatus,
  investigationRefHandlers,
  InvRefKeyRing,
  phoneContactRefs,
  deviceRefsOf,
  IssueReauthToken,
  identityPackage,
  identityServiceHandlers,
  JoseTokenSigner,
  PromSessionSignals,
  accountHoldHandlers,
  mergeCheckersFromEnv,
  RedisLinkProposals,
  RedisMergeProposals,
  SeparateAccount,
  SetAccountHold,
  sessionServiceHandlers,
  TokenKeyRing,
  tokenIssuerFromEnv,
} from './modules/session/index.js';
import {
  assertKeyVersions,
  DrizzleVerificationStore,
  HmacIdentityHashers,
  KmsIdentityHashers,
  kmsMacClient,
  restrictedCiHoldHandlers,
  SetRestrictedCiHold,
  TestVerificationProvider,
  unavailableHashers,
  unavailableProvider,
  VERIFICATION_PROVIDER_ENV,
  VERIFICATION_STORE,
} from './modules/verification/index.js';

const SERVICE = 'identity-svc';
/** 업무 gRPC 포트 [가정](정본에 값이 없다. BUILD_ORDER BAS-080이 공용 설정으로 옮긴다) */
const DEFAULT_GRPC_PORT = 50051;

const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');
const grpcPort = Number(process.env.PEAKET_GRPC_PORT ?? DEFAULT_GRPC_PORT);
if (!(Number.isInteger(grpcPort) && grpcPort > 0 && grpcPort <= 65535)) throw new Error(`PEAKET_GRPC_PORT가 틀렸다: ${process.env.PEAKET_GRPC_PORT}`);

// 관리 계정 인증 통제 설정의 범위 검사와 페퍼 키 설정(docs/security/auth-controls.md §5 AC-T10, identity §6): 범위를 벗어나면 시작하지 않는다
// 대조 목록 파일(L1·L3, 배포가 더한 L3 파일 포함), 유출 목록 주소, 사람 확인 주소도 여기서 본다. local·ci 밖은 페퍼가 필수다(identity §6 BOT-111)
const adminAuth = adminAuthConfigFromEnv(process.env);
const adminPepper = adminPepperFromEnv(process.env, (endpoint) => kmsPepperClient({ region: process.env.AWS_REGION ?? 'ap-northeast-2', ...(endpoint ? { endpoint } : {}) }));
if (!adminPepper && !['local', 'ci'].includes(process.env.PEAKET_ENV ?? 'prod')) throw new Error('관리자 비밀번호 페퍼 설정(PEAKET_ADMIN_PEPPER_KMS_KEYS)이 없다');
const adminLists = loadPolicyLists(process.env);
const adminBreaches = hibpBreachListFromEnv(process.env, adminAuth);
const adminHumanCheck = turnstileFromEnv(process.env);
// 관리 토큰 갱신은 팬과 같은 갱신 지표(aud partner·ops)로 낸다: 재사용 탐지 SEV3 경보가 함께 본다(identity §10.1, BOT-130)
const adminSignals = new PromAdminLoginSignals({ refreshed: (aud, result) => signals.refreshed(aud, result) });
// 계정 주인 메일(해제 링크 등): 운영 발송 대행은 정본에 없다 [가정]. local·ci는 PEAKET_ADMIN_MAIL_DIR 파일 대역(BOT-121)
const adminMailer = adminMailerFromEnv(process.env);
const consoleOrigins = { partner: process.env.PEAKET_PARTNER_CONSOLE_ORIGIN || 'https://partner.peaket.example', ops: process.env.PEAKET_OPS_CONSOLE_ORIGIN || 'https://console.peaket.example' };
// TOTP 시드 봉투 암호화(KMS 키, 로컬·CI는 키 값). local·ci에서 없으면 2단계가 503이고, 그 밖에서는 시작하지 않는다(identity §6 BOT-120)
const adminTotpCipher = totpSeedCipherFromEnv(process.env, (endpoint) => new KMSClient({ region: process.env.AWS_REGION ?? 'ap-northeast-2', ...(endpoint ? { endpoint } : {}), maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 2_000 } }));
if (adminPepper && !adminTotpCipher && !['local', 'ci'].includes(process.env.PEAKET_ENV ?? 'prod')) throw new Error('TOTP 시드 키 설정(PEAKET_ADMIN_TOTP_KMS_KEY)이 없다');
const keys = await TokenKeyRing.fromEnv(process.env);
const signer = new JoseTokenSigner(keys, tokenIssuerFromEnv(process.env));
// 조사용 가명 라벨 키 링(identity §9.1 '조사용 값의 첫 구현'): 라벨마다 KMS GenerateMac(로컬·CI는 라벨 키 값), 10분 [가정] 수명. 시작은 기다리지 않는다
const invRefs = InvRefKeyRing.fromEnv(process.env, systemClock, (endpoint) => kmsMacClient({ region: process.env.AWS_REGION ?? 'ap-northeast-2', ...(endpoint ? { endpoint } : {}) }));
const devices = deviceRefsOf(invRefs.ring);
// 본인확인기관: 계약 전에는 시험 어댑터만 있다(local·ci·demo). 켜지 않으면 본인확인 시작이 503 PROVIDER_DOWN이다(identity §5)
const verification = process.env[VERIFICATION_PROVIDER_ENV]
  ? // 연계정보·pid 키: KMS 키 목록이 있으면 KMS, 없으면 설정값 키(local·ci·demo만, identity §5 '키 판·만 14세…')
    { provider: TestVerificationProvider.fromEnv(process.env), hashers: KmsIdentityHashers.fromEnv(process.env) ?? HmacIdentityHashers.fromEnv(process.env), phoneRefs: phoneContactRefs(invRefs.ring) }
  : { provider: unavailableProvider, hashers: unavailableHashers };
const signals = new PromSessionSignals();
invRefs.ring.onMissing((label, reason) => signals.invRefMissing(label, reason));
// 뜰 때 라벨 키를 먼저 받는다(2초 [가정]까지 기다리고, 그 뒤에는 받는 대로 쓴다). 로거가 서기 전의 실패는 모아 두었다가 남긴다
const earlyInvRefErrors: { label: string; reason: string; err: unknown }[] = [];
invRefs.ring.onRefreshError((label, reason, err) => earlyInvRefErrors.push({ label, reason, err }));
const invRefStart = invRefs.ring.start();
await invRefStart.ready;
const stopInvRefs = invRefStart.stop;
const contactRefRps = process.env.PEAKET_CONTACT_REF_RPS ? Number(process.env.PEAKET_CONTACT_REF_RPS) : undefined;
if (contactRefRps !== undefined && !(Number.isInteger(contactRefRps) && contactRefRps > 0)) throw new Error(`PEAKET_CONTACT_REF_RPS가 틀렸다: ${process.env.PEAKET_CONTACT_REF_RPS}`);
const database = createDatabase({ url, applicationName: SERVICE });
// 세션·캐시 Redis: 가입 때 연결 제안(id:link, identity §2.1). 운영·데모는 반드시 둔다. 로컬·CI만 없으면 프로세스 메모리로 대신한다(파드가 여럿이면 제안을 잃는다)
const cacheUrl = process.env.PEAKET_IDENTITY_REDIS_URL;
const env = process.env.PEAKET_ENV ?? 'local';
if (!cacheUrl && env !== 'local' && env !== 'ci') throw new Error('PEAKET_IDENTITY_REDIS_URL이 없다(세션·캐시 Redis, 비밀 관리에서 넣는다)');
const cache = cacheUrl ? await createHotRedis({ url: cacheUrl }) : undefined;
// 계정 병합의 세 서비스 확인(identity §2.1 '계정 병합의 첫 구현'). 주소가 없으면 로컬·CI만 대역, 운영·데모는 병합하지 않는다
const merge = mergeCheckersFromEnv(process.env, loadPlatformConfig(process.env).grpcLbProfile);
// identity 자신의 관리 경로 역할 판정(ADR-0172): 같은 프로세스의 GetAdminAuthz를 가드 포트로 넣는다. 앱이 선 뒤에 잇는다(BOT-123)
const adminAuthzHolder: { port?: AdminAuthzPort } = {};
const adminAuthz: AdminAuthzPort = { getAdminAuthz: (q, o) => (adminAuthzHolder.port ? adminAuthzHolder.port.getAdminAuthz(q, o) : Promise.reject(new Error('관리 역할 판정이 아직 준비되지 않았다'))) };
// 관리 경로(페퍼가 있을 때만 싣는다)가 없으면 판정 포트도 넘기지 않는다: 시작 확인이 관리 역할 처리기 없음을 그대로 본다(새 맥락 리뷰 2026-11-05)
const service = await createService({ name: SERVICE, ...(adminPepper ? { adminAuthz } : {}), module: AppModule.register({ database, session: { signer, keys, deviceRefs: devices, signals, cookieDomain: process.env.PEAKET_COOKIE_DOMAIN || undefined, ...(cache ? { linkProposals: new RedisLinkProposals(cache, Date.now), mergeProposals: new RedisMergeProposals(cache, Date.now) } : {}), mergeCheckers: merge.checkers, invRefs: invRefs.ring, ...(contactRefRps ? { contactRefRps } : {}) }, verification, ...(adminPepper ? { admin: { config: adminAuth, lists: adminLists, pepper: adminPepper, breaches: adminBreaches, humanCheck: adminHumanCheck, signals: adminSignals, totpCipher: adminTotpCipher, signer: keys.has('admin') ? new JoseAdminTokenSigner(keys, tokenIssuerFromEnv(process.env)) : null, cookieDomain: process.env.PEAKET_COOKIE_DOMAIN || undefined, mailer: adminMailer, consoleOrigins, ...(cache ? { counters: new RedisLoginCounters(cache) } : {}) } } : {}) }) });
signals.register(service.metrics.registry);
adminSignals.register(service.metrics.registry);
if (!adminPepper) service.logger.warn('관리자 비밀번호 페퍼 설정이 없어 관리 계정 로그인 경로를 싣지 않았다(local·ci만)');
if (adminPepper) adminAuthzHolder.port = service.app.get(GetAdminAuthz);
// 계정 주인 알림 발송 고리: 5초 [가정]마다 보내지 않은 알림을 보낸다(파드가 여럿이어도 행 잠금으로 한 번만, identity §6 BOT-121)
const ADMIN_NOTICE_INTERVAL_MS = 5_000;
let stopAdminNotices: () => Promise<void> = async () => {};
if (adminPepper && adminMailer) {
  const dispatch = service.app.get(DispatchAdminNotices);
  let inflight: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (inflight) return;
    inflight = dispatch
      .run()
      .then((r) => {
        if (r.failed > 0) service.logger.warn({ failed: r.failed, done: r.done }, '관리 계정 알림 일부를 보내지 못해 미뤘다(다음 시도 때 다시 한다)');
      })
      .catch((err: unknown) => service.logger.warn({ err }, '관리 계정 알림을 보내지 못했다(다음 고리에서 다시 한다)'))
      .finally(() => {
        inflight = null;
      });
  }, ADMIN_NOTICE_INTERVAL_MS);
  timer.unref();
  // 종료 때는 새 고리를 멈추고 도는 중인 고리가 끝나기를 기다린 뒤 DB를 닫는다
  stopAdminNotices = async () => {
    clearInterval(timer);
    await inflight;
  };
}
// 비밀번호만 맞은 로그인 확인 고리: 1분 [가정]마다(identity §6 BOT-123). 메일이 없어도 비밀번호 바꾸기 필요는 켠다
const PASSWORD_ONLY_INTERVAL_MS = 60_000;
let stopPasswordOnly: () => Promise<void> = async () => {};
if (adminPepper) {
  const check = service.app.get(CheckPasswordOnlyLogins);
  let inflight: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (inflight) return;
    inflight = check
      .run()
      .catch((err: unknown) => service.logger.warn({ err }, '비밀번호만 맞은 로그인을 확인하지 못했다(다음 고리에서 다시 한다)'))
      .finally(() => {
        inflight = null;
      });
  }, PASSWORD_ONLY_INTERVAL_MS);
  timer.unref();
  stopPasswordOnly = async () => {
    clearInterval(timer);
    await inflight;
  };
}
if (adminPepper && !adminMailer) service.logger.warn('관리 계정 메일 포트가 없어 계정 주인 알림(해제 링크 등)을 보내지 않는다. 알림 행은 쌓인다(identity §6 BOT-121)');
// 기록이 쓰는 연계정보 키 판을 설정이 모두 갖지 않으면 시작하지 않는다(같은 사람이 계정을 하나 더 만들지 못하게, identity §5 '키 판·만 14세…')
if (process.env[VERIFICATION_PROVIDER_ENV]) await assertKeyVersions(service.app.get<DrizzleVerificationStore>(VERIFICATION_STORE), verification.hashers);
for (const w of invRefs.warnings) service.logger.warn(w);
for (const e of earlyInvRefErrors) service.logger.warn(e, '조사용 가명 라벨 키를 받지 못했다(identity §9.1)');
invRefs.ring.onRefreshError((label, reason, err) => service.logger.warn({ label, reason, err }, '조사용 가명 라벨 키를 다시 받지 못했다(identity §9.1)'));
for (const w of merge.warnings) service.logger.warn(w);
if (!cache) service.logger.warn('PEAKET_IDENTITY_REDIS_URL이 없어 가입 때 연결 제안을 이 프로세스 메모리에 둔다(local·ci만)');

await service.listen();
const grpc = await startGrpcServer({
  host: process.env.PEAKET_GRPC_HOST ?? '0.0.0.0',
  port: grpcPort,
  services: [
    {
      definition: identityPackage().SessionService.service,
      handlers: sessionServiceHandlers(
        { create: service.app.get(CreateSession), end: service.app.get(EndSession), reauth: service.app.get(IssueReauthToken), linkView: service.app.get(GetLinkProposal), separate: service.app.get(SeparateAccount), addProvider: service.app.get(AddProvider) },
        (method, err) => service.logger.error({ err, method }, 'SessionService 처리 실패'),
      ),
    },
    // 주문 생성의 본인확인 재확인(purchase-svc, 전환 기간의 옛 pid 포함, identity §5 'pid 키 전환의 첫 구현')
    {
      definition: identityPackage().IdentityService.service,
      handlers: identityServiceHandlers({ status: service.app.get(GetVerificationStatus) }, (method, err) => service.logger.error({ err, method }, 'IdentityService 처리 실패')),
    },
    // 이의 제기·소명 계류(ops-svc만, 계정 병합의 APPEAL_PENDING, identity §2.1 '계정 병합의 첫 구현')
    {
      definition: identityPackage().AccountHoldService.service,
      handlers: accountHoldHandlers({ hold: service.app.get(SetAccountHold) }, (method, err) => service.logger.error({ err, method }, 'AccountHoldService 처리 실패')),
    },
    // 주문 예매자 번호의 연락처 가명(purchase-svc만), 조사 적재의 연결 값(inv-ingest만). 신원은 메시 L7 허용 목록(identity §9.1 '조사용 값의 첫 구현')
    {
      definition: identityPackage().ContactRefService.service,
      handlers: contactRefHandlers({ compute: service.app.get(ComputeContactRef) }, (method, err) => service.logger.error({ err, method }, 'ContactRefService 처리 실패')),
    },
    {
      definition: identityPackage().InvestigationRefService.service,
      handlers: investigationRefHandlers({ refs: service.app.get(GetInvestigationRefs) }, (method, err) => service.logger.error({ err, method }, 'InvestigationRefService 처리 실패')),
    },
    // 관리 경로의 역할 판정(관리 경로를 처리하는 서비스의 가드, ADR-0172, BOT-123)
    ...(adminPepper
      ? [{ definition: identityPackage().AdminAuthzService.service, handlers: adminAuthzHandlers({ authz: service.app.get(GetAdminAuthz) }, (method, err) => service.logger.error({ err, method }, 'AdminAuthzService 처리 실패')) }]
      : []),
    // 이용 제한 중 탈퇴의 대조값 보관(ops-svc만, identity §8 '대조값 보관의 첫 구현')
    {
      definition: identityPackage().RestrictedCiHoldService.service,
      handlers: restrictedCiHoldHandlers({ hold: service.app.get(SetRestrictedCiHold) }, (method, err) => service.logger.error({ err, method }, 'RestrictedCiHoldService 처리 실패')),
    },
  ],
});
service.logger.info({ port: grpc.port }, '업무 gRPC 포트를 열었다');

process.once('SIGTERM', () => {
  // gRPC 포트를 먼저 닫아 새 호출을 받지 않고, 처리 중인 호출이 끝나면 서비스와 연결을 닫는다
  void grpc
    .close()
    .then(() => Promise.all([stopAdminNotices(), stopPasswordOnly()]))
    .then(() => service.close())
    .catch((err: unknown) => service.logger.error({ err }, 'identity-svc 종료 실패'))
    .finally(() => {
      stopInvRefs();
      return Promise.all([database.close(), cache?.close()]);
    });
});
