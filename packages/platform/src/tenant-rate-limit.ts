// 파트너 API 테넌트당 600회/분 공용 가드(BAT-173, D-T50 ⑦, docs/api/guidelines.md §6).
// - 토큰에 테넌트가 없어(ADR-0172) 게이트웨이는 계정당 600회/분만 센다. 테넌트 합계는 파트너 역할을 판정한 서비스가
//   세션·캐시 Redis의 `rl:tenant:{tenantId}` 키 하나에 센다. 모든 서비스·파드가 같은 키를 본다.
// - 첫 요청에 60초 수명을 걸고 그 창 안에서 센다. `INCR`와 `PEXPIRE`를 Lua 한 번으로 해 TTL 없는 키를 만들지 않는다.
// - 600 이하는 통과, 601번째부터 429다. 판정 시간은 20ms [가정]이고 넘거나 Redis가 실패하면 세지 않고 통과한다(열림,
//   docs/architecture.md §4의 전역 레이트 리밋과 같은 원칙). 열림은 `tenant_rate_limit_total{result="unavailable"}`로 센다.
import { type HotRedis, redisScript } from './redis.js';

/** 테넌트당 1분 한도(600회, docs/api/guidelines.md §6) */
export const TENANT_RATE_LIMIT_PER_MINUTE = 600;
/** 고정 창 길이(60초) */
export const TENANT_RATE_LIMIT_WINDOW_MS = 60_000;
/** 판정 시간 상한 [가정](넘으면 세지 않고 통과, docs/architecture.md §4) */
export const TENANT_RATE_LIMIT_TIMEOUT_MS = 20;
/**
 * 테넌트 한도 카운터가 붙는 세션·캐시 Redis 주소 환경 값(BAT-173 리뷰 RV-01).
 * 재인증 jti Redis(`PEAKET_REAUTH_REDIS_URL`)는 서비스마다 다른 Redis일 수 있어 이 값을 따로 받는다.
 */
export const TENANT_RATE_LIMIT_REDIS_URL_ENV = 'PEAKET_TENANT_REDIS_URL';

export interface TenantRateLimitRedisUrlOptions {
  /**
   * `PEAKET_TENANT_REDIS_URL`이 없을 때 local·ci에서만 쓰는 대역 주소.
   * 그 서비스가 이미 만드는 세션·캐시 Redis(예: ops·payment의 재인증 Redis)를 넘긴다.
   */
  fallbackUrl?: string;
}

/**
 * 테넌트 한도 Redis 주소를 고른다(BAT-173 리뷰 RV-01).
 * - `PEAKET_TENANT_REDIS_URL`이 있으면 그 주소다. 다섯 서비스가 같은 세션·캐시 클러스터를 보게 하는 값이다.
 * - staging·prod·demo에서 없으면 시작 실패다. 서비스별 재인증 Redis로 대신하면 `rl:tenant:*`가 쪼개진다.
 * - local·ci만 `fallbackUrl`로 닫힌 대역을 쓴다. 둘 다 없으면 `undefined`이고 가드를 만들지 않는다(시험·개발).
 */
export function tenantRateLimitRedisUrlFromEnv(env: Record<string, string | undefined>, o: TenantRateLimitRedisUrlOptions = {}): string | undefined {
  const url = env[TENANT_RATE_LIMIT_REDIS_URL_ENV]?.trim();
  if (url) return url;
  if (env.PEAKET_ENV === 'local' || env.PEAKET_ENV === 'ci') return o.fallbackUrl?.trim() || undefined;
  throw new Error(
    `${TENANT_RATE_LIMIT_REDIS_URL_ENV}이 없다(파트너 테넌트 한도 카운터는 다섯 서비스가 같은 세션·캐시 Redis를 봐야 한다. 재인증 Redis로 대신하지 않는다. staging·prod·demo는 비밀 관리에서 넣는다)`,
  );
}

/** 판정 결과(지표 `tenant_rate_limit_total{result}`의 고정 값, docs/observability.md §3) */
export type TenantRateLimitResult = 'allowed' | 'limited' | 'unavailable';

/** 가드가 처리기에 넘기는 판정. `allowed=false`면 429와 `Retry-After: retryAfterSeconds`다 */
export interface TenantRateLimitAnswer {
  allowed: boolean;
  /** 429일 때 남은 창의 초(올림, 1 이상). 통과면 0 */
  retryAfterSeconds: number;
}

