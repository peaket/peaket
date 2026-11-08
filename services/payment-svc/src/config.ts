// payment-svc 설정 읽기(BUILD_ORDER PRF-180). 값은 docs/verification.md §4.1 'payment-svc 승인 명령 접수 쓰기와 결과 당기기 서버의 DB 연결'과 맞춘다.
import type { SimulatorGatewayOptions } from './modules/payment/adapters/pg/simulator-gateway.js';

/** 업무 gRPC 포트 [가정](identity-svc와 같다. BUILD_ORDER BAS-080이 공용 설정으로 옮긴다) */
export const DEFAULT_PAYMENT_GRPC_PORT = 50051;
/** 파드마다 핫패스 풀 연결 16개 [가정](ConfirmPayment) */
export const PAYMENT_HOT_POOL_MAX = 16;
/** 파드마다 일반 풀 연결 4개 [가정](BatchGetPayments, applicationName payment-svc-batch) */
export const PAYMENT_BATCH_POOL_MAX = 4;

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
