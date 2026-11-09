// 서비스 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
import { createDatabase, createService, loadPlatformConfig } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { assertDatabaseRole, GrpcAdminAuthz } from './modules/catalog/index.js';

const SERVICE = 'core-svc';
/** 파트너 경로의 풀 크기 [가정](핫패스가 아니다, ADR-0241) */
const PARTNER_POOL_MAX = 4;
const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');
// 파트너 경로의 DB 사용자(core_partner, 행 보안의 대상, ADR-0241). 없으면 시작하지 않는다
const partnerUrl = process.env.PEAKET_PARTNER_DATABASE_URL;
if (!partnerUrl) throw new Error('PEAKET_PARTNER_DATABASE_URL이 없다(비밀 관리에서 넣는다)');

// 파트너 경로의 역할·테넌트는 요청마다 identity에 묻는다(ADR-0172). 주소가 없으면 시작하지 않는다(대역으로 통과시키지 않는다, ADR-0198 결정 6)
const identityGrpc = process.env.PEAKET_IDENTITY_GRPC_URL;
if (!identityGrpc) throw new Error('PEAKET_IDENTITY_GRPC_URL이 없다(identity AdminAuthzService host:port)');
// 부하 분산 프로필은 다른 서비스와 같은 설정(PEAKET_GRPC_LB_PROFILE)을 따른다
const adminAuthz = new GrpcAdminAuthz(identityGrpc, loadPlatformConfig(process.env).grpcLbProfile);

const database = createDatabase({ url, applicationName: SERVICE });
const partnerDatabase = createDatabase({ url: partnerUrl, applicationName: `${SERVICE}-partner`, max: PARTNER_POOL_MAX });
// 소유자 주소를 넣거나 역할을 겸하면 행 보안이 조용히 꺼지므로 시작하지 않는다(ADR-0241)
await assertDatabaseRole(database, 'core_app');
await assertDatabaseRole(partnerDatabase, 'core_partner');
const service = await createService({ name: SERVICE, adminAuthz, module: AppModule.register({ database, partnerDatabase }) });
await service.listen();

process.once('SIGTERM', () => {
  // 받는 요청을 먼저 마치고 identity 채널과 DB 연결을 닫는다
  void service
    .close()
    .catch((err: unknown) => service.logger.error({ err }, 'core-svc 종료 실패'))
    .finally(() => {
      adminAuthz.close();
      return Promise.all([database.close(), partnerDatabase.close()]);
    });
});
