// F-06-6 GAT-250 대행사 초당 한도 토큰 버킷. 대행사 계약 값(ratePerSec)을 넘으면 대행사를 부르지 않고
// RETRYABLE로 돌려줘 워커가 다음 재시도 간격에 다시 집게 한다. 시계는 주입해 시험에서 기다리지 않는다.
export class RefillingRateLimiter {
  #tokens: number;
  #lastMs: number;

  constructor(private readonly o: { ratePerSec: number; clock: () => number }) {
    if (!Number.isInteger(o.ratePerSec) || o.ratePerSec <= 0) throw new Error('ratePerSec는 1 이상 정수여야 합니다');
    this.#tokens = o.ratePerSec;
    this.#lastMs = o.clock();
  }

  /** 1초 창에 ratePerSec개까지 true. 시간이 지나면 초당 ratePerSec 비율로 다시 채운다 */
  take(): boolean {
    const now = this.o.clock();
    const elapsed = Math.max(0, now - this.#lastMs);
    this.#lastMs = now;
    this.#tokens = Math.min(this.o.ratePerSec, this.#tokens + (elapsed * this.o.ratePerSec) / 1_000);
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
