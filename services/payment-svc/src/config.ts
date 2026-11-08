// payment-svc 설정 읽기(BUILD_ORDER PRF-180). 값은 docs/verification.md §4.1 'payment-svc 승인 명령 접수 쓰기와 결과 당기기 서버의 DB 연결'과 맞춘다.

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

function grpcPortOf(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PAYMENT_GRPC_PORT;
  const port = Number(raw);
  if (!/^[0-9]+$/.test(raw) || port < 1 || port > 65_535) throw new Error(`PEAKET_GRPC_PORT가 틀렸다: ${raw}`);
  return port;
}
