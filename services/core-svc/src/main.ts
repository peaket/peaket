// 서비스 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
import { createDatabase, createService, loadPlatformConfig } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { assertDatabaseRole, GrpcAdminAuthz, GrpcImageProcessing, GrpcSeatmapParser, LocalFolderImageStore } from './modules/catalog/index.js';

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
const lbProfile = loadPlatformConfig(process.env).grpcLbProfile;
const adminAuthz = new GrpcAdminAuthz(identityGrpc, lbProfile);

// 공연 이미지·좌석맵 가져오기의 바깥 잇기(ADR-0257). 하나라도 없으면 시작하지 않는다(대역으로 통과시키지 않는다).
// 개발 실행: image-worker(HOT-200)가 생기기 전에는 ImageService 대역 gRPC 서버를, 좌석맵은 node dist/seatmap-worker/main.js를 띄워 주소를 넣는다.
// 이미지는 PEAKET_IMAGE_STORE_DIR 폴더의 quarantine/·staging/·public/에 둔다(S3 어댑터는 HOT-200). 대역은 같은 폴더를 읽고 쓴다
const need = (name: string, what: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name}이 없다(${what})`);
  return v;
};
const imageGrpc = need('PEAKET_IMAGE_GRPC_URL', 'image-worker ImageService host:port');
const seatmapGrpc = need('PEAKET_SEATMAP_GRPC_URL', 'seatmap-worker SeatmapImportService host:port');
const imageOrigin = need('PEAKET_IMAGE_BASE_URL', '이미지 출처, 운영 https://img.peaket.example');
if (!/^https?:\/\/[^/?#]+$/.test(imageOrigin)) throw new Error(`PEAKET_IMAGE_BASE_URL은 경로 없는 출처여야 한다: ${imageOrigin}`);
const imageStoreDir = need('PEAKET_IMAGE_STORE_DIR', '개발용 이미지 폴더. S3 어댑터는 HOT-200');
const imageProcessing = new GrpcImageProcessing(imageGrpc, lbProfile);
const seatmapParser = new GrpcSeatmapParser(seatmapGrpc, lbProfile);

const database = createDatabase({ url, applicationName: SERVICE });
const partnerDatabase = createDatabase({ url: partnerUrl, applicationName: `${SERVICE}-partner`, max: PARTNER_POOL_MAX });
// 소유자 주소를 넣거나 역할을 겸하면 행 보안이 조용히 꺼지므로 시작하지 않는다(ADR-0241)
await assertDatabaseRole(database, 'core_app');
await assertDatabaseRole(partnerDatabase, 'core_partner');
/** 요청 하나(머리·본문)를 다 받는 시한 [가정]: 천천히 보내는 연결이 올리기 버퍼와 칸막이 자리를 오래 쥐지 않게(ADR-0257 결정 2) */
const REQUEST_TIMEOUT_MS = 100_000;
const service = await createService({
  name: SERVICE,
  adminAuthz,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  module: AppModule.register({ database, partnerDatabase, media: { imageOrigin, processing: imageProcessing, store: new LocalFolderImageStore(imageStoreDir), seatmap: seatmapParser } }),
});
await service.listen();

process.once('SIGTERM', () => {
  // 받는 요청을 먼저 마치고 identity 채널과 DB 연결을 닫는다
  void service
    .close()
    .catch((err: unknown) => service.logger.error({ err }, 'core-svc 종료 실패'))
    .finally(() => {
      adminAuthz.close();
      imageProcessing.close();
      seatmapParser.close();
      return Promise.all([database.close(), partnerDatabase.close()]);
    });
});
