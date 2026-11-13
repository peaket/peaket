// ticket-svc 설정(BUILD_ORDER HOT-160). 값은 환경에서만 받는다.
export const DEFAULT_TICKET_GRPC_PORT = 50052;
export const TICKET_DB_POOL_MAX = 16;

export interface TicketServiceConfig {
  readonly databaseUrl: string;
  readonly grpcHost: string;
  readonly grpcPort: number;
}

export function loadTicketServiceConfig(env: Record<string, string | undefined>): TicketServiceConfig {
  const databaseUrl = env.PEAKET_DATABASE_URL;
  if (!databaseUrl) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 받는다)');
  return { databaseUrl, grpcHost: env.PEAKET_GRPC_HOST ?? '0.0.0.0', grpcPort: grpcPortOf(env.PEAKET_GRPC_PORT, isTestEnv(env)) };
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
