// 경고 로그 문(추천 적용 2026-11-04 L6·C3): 같은 경고를 간격 안에 한 번만 남기게 한다. 메모리 부족 경고(파드마다 1초에 한 줄)와 회차 목록의 모양이 틀린 값을 거른
// 경고(파드마다 60초에 한 줄)가 쓴다. 도메인 층이라 플랫폼 Clock 형을 가져오지 않고 벽시계 now()만 요구한다(플랫폼 Clock이 그대로 맞는다).
// 받는 층(HoldsController)과 만료 반복(ExpirySweeper)은 application/log-gate.ts로 같은 문을 나눈다.
import { OOM_WARN_INTERVAL_MS } from './expiry.js';

/** 문이 보는 시계: 벽시계 now()(epoch ms) */
export interface WallClock {
  now(): number;
}

/** 간격 안에 한 번만 열리는 문 */
export class LogGate {
  #last = Number.NEGATIVE_INFINITY;

  /**
   * @param clock 주입 시계(벽시계 now())
   * @param intervalMs 최소 간격(기본 OOM_WARN_INTERVAL_MS 1000)
   */
  constructor(
    private readonly clock: WallClock,
    private readonly intervalMs = OOM_WARN_INTERVAL_MS,
  ) {}

  /** 마지막으로 열린 때부터 intervalMs 이상 지났으면 열고(true) 그 시각을 적는다. 아니면 false. 처음은 늘 true다 */
  allow(): boolean {
    const now = this.clock.now();
    if (now - this.#last < this.intervalMs) return false;
    this.#last = now;
    return true;
  }
}
