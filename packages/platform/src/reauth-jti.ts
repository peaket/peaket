// 재인증 토큰 jti의 1회용 기록(SEC-03). 같은 재인증 토큰을 5분 안에 두 번 쓰지 못하게 한다.
// Redis `SET NX PX`로 원자적으로 선점하고, Redis가 없거나 실패하면 닫힌 쪽(사용 불가)으로 본다.
import type { HotRedis } from './redis.js';

/** 재인증 토큰 jti를 기억하는 시간(5분). 토큰 자체 수명이 더 짧으면 부르는 쪽이 줄인다 */
export const REAUTH_JTI_TTL_MS = 5 * 60_000;

export interface ReauthJtiStore {
  /** 처음 쓰는 jti면 true, 이미 쓴 jti면 false. 저장소를 쓸 수 없으면 던진다 */
  claim(jti: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
}

/** 시험·로컬용. 프로세스가 죽으면 기록도 사라진다 */
export class MemoryReauthJtiStore implements ReauthJtiStore {
  readonly #until = new Map<string, number>();

  async claim(jti: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    const prev = this.#until.get(jti);
    if (prev !== undefined && prev > nowMs) return false;
    this.#until.set(jti, Math.min(nowMs + REAUTH_JTI_TTL_MS, expiresAtMs));
    return true;
  }
}

/** Redis 기반. 키 `reauth:jti:{jti}`를 NX PX로 잡는다 */
export class RedisReauthJtiStore implements ReauthJtiStore {
  constructor(private readonly redis: Pick<HotRedis, 'command'>) {}

  async claim(jti: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    const ttl = Math.max(1, Math.min(REAUTH_JTI_TTL_MS, expiresAtMs - nowMs));
    const key = `reauth:jti:${jti}`;
    const r = await this.redis.command(['SET', key, '1', 'NX', 'PX', String(ttl)], { key });
    return r === 'OK';
  }
}

/** Redis가 없을 때. 재인증이 필요한 작업을 닫는다 */
export class UnavailableReauthJtiStore implements ReauthJtiStore {
  async claim(): Promise<boolean> {
    throw new Error('재인증 jti 저장소(Redis)가 없다');
  }
}
