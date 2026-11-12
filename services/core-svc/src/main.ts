// 서비스 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
import { fileURLToPath } from 'node:url';
import { createDatabase, createHotRedis, createService, loadLogPseudonymizer, loadPlatformConfig } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { assertDatabaseRole, GrpcAdminAuthz, GrpcImageProcessing, GrpcMemberCodeDirectory, GrpcSeatmapParser, LocalFolderImageStore, LocalFolderPublicFileStore, QueueSaleEligibilityCopy, SaleEligibilityMetrics, StaticTemplateCatalog, UnwiredSaleEligibilityCopy } from './modules/catalog/index.js';

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
// 판매 자격 명단의 회원 코드 변환(identity MemberCodeService)도 같은 주소다(ADR-0261 결정 6). 서버(GAT-050) 전에는 UNIMPLEMENTED라 올리기가 503이다
const memberCodes = new GrpcMemberCodeDirectory(identityGrpc, lbProfile);
// 명단 사본을 대기열 Redis에 쓰는 어댑터(ADR-0261 결정 9, OPEN[33] (가)). 주소가 없으면 늘 실패하는 어댑터로 시작한다
const queueRedis = process.env.PEAKET_QUEUE_REDIS_URL ? await createHotRedis({ url: process.env.PEAKET_QUEUE_REDIS_URL }) : undefined;
const eligibilityCopy = queueRedis ? new QueueSaleEligibilityCopy(queueRedis) : new UnwiredSaleEligibilityCopy();
// 명단 감사 줄의 올린 계정은 로그 가명이다. 서비스 뼈대와 같은 키(PEAKET_LOG_PSEUDONYM_KEY)로 만들어 정규 로그 줄의 accountRef와 같은 값이 된다(ADR-0053 결정 1)
const { pseudonymizer: pseudonym } = loadLogPseudonymizer(process.env);
// 명단 운영 지표(올리기 결과·사본 넘기기 결과, docs/features/queue-admission.md §3 운영 확인 표)
const eligibilityMetrics = new SaleEligibilityMetrics();

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
// 팬 좌석맵 파일(v1/events/{회차}/seatmap-layouts/{판}.json)을 두는 폴더(ADR-0260 결정 6). 공개 위치는 public/, 재승인 대기 판의 준비 위치는 staging/ 아래이고
// 개발 서버는 public/만 정적 파일로 내준다. S3 어댑터는 HOT-200
const publicFileDir = need('PEAKET_PUBLIC_FILE_DIR', '개발용 팬 좌석맵 파일 폴더. S3 어댑터는 HOT-200');
const imageProcessing = new GrpcImageProcessing(imageGrpc, lbProfile);
const seatmapParser = new GrpcSeatmapParser(seatmapGrpc, lbProfile);
// 좌석맵 템플릿 10종은 배포 때 넣는 정적 JSON 파일이다(ADR-0066). 폴더가 없거나 파일이 틀리면 시작하지 않는다
const templateDir = process.env.PEAKET_SEATMAP_TEMPLATE_DIR ?? fileURLToPath(new URL('../seed/seatmap-templates/', import.meta.url));
const templates = StaticTemplateCatalog.load(templateDir);

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
  module: AppModule.register({
    database,
    partnerDatabase,
    media: { imageOrigin, processing: imageProcessing, store: new LocalFolderImageStore(imageStoreDir), seatmap: seatmapParser, publicFiles: new LocalFolderPublicFileStore(publicFileDir), memberCodes, eligibilityCopy, pseudonym, eligibilityMetrics, templates },
  }),
});
if (eligibilityCopy instanceof UnwiredSaleEligibilityCopy) eligibilityCopy.register(service.metrics.registry);
eligibilityMetrics.register(service.metrics.registry);
await service.listen();

process.once('SIGTERM', () => {
  // 받는 요청을 먼저 마치고 identity 채널과 DB 연결을 닫는다
  void service
    .close()
    .catch((err: unknown) => service.logger.error({ err }, 'core-svc 종료 실패'))
    .finally(() => {
      adminAuthz.close();
      memberCodes.close();
      imageProcessing.close();
      seatmapParser.close();
      void queueRedis?.close();
      return Promise.all([database.close(), partnerDatabase.close()]);
    });
});
