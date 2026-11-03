// v0 입구의 IP 기반 레이트 리밋(K6의 v0, docs/infra.md §3 'v0 배포' 5, ASVS v5.0.0-2.4.1).
// 클라이언트 IP마다 토큰 버킷 하나: 초당 ratePerSecond개를 채우고 최대 burst개까지 모은다. 요청 하나가 토큰 하나를 쓴다.
// 버킷 표는 최근에 쓴 IP maxKeys개까지 두고, 넘으면 가장 오래 쓰지 않은 IP부터 지운다(지운 IP는 다음 요청에 가득 찬 버킷으로 다시 시작).
// 시각은 주입한 시계의 단조 시계(monotonicMs)로 센다.
import type { Clock } from '@peaket/platform';

export const RATE_LIMIT_DEFAULTS = { ratePerSecond: 10, burst: 20, maxKeys: 100_000 } as const;

export interface RateLimitOptions {
  /** 초당 채우는 토큰 수(양수) */
  ratePerSecond: number;
  /** 버킷에 모을 수 있는 최대 토큰 수(1 이상 정수). 새 IP는 가득 찬 버킷으로 시작한다 */
  burst: number;
  /** 버킷 표에 둘 IP 수의 상한(1 이상 정수) */
  maxKeys: number;
  clock: Clock;
}

export interface RateDecision {
  allowed: boolean;
  /** 거절이면 다음 토큰이 찰 때까지의 초(올림, 1 이상). 통과면 0 */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  /** 마지막으로 채운 단조 시각(ms) */
  at: number;
}

/** 부동소수 오차로 토큰 하나가 0.9999…로 남는 것을 막는 여유 */
const EPSILON = 1e-9;

export class IpRateLimiter {
  readonly #ratePerMs: number;
  readonly #ratePerSecond: number;
  readonly #burst: number;
  readonly #maxKeys: number;
  readonly #clock: Clock;
  /** Map은 넣은 차례를 지킨다. 쓸 때마다 지웠다 다시 넣어 맨 앞이 가장 오래 쓰지 않은 IP가 된다 */
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: RateLimitOptions) {
    const { ratePerSecond, burst, maxKeys } = options;
    if (!(Number.isFinite(ratePerSecond) && ratePerSecond > 0)) throw new RangeError('ratePerSecond는 양수여야 한다');
    if (!(Number.isInteger(burst) && burst >= 1)) throw new RangeError('burst는 1 이상 정수여야 한다');
    if (!(Number.isInteger(maxKeys) && maxKeys >= 1)) throw new RangeError('maxKeys는 1 이상 정수여야 한다');
    this.#ratePerSecond = ratePerSecond;
    this.#ratePerMs = ratePerSecond / 1000;
    this.#burst = burst;
    this.#maxKeys = maxKeys;
    this.#clock = options.clock;
  }

  /** 그 IP의 토큰 하나를 쓴다. 모자라면 쓰지 않고 거절한다 */
  take(ip: string): RateDecision {
    const now = this.#clock.monotonicMs();
    let bucket = this.#buckets.get(ip);
    if (bucket) {
      this.#buckets.delete(ip);
      const elapsed = Math.max(0, now - bucket.at);
      bucket.tokens = Math.min(this.#burst, bucket.tokens + elapsed * this.#ratePerMs);
      bucket.at = now;
    } else {
      bucket = { tokens: this.#burst, at: now };
    }
    this.#buckets.set(ip, bucket);
    while (this.#buckets.size > this.#maxKeys) {
      const oldest = this.#buckets.keys().next();
      if (oldest.done) break;
      this.#buckets.delete(oldest.value);
    }
    if (bucket.tokens + EPSILON >= 1) {
      bucket.tokens = Math.max(0, bucket.tokens - 1);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const waitSeconds = (1 - bucket.tokens) / this.#ratePerSecond;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitSeconds - EPSILON)) };
  }

  /** 지금 버킷 표에 있는 IP 수 */
  get size(): number {
    return this.#buckets.size;
  }
}
