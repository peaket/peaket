// 일괄 환불의 결제사별 토큰 버킷(F-07-8 I-07, transfer-refund §5 '토큰 버킷의 값', ADR-0069 결정 10, R-T52).
// 결제사 몫마다 초당 ratePerSecond건, 최대 burst건 [가정 300·300]이다. 시각 t초까지 누적 burst + ⌊rate × t⌋건을 넘지 않는다.
// 한 결제사의 take는 차례대로 줄을 선다(먼저 부른 쪽이 먼저 나간다). 토큰이 모자라면 미리 한 장을 빌려 두고(남은 수가 0 아래) 그만큼 기다린다.
// 기다리기 전에 이벤트 루프를 한 번 돌려 앞서 토큰을 받은 쪽이 결제사 호출을 먼저 시작하게 한다(앞 쪽의 호출 시각이 뒤 쪽의 기다림에 밀리지 않게).
// 기다림은 결제사 호출이 아니다(시도 기록·실패율·연속 실패에 들지 않는다). 버킷은 프로세스마다 따로다(C-01).
import type { RefundPgProvider } from './event-refund.js';

/** 버킷이 읽는 시계(벽시계 ms). 도메인은 플랫폼 시계를 모르므로 이 모양만 받는다(@peaket/platform Clock과 맞는다) */
export interface BucketClock {
  now(): number;
}

/** 결제사 몫마다 초당 300건·최대 300건 [가정](transfer-refund §5 '토큰 버킷의 값') */
export const EVENT_REFUND_PG_RATE_DEFAULT = 300;

export interface PgTokenBucketsOptions {
  readonly ratePerSecond: number;
  readonly burst: number;
  readonly clock: BucketClock;
  /** 기다림. 없으면 setTimeout이다(시험은 가짜 시계를 미는 대역을 넘긴다) */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Bucket {
  /** 남은 토큰. 기다리는 쪽이 미리 빌려 0 아래가 될 수 있다 */
  tokens: number;
  /** 마지막으로 채운 시각(ms) */
  atMs: number;
  /** 줄의 끝(앞 take가 끝나야 다음 take가 셈한다) */
  tail: Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** 이벤트 루프를 한 바퀴 돌린다(앞 쪽이 결제사 호출을 시작할 틈) */
const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 설정 PEAKET_EVENT_REFUND_PG_RATE(초당·최대 같은 값, 양의 정수). 없거나 틀리면 기본값 300 [가정] */
export function eventRefundPgRateOf(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : EVENT_REFUND_PG_RATE_DEFAULT;
}

export class PgTokenBuckets {
  readonly #rate: number;
  readonly #burst: number;
  readonly #clock: BucketClock;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #buckets = new Map<RefundPgProvider, Bucket>();

  constructor(o: PgTokenBucketsOptions) {
    if (!(o.ratePerSecond > 0) || !(o.burst >= 1)) throw new Error('토큰 버킷의 초당 수와 최대 수는 양수여야 한다');
    this.#rate = o.ratePerSecond;
    this.#burst = o.burst;
    this.#clock = o.clock;
    this.#sleep = o.sleep ?? defaultSleep;
  }

  /** 지금 쓸 수 있는 토큰 수(소수). 쓰지 않는다 */
  available(pg: RefundPgProvider): number {
    const b = this.#bucket(pg);
    this.#refill(b);
    return Math.max(0, b.tokens);
  }

  /** 그 결제사 몫의 토큰 한 장을 받는다. 모자라면 생길 때까지 기다린다 */
  take(pg: RefundPgProvider): Promise<void> {
    const b = this.#bucket(pg);
    const mine = b.tail.then(() => this.#takeNow(b));
    b.tail = mine.catch(() => undefined);
    return mine;
  }

  async #takeNow(b: Bucket): Promise<void> {
    this.#refill(b);
    b.tokens -= 1;
    if (b.tokens >= 0) return;
    // 빌린 한 장이 찰 때까지 기다린다. 기다리기 전에 앞 쪽이 호출을 시작하게 한 바퀴 비켜 준다
    await yieldTurn();
    this.#refill(b);
    if (b.tokens >= 0) return;
    await this.#sleep((-b.tokens * 1000) / this.#rate);
    this.#refill(b);
  }

  #bucket(pg: RefundPgProvider): Bucket {
    let b = this.#buckets.get(pg);
    if (!b) {
      b = { tokens: this.#burst, atMs: this.#clock.now(), tail: Promise.resolve() };
      this.#buckets.set(pg, b);
    }
    return b;
  }

  #refill(b: Bucket): void {
    const now = this.#clock.now();
    if (now <= b.atMs) return;
    b.tokens = Math.min(this.#burst, b.tokens + ((now - b.atMs) * this.#rate) / 1000);
    b.atMs = now;
  }
}