/** 파트너 테넌트 한도 포트. 테넌트 ID는 identity가 준 값만 쓴다(클라이언트 머리·본문은 믿지 않는다, ADR-0172) */
export interface TenantRateLimitPort {
  check(tenantId: string): Promise<TenantRateLimitAnswer>;
}

/** 테넌트 한도 키. 게이트웨이의 `rl:{scope}:{key}`와 같은 접두사지만 `tenant` 자리는 게이트웨이에 없다 */
export function tenantRateLimitKey(tenantId: string): string {
  return `rl:tenant:${tenantId}`;
}

/**
 * 한 번의 왕복으로 증가·수명·남은 시간을 함께 본다. 첫 증가와 TTL 없는 키를 같은 원자 연산에서 고쳐,
 * `INCR`와 `PEXPIRE` 사이에 죽어 TTL 없는 키가 남는 일을 막는다(M7).
 */
const TENANT_RATE_LIMIT_SCRIPT = redisScript(`
local n = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {n, ttl}
`);

export interface RedisTenantRateLimiterOptions {
  redis: Pick<HotRedis, 'evalScript'>;
  /** 기본 600 */
  limit?: number;
  /** 기본 60,000ms */
  windowMs?: number;
  /** 기본 20ms [가정]. 넘으면 세지 않고 통과한다 */
  timeoutMs?: number;
  /** 판정 결과마다 한 번. 서비스가 `tenant_rate_limit_total{service,result}`에 잇는다 */
  onResult?: (result: TenantRateLimitResult) => void;
}

/** Lua 답 `{n, pttl}`을 읽는다. 모양이 다르면 판정 실패로 본다 */
function countAndTtlOf(reply: unknown): { count: number; ttlMs: number } | undefined {
  if (!Array.isArray(reply) || reply.length < 2) return undefined;
  const count = Number(reply[0]);
  const ttlMs = Number(reply[1]);
  if (!Number.isSafeInteger(count) || !Number.isFinite(ttlMs)) return undefined;
  if (count < 0) return undefined;
  return { count, ttlMs };
}

/**
 * 세션·캐시 Redis 위의 테넌트 한도 판정. Redis 마감 초과·연결 오류·스크립트 오류·답 모양 오류는 모두 열림으로 바꾸고
 * `unavailable`을 센다(5xx로 닫지 않는다. Redis 장애가 파트너 API 전체 장애가 되지 않게).
 */
export function redisTenantRateLimiter(o: RedisTenantRateLimiterOptions): TenantRateLimitPort {
  const limit = o.limit ?? TENANT_RATE_LIMIT_PER_MINUTE;
  const windowMs = o.windowMs ?? TENANT_RATE_LIMIT_WINDOW_MS;
  const timeoutMs = o.timeoutMs ?? TENANT_RATE_LIMIT_TIMEOUT_MS;
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  return {
    async check(tenantId: string): Promise<TenantRateLimitAnswer> {
      // 빈 값은 부르는 쪽(AuthGuard)이 이미 거른다. 그래도 키를 만들지 않고 통과시킨다
      if (tenantId.length === 0) return { allowed: true, retryAfterSeconds: 0 };
      const key = tenantRateLimitKey(tenantId);
      let got: { count: number; ttlMs: number } | undefined;
      try {
        const reply = await o.redis.evalScript(TENANT_RATE_LIMIT_SCRIPT, [key], [String(windowMs)], { deadlineMs: timeoutMs });
        got = countAndTtlOf(reply);
      } catch {
        got = undefined;
      }
      if (!got) {
        o.onResult?.('unavailable');
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (got.count <= limit) {
        o.onResult?.('allowed');
        return { allowed: true, retryAfterSeconds: 0 };
      }
      // PTTL이 -2(키 없음)여도 429는 남은 창의 초를 1 이상으로 준다. 창 길이를 넘겨 주지 않는다(M10)
      const retryAfterSeconds = Math.min(windowSeconds, Math.max(1, Math.ceil(Math.max(0, got.ttlMs) / 1000)));
      o.onResult?.('limited');
      return { allowed: false, retryAfterSeconds };
    },
  };
}
