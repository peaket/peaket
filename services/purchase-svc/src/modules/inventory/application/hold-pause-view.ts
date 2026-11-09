// 새 결제 일시 정지 조회를 회차별 판단으로 바꾼다(docs/features/seat-hold.md §5 '정지 읽기'·'되돌리는 조건', BUILD_ORDER HOT-070·PRF-201, ADR-0085·ADR-0254 결정 5).
import type { Clock } from '@peaket/platform';
import { type EventPauseState, PAUSE_ANSWER_STALE_MS, PAUSE_OPEN_MIN_MS, PAUSE_READ_DEADLINE_MS, type PaymentPauseSource } from '../domain/hold-lifecycle.js';

export type PauseReadOutcome = 'ok' | 'stale' | 'failed';

export class HoldPauseView {
  /** 마지막으로 정지로 답한 회차 → 정지 시작 */
  readonly #paused = new Map<string, number>();
  /** 회차마다 연속 '열림' 답의 수 */
  readonly #openStreak = new Map<string, number>();
  /** 시작 시각을 모르는(0) 정지를 처음 본 시각 */
  readonly #firstSeen = new Map<string, number>();
  #answered = false;
  readonly #startedAt: number;
  /** 첫 '열림'을 본 시각(회차별). 연속 두 번이어도 이 시각에서 1초 [가정]가 지나야 되돌린다(L6) */
  readonly #firstOpenAt = new Map<string, number>();
  /** 연속 실패가 시작된 시각. 답을 받으면 지운다(L7) */
  #failingSince: number | undefined;

  constructor(
    private readonly source: PaymentPauseSource,
    private readonly clock: Clock,
    private readonly onRead?: (o: PauseReadOutcome) => void,
  ) {
    this.#startedAt = clock.now();
  }

  /** 이번 틱의 회차 판단을 돌려준다. 던지지 않는다 */
  async refresh(eventIds: readonly string[]): Promise<Map<string, EventPauseState>> {
    let answer;
    try {
      answer = eventIds.length > 0 ? await this.source.read(eventIds, { deadlineMs: PAUSE_READ_DEADLINE_MS }) : ({ status: 'OK', pauses: [] } as const);
    } catch {
      answer = { status: 'FAILED' } as const;
    }
    const now = this.clock.now();
    const out = new Map<string, EventPauseState>();
    if (answer.status === 'OK') {
      this.onRead?.('ok');
      this.#answered = true;
      this.#failingSince = undefined;
      const paused = new Map(answer.pauses.map((p) => [p.eventId, p.pausedSinceMs]));
      for (const id of eventIds) {
        const since = paused.get(id);
        if (since !== undefined) {
          this.#openStreak.set(id, 0);
          this.#firstOpenAt.delete(id);
          if (since === 0 && !this.#firstSeen.has(id)) this.#firstSeen.set(id, now);
          const at = since === 0 ? this.#firstSeen.get(id)! : since;
          this.#paused.set(id, at);
          out.set(id, { kind: 'PAUSED', sinceMs: at });
          continue;
        }
        this.#firstSeen.delete(id);
        const streak = (this.#openStreak.get(id) ?? 0) + 1;
        this.#openStreak.set(id, streak);
        if (!this.#firstOpenAt.has(id)) this.#firstOpenAt.set(id, now);
        if (streak >= 2 && now - this.#firstOpenAt.get(id)! >= PAUSE_OPEN_MIN_MS) {
          this.#paused.delete(id);
          out.set(id, { kind: 'OPEN' });
        } else {
          const last = this.#paused.get(id);
          out.set(id, last !== undefined ? { kind: 'PAUSED', sinceMs: last } : { kind: 'UNSETTLED' });
        }
      }
      return out;
    }
    // 조회 실패가 끼면 연속 열림을 처음부터 다시 센다(L6)
    // 답을 한 번도 못 받았으면 뜬 시각부터 잰다
    this.#failingSince ??= this.#answered ? now : this.#startedAt;
    const stale = now - this.#failingSince > PAUSE_ANSWER_STALE_MS;
    this.onRead?.(stale ? 'stale' : 'failed');
    this.#openStreak.clear();
    this.#firstOpenAt.clear();
    for (const id of eventIds) {
      if (stale) {
        this.#paused.delete(id);
        out.set(id, { kind: 'OPEN' });
      } else {
        const last = this.#paused.get(id);
        out.set(id, last !== undefined ? { kind: 'PAUSED', sinceMs: last } : { kind: 'UNSETTLED' });
      }
    }
    return out;
  }
}
