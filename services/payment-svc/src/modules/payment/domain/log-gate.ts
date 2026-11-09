// 경고 로그 문(purchase-svc inventory·booking의 domain/log-gate.ts와 같은 꼴. 서비스끼리 도메인을 가져오지 않아 따로 둔다): 같은 줄을 간격 안에 한 번만 남기게 한다.
// 웹훅 거절 줄(파드마다 1분에 한 줄 [가정], BUILD_ORDER HOT-150 코드 리뷰)이 쓴다. 도메인 층이라 플랫폼 Clock 형을 가져오지 않고 벽시계 now()만 요구한다.

/** 문이 보는 시계: 벽시계 now()(epoch ms) */
export interface WallClock {
  now(): number;
}

/** 간격 안에 한 번만 열리는 문 */
export class LogGate {
  #last = Number.NEGATIVE_INFINITY;

  /**
   * @param clock 주입 시계(벽시계 now())
   * @param intervalMs 최소 간격
   */
  constructor(
    private readonly clock: WallClock,
    private readonly intervalMs: number,
  ) {}

  /** 마지막으로 열린 때부터 intervalMs 이상 지났으면 열고(true) 그 시각을 적는다. 아니면 false. 처음은 늘 true다 */
  allow(): boolean {
    const now = this.clock.now();
    if (now - this.#last < this.intervalMs) return false;
    this.#last = now;
    return true;
  }
}
