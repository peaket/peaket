// ticket-svc 설정(BUILD_ORDER HOT-160). 값은 환경에서만 받는다.
export const DEFAULT_TICKET_GRPC_PORT = 50052;
export const TICKET_DB_POOL_MAX = 16;

export interface TicketServiceConfig {
  readonly databaseUrl: string;
  readonly grpcHost: string;
  readonly grpcPort: number;
  /** 스캐너 세션 확인·관제 역할 판정에 쓰는 identity gRPC 주소. 없으면 스캐너 경로는 503, 관제 경로는 401로 닫힌다 */
  readonly identityGrpcUrl?: string;
  /** 등록 코드·DPoP jti 저장소(운영 필수). 없으면 프로세스 메모리(파드 하나에서만 유효) */
  readonly redisUrl?: string;
}

export function loadTicketServiceConfig(env: Record<string, string | undefined>): TicketServiceConfig {
  const databaseUrl = env.PEAKET_DATABASE_URL;
  if (!databaseUrl) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 받는다)');
  const test = isTestEnv(env);
  const identityGrpcUrl = env.PEAKET_IDENTITY_GRPC_URL;
  const redisUrl = env.PEAKET_TICKET_REDIS_URL;
  // staging·prod에서 메모리 저장소로 떨어지면 파드마다 등록 코드·jti가 갈라져 재사용이 열린다. 시작을 막는다
  if (!test && !identityGrpcUrl) throw new Error('PEAKET_IDENTITY_GRPC_URL이 없다(스캐너 세션·관제 역할 판정에 필요하다)');
  if (!test && !redisUrl) throw new Error('PEAKET_TICKET_REDIS_URL이 없다(등록 코드·DPoP jti를 공유해야 한다)');
  return {
    databaseUrl,
    grpcHost: env.PEAKET_GRPC_HOST ?? '0.0.0.0',
    grpcPort: grpcPortOf(env.PEAKET_GRPC_PORT, test),
    ...(identityGrpcUrl ? { identityGrpcUrl } : {}),
    ...(redisUrl ? { redisUrl } : {}),
  };
}

function isTestEnv(env: Record<string, string | undefined>): boolean {
  const v = env.PEAKET_ENV;
  return v === undefined || v === 'local' || v === 'ci' || v === 'demo';
}

function grpcPortOf(raw: string | undefined, test: boolean): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TICKET_GRPC_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535 || (!test && n === 0)) throw new Error('PEAKET_GRPC_PORT가 올바르지 않다(1~65535, local·ci는 0=임의 포트)');
  return n;
}
