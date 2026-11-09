// 쓰임새: 새 결제 일시 정지 조회(gRPC GetNewPaymentPause, ADR-0085·0105, docs/features/payment.md §2 '새 결제 일시 정지 읽기의 첫 구현', BUILD_ORDER PRF-201). 결제사를 부르지 않고 쓰기가 없다.
// 회차 목록의 선택 재료를 한 번에 읽어 회차마다 결제사를 선택 순서로 정하고, 그 결제사가 정지거나 채널이 없거나 비활성인 회차만 돌려준다. 읽지 못하면 호출 전체가 실패한다(일부를 '열림'으로 답하면 멈춘 홀드가 풀린다).
import { MIN_CALL_REMAINING_MS, PaymentDeadlineError } from '../domain/confirm-command.js';
import { eventPausedSinceMs, parseGetPauseEventIds } from '../domain/entry-pause.js';
import type { PgChannelTable, PgPlatformDefaults } from '../domain/pg-selection.js';
import type { CallBudget, EntryPauseReader, PgSelectionBatchReader } from '../domain/ports.js';

export interface GetNewPaymentPauseDeps {
  readonly selection: PgSelectionBatchReader;
  readonly pauses: EntryPauseReader;
  readonly channels: PgChannelTable;
  readonly defaults: PgPlatformDefaults;
}

/** 일시 정지 중인 회차 하나 */
export interface EventPaymentPause {
  readonly eventId: string;
  /** 정지 시작 시각(ms). 채널이 없거나 비활성이면 0 */
  readonly pausedSinceMs: number;
}

export class GetNewPaymentPause {
  constructor(private readonly deps: GetNewPaymentPauseDeps) {}

  /**
   * @param eventIds 회차 ID 1~200개 [가정]의 소문자 UUID
   * @returns 일시 정지 중인 회차만(요청 차례)
   * @throws PaymentInputError 입력이 틀림 · PaymentDeadlineError 남은 시간이 모자람 · 저장소 오류(읽지 못하면 호출 전체가 실패한다)
   */
  async execute(eventIds: readonly string[], budget?: CallBudget): Promise<EventPaymentPause[]> {
    const { selection, pauses: pauseReader, channels, defaults } = this.deps;
    const ids = parseGetPauseEventIds(eventIds);
    const startedAt = performance.now();
    const pauses = await pauseReader.read(budget);
    const left = budget === undefined ? undefined : { remainingMs: budget.remainingMs - (performance.now() - startedAt) };
    if (left !== undefined && left.remainingMs < MIN_CALL_REMAINING_MS) throw new PaymentDeadlineError();
    const states = await selection.readMany(ids, left);
    const out: EventPaymentPause[] = [];
    for (const eventId of ids) {
      const pausedSinceMs = eventPausedSinceMs({ ...states.get(eventId)!, defaults, channels, pauses });
      if (pausedSinceMs !== undefined) out.push({ eventId, pausedSinceMs });
    }
    return out;
  }
}
