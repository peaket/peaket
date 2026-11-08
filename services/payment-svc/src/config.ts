// payment-svc 설정 읽기(BUILD_ORDER PRF-180). 값은 docs/verification.md §4.1 'payment-svc 승인 명령 접수 쓰기와 결과 당기기 서버의 DB 연결'과 맞춘다.
import type { SimulatorGatewayOptions } from './modules/payment/adapters/pg/simulator-gateway.js';

/** 업무 gRPC 포트 [가정](identity-svc와 같다. BUILD_ORDER BAS-080이 공용 설정으로 옮긴다) */
export const DEFAULT_PAYMENT_GRPC_PORT = 50051;
/** 파드마다 핫패스 풀 연결 16개 [가정](ConfirmPayment) */
export const PAYMENT_HOT_POOL_MAX = 16;
/** 파드마다 일반 풀 연결 4개 [가정](BatchGetPayments, applicationName payment-svc-batch) */
export const PAYMENT_BATCH_POOL_MAX = 4;
/** local·ci에서 PEAKET_PAYMENT_POD_COUNT가 비었을 때의 파드 수 1개 [가정] */
export const DEFAULT_PAYMENT_POD_COUNT = 1;
/** PEAKET_PAYMENT_POD_COUNT의 상한 1000 [가정](값을 잘못 넣어 파드당 상한이 0에 가까워지는 일을 막는다) */
export const MAX_PAYMENT_POD_COUNT = 1_000;

export interface PaymentServiceConfig {
  /** PEAKET_DATABASE_URL */
  readonly databaseUrl: string;
  /** PEAKET_GRPC_HOST(기본 0.0.0.0) */
  readonly grpcHost: string;
  /** PEAKET_GRPC_PORT(기본 DEFAULT_PAYMENT_GRPC_PORT) */
  readonly grpcPort: number;
}

/**
 * 환경 값을 읽는다.
 * @throws Error PEAKET_DATABASE_URL이 없음, PEAKET_GRPC_PORT가 1~65535 정수가 아님(시작 실패)
 */
export function loadPaymentServiceConfig(env: Record<string, string | undefined>): PaymentServiceConfig {
  const databaseUrl = env.PEAKET_DATABASE_URL;
  if (!databaseUrl) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');
  return { databaseUrl, grpcHost: env.PEAKET_GRPC_HOST ?? '0.0.0.0', grpcPort: grpcPortOf(env.PEAKET_GRPC_PORT) };
}

/**
 * 시뮬레이터 어댑터 설정을 읽는다(승인 실행기의 어댑터 등록부, BUILD_ORDER PRF-181). PEAKET_PG_SIM_URL·PEAKET_PG_SIM_SECRET_KEY·PEAKET_PG_SIM_CLIENT_KEY.
 * 주소가 없으면 환경을 가리지 않고 undefined(어댑터 없이 켠다). 지금은 시뮬레이터가 유일한 어댑터라 운영 값이 없다. 시작 때 경고 한 줄과 no_adapter 지표가 드러낸다.
 * 토스 어댑터가 생기면 local·ci 밖은 어댑터 하나 이상을 시작 조건으로 한다(BUILD_ORDER PRF-184).
 * @throws Error 주소가 쿼리·조각·사용자 정보가 없는 http(s) 주소가 아님, 주소가 있는데 키가 없음(시작 실패). 글에 주소 값을 싣지 않는다
 */
export function loadSimulatorGatewayConfig(env: Record<string, string | undefined>): SimulatorGatewayOptions | undefined {
  const baseUrl = env.PEAKET_PG_SIM_URL?.trim();
  if (!baseUrl) return undefined;
  assertSimulatorUrl(baseUrl);
  const secretKey = env.PEAKET_PG_SIM_SECRET_KEY;
  if (!secretKey) throw new Error('PEAKET_PG_SIM_SECRET_KEY가 없다(PEAKET_PG_SIM_URL이 있으면 있어야 한다)');
  const clientKey = env.PEAKET_PG_SIM_CLIENT_KEY;
  if (!clientKey) throw new Error('PEAKET_PG_SIM_CLIENT_KEY가 없다(PEAKET_PG_SIM_URL이 있으면 있어야 한다)');
  return { baseUrl, secretKey, clientKey };
}

export interface PgCallGuardConfig {
  /** PEAKET_PAYMENT_POD_COUNT: 그 서비스의 최대 복제 수(local·ci에서 비면 1 [가정]) */
  readonly podCount: number;
}

/**
 * 결제사 호출 보호 설정을 읽는다(BUILD_ORDER PRF-183). 파드 수를 1로 잘못 보면 결제사 상한을 파드 수 배로 넘기므로 local·ci 밖에서는 반드시 받는다.
 * @throws Error local·ci 밖에서 PEAKET_PAYMENT_POD_COUNT가 비어 있음, 1~MAX_PAYMENT_POD_COUNT의 정수가 아님(시작 실패)
 */
export function loadPgCallGuardConfig(env: Record<string, string | undefined>): PgCallGuardConfig {
  const raw = env.PEAKET_PAYMENT_POD_COUNT?.trim();
  if (!raw) {
    if (env.PEAKET_ENV === 'local' || env.PEAKET_ENV === 'ci') return { podCount: DEFAULT_PAYMENT_POD_COUNT };
    throw new Error('PEAKET_PAYMENT_POD_COUNT가 없다(local·ci 밖에서는 그 서비스의 최대 복제 수를 넣는다)');
  }
  const podCount = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(podCount) || podCount < 1 || podCount > MAX_PAYMENT_POD_COUNT) throw new Error(`PEAKET_PAYMENT_POD_COUNT가 1~${MAX_PAYMENT_POD_COUNT}의 정수가 아니다: ${raw}`);
  return { podCount };
}

/** 외부 호출 클라이언트가 받는 주소 모양인지 본다(잘못된 주소가 듣기 시작한 뒤에 드러나지 않게). 값에 비밀번호가 있을 수 있어 글에 싣지 않는다 */
function assertSimulatorUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PEAKET_PG_SIM_URL이 URL이 아니다');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.search || url.hash || url.username || url.password) {
    throw new Error('PEAKET_PG_SIM_URL은 쿼리·조각·사용자 정보가 없는 http(s) 주소여야 한다');
  }
}

function grpcPortOf(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PAYMENT_GRPC_PORT;
  const port = Number(raw);
  if (!/^[0-9]+$/.test(raw) || port < 1 || port > 65_535) throw new Error(`PEAKET_GRPC_PORT가 틀렸다: ${raw}`);
  return port;
}
