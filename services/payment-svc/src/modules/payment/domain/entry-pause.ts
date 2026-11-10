// 새 결제 일시 정지의 값과 규칙(docs/features/payment.md §2 '새 결제 일시 정지 읽기의 첫 구현'·§9, ADR-0085·0105, BUILD_ORDER PRF-201). 프레임워크·저장소를 모른다(순수 값과 함수).
import { isLowerUuid, PaymentInputError } from './confirm-command.js';
import type { PgName } from './payment-gateway.js';
import { basePgOf, type PgChannelTable, type PgPlatformDefaults, type PgSelectionState } from './pg-selection.js';

export type EntryPauseStage = 'OPEN' | 'PROBING' | 'TRIAL';
export type EntryPauseReason = 'PG_FAILURE' | 'CHANNEL_WAIT';

/** payment_entry_pause 한 행(지금은 channel = 'ALL'만 읽는다) */
export interface EntryPauseRow {
  readonly pg: PgName;
  readonly stage: EntryPauseStage;
  readonly reason: EntryPauseReason;
  /** 마지막으로 쓴 쪽. 사람이 푼 해제를 알아보는 데 쓴다(BUILD_ORDER PRF-202 코드 리뷰) */
  readonly actor?: string;
  readonly sinceMs: number;
  /** 마지막으로 모두 연 시각(epoch ms). 연 적이 없으면 없다 */
  readonly reopenedAtMs?: number;
  readonly version: number;
}

/** 결제사별 정지 행. 행이 없는 결제사는 열림이다 */
export type EntryPauses = ReadonlyMap<PgName, EntryPauseRow>;

/** GetNewPaymentPause가 받는 회차 수 상한 200개 [가정] */
export const GET_NEW_PAYMENT_PAUSE_MAX_EVENTS = 200;

/** 새 결제 일시 정지(gRPC FAILED_PRECONDITION, 글 new-payment-paused) */
export class PaymentNewPausedError extends Error {
  readonly code = 'FAILED_PRECONDITION' as const;
  constructor() {
    super('new-payment-paused');
    this.name = 'PaymentNewPausedError';
  }
}

/** 이 행이 새 결제를 막는가(행이 없거나 OPEN이면 아니다) */
export function isEntryPaused(row: EntryPauseRow | undefined): row is EntryPauseRow {
  return row !== undefined && row.stage !== 'OPEN';
}

/**
 * 한 회차의 정지 판단. 정지면 시작 시각(ms)을, 채널이 없거나 비활성이면 0을, 열려 있으면 undefined를 돌려준다.
 * 시험 재개도 정지다(ADR-0105). 채널 쪽 원인은 시작 시각이 정해지지 않아 0이다.
 */
export function eventPausedSinceMs(input: PgSelectionState & { readonly defaults: PgPlatformDefaults; readonly channels: PgChannelTable; readonly pauses: EntryPauses }): number | undefined {
  return pgPausedSinceMs(basePgOf(input), input.channels, input.pauses);
}

/** 그 결제사로 새 결제를 열면 새 결제 일시 정지와 같은 답인가: 정지면 시작 시각, 채널이 없거나 비활성이면 0, 열려 있으면 undefined */
export function pgPausedSinceMs(pg: PgName, channels: PgChannelTable, pauses: EntryPauses): number | undefined {
  const channel = channels.get(pg);
  if (channel === undefined || !channel.active) return 0;
  const row = pauses.get(pg);
  return isEntryPaused(row) ? row.sinceMs : undefined;
}

/**
 * GetNewPaymentPause 입력 검사.
 * @throws PaymentInputError 없거나, 상한을 넘거나, 소문자 UUID가 아님(field event_ids)
 */
export function parseGetPauseEventIds(eventIds: readonly string[]): string[] {
  if (eventIds.length === 0 || eventIds.length > GET_NEW_PAYMENT_PAUSE_MAX_EVENTS) throw new PaymentInputError('event_ids');
  if (!eventIds.every(isLowerUuid)) throw new PaymentInputError('event_ids');
  return [...eventIds];
}
