// identity-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱 포트(REST: 팬 토큰 갱신 POST /v1/identity/access-tokens, 공개키 묶음 GET /internal/jwks/{set}.json)·관리 포트(/metrics, /ready)는
// 서비스 뼈대가, 업무 gRPC 포트는 이 파일이 연다.
import 'reflect-metadata';
import { createDatabase, createHotRedis, createService, loadPlatformConfig } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { startGrpcServer } from './grpc-server.js';
import {
  AddProvider,
  CreateSession,
  EndSession,
  GetLinkProposal,
  GetVerificationStatus,
  HmacDeviceRefs,
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

const keys = await TokenKeyRing.fromEnv(process.env);
const signer = new JoseTokenSigner(keys, tokenIssuerFromEnv(process.env));
const devices = HmacDeviceRefs.fromEnv(process.env);
// 본인확인기관: 계약 전에는 시험 어댑터만 있다(local·ci·demo). 켜지 않으면 본인확인 시작이 503 PROVIDER_DOWN이다(identity §5)
const verification = process.env[VERIFICATION_PROVIDER_ENV]
  ? // 연계정보·pid 키: KMS 키 목록이 있으면 KMS, 없으면 설정값 키(local·ci·demo만, identity §5 '키 판·만 14세…')
    { provider: TestVerificationProvider.fromEnv(process.env), hashers: KmsIdentityHashers.fromEnv(process.env) ?? HmacIdentityHashers.fromEnv(process.env) }
  : { provider: unavailableProvider, hashers: unavailableHashers };
const signals = new PromSessionSignals();
const database = createDatabase({ url, applicationName: SERVICE });
// 세션·캐시 Redis: 가입 때 연결 제안(id:link, identity §2.1). 운영·데모는 반드시 둔다. 로컬·CI만 없으면 프로세스 메모리로 대신한다(파드가 여럿이면 제안을 잃는다)
const cacheUrl = process.env.PEAKET_IDENTITY_REDIS_URL;
const env = process.env.PEAKET_ENV ?? 'local';
if (!cacheUrl && env !== 'local' && env !== 'ci') throw new Error('PEAKET_IDENTITY_REDIS_URL이 없다(세션·캐시 Redis, 비밀 관리에서 넣는다)');
const cache = cacheUrl ? await createHotRedis({ url: cacheUrl }) : undefined;
// 계정 병합의 세 서비스 확인(identity §2.1 '계정 병합의 첫 구현'). 주소가 없으면 로컬·CI만 대역, 운영·데모는 병합하지 않는다
const merge = mergeCheckersFromEnv(process.env, loadPlatformConfig(process.env).grpcLbProfile);
const service = await createService({ name: SERVICE, module: AppModule.register({ database, session: { signer, keys, deviceRefs: devices.refs, signals, cookieDomain: process.env.PEAKET_COOKIE_DOMAIN || undefined, ...(cache ? { linkProposals: new RedisLinkProposals(cache, Date.now), mergeProposals: new RedisMergeProposals(cache, Date.now) } : {}), mergeCheckers: merge.checkers }, verification }) });
signals.register(service.metrics.registry);
// 기록이 쓰는 연계정보 키 판을 설정이 모두 갖지 않으면 시작하지 않는다(같은 사람이 계정을 하나 더 만들지 못하게, identity §5 '키 판·만 14세…')
if (process.env[VERIFICATION_PROVIDER_ENV]) await assertKeyVersions(service.app.get<DrizzleVerificationStore>(VERIFICATION_STORE), verification.hashers);
if (devices.warning) service.logger.warn(devices.warning);
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
    .then(() => service.close())
    .catch((err: unknown) => service.logger.error({ err }, 'identity-svc 종료 실패'))
    .finally(() => Promise.all([database.close(), cache?.close()]));
});
