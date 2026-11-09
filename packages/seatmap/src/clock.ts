// 좌석 연결의 시계 맞추기(docs/frontend.md §3.3·§4.4.1, ADR-0110, BUILD_ORDER HOT-100).
// TimeSync에 대한 하트비트로 왕복을 재고, 최근 표본 가운데 왕복이 가장 짧은 값을 쓴다. 시각은 보낼 때와 같은 시계(performance.now)로 넘긴다.

/** 기억하는 표본 수 [가정] */
export const CLOCK_SAMPLES = 8;

export class ClockSync {
  private samples: Array<{ rtt: number; offset: number }> = [];

  /** 하트비트 하나를 표본으로 받는다. TimeSync 응답이 아니거나(echo 0) 왕복이 음수면 버린다 */
  sample(serverTimeMs: number, echoClientTimeMs: number, receivedAt: number): void {
    if (echoClientTimeMs <= 0) return;
    const rtt = receivedAt - echoClientTimeMs;
    if (rtt < 0) return;
    this.samples.push({ rtt, offset: serverTimeMs + rtt / 2 - receivedAt });
    if (this.samples.length > CLOCK_SAMPLES) this.samples.shift();
  }

  /** 지금 시계 → 서버 시각의 차. 표본이 없으면 undefined */
  offset(): number | undefined {
    let best: { rtt: number; offset: number } | undefined;
    for (const s of this.samples) if (!best || s.rtt < best.rtt) best = s;
    return best?.offset;
  }

  toServer(clientMs: number): number | undefined {
    const o = this.offset();
    return o === undefined ? undefined : clientMs + o;
  }
}

/** seat_delta_e2e_ms = 그린 시각(보정 시계) − (serverTimeMs − maxWaitMs). 시계를 아직 못 맞췄으면 undefined(§3.3) */
export function deltaE2eMs(frame: { serverTimeMs: number; maxWaitMs: number }, drawnAtClient: number, clock: ClockSync): number | undefined {
  const drawn = clock.toServer(drawnAtClient);
  return drawn === undefined ? undefined : drawn - (frame.serverTimeMs - frame.maxWaitMs);
}
