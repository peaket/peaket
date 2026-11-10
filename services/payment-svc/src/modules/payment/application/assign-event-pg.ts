// 회차의 결제사 지정 쓰임새(명령 12, docs/features/payment.md §2.2 '회차별 지정'·'하위 결제사 검사의 첫 구현', BUILD_ORDER PRF-203).
// 하위 결제사 규칙에 걸린 지정은 이름 붙은 오류 pg-fallback-same-provider로 거절하고 표를 바꾸지 않는다. 지정 시각이 표의 값보다 늦을 때만 쓴다.
// 명령 12를 받아 이 쓰임새를 부르는 전송(core-svc 저장·설정 사건 소비자·dry-run·콘솔 422)은 OPS-290이다.
import { isLowerUuid, PaymentInputError } from '../domain/confirm-command.js';
import type { PgName } from '../domain/payment-gateway.js';
import { PgFallbackSameProviderError, type PortoneChannelMap, subProviderConflict } from '../domain/pg-sub-provider.js';
import type { EventPgAssignmentStore } from '../domain/ports.js';

const PG_NAMES: readonly string[] = ['TOSS', 'PORTONE', 'SIMULATOR'];

/** 받는 층이 넘기는 값(검사 전) */
export interface AssignEventPgInput {
  readonly eventId: string;
  readonly primary: string;
  readonly fallback?: string;
  /** 지정 시각(ms). 늦게 온 옛 지정이 새 지정을 덮지 않게 견준다 */
  readonly updatedAtMs: number;
}

export interface AssignEventPgDeps {
  readonly store: EventPgAssignmentStore;
  /** 설정의 포트원 채널 표(하위 결제사). 없으면 규칙이 보지 못한다(포트원 어댑터 없음) */
  readonly portone?: PortoneChannelMap;
}

export class AssignEventPg {
  constructor(private readonly deps: AssignEventPgDeps) {}

  /**
   * @returns written: 썼으면 true(표의 지정 시각이 같거나 더 늦으면 false)
   * @throws PaymentInputError 입력이 틀림(field) · PgFallbackSameProviderError 하위 결제사 규칙에 걸림(표는 그대로) · 저장소 오류
   */
  async execute(input: AssignEventPgInput): Promise<{ readonly written: boolean }> {
    if (!isLowerUuid(input.eventId)) throw new PaymentInputError('event_id');
    if (!PG_NAMES.includes(input.primary)) throw new PaymentInputError('primary');
    if (input.fallback !== undefined && (!PG_NAMES.includes(input.fallback) || input.fallback === input.primary)) throw new PaymentInputError('fallback');
    if (!Number.isSafeInteger(input.updatedAtMs) || input.updatedAtMs < 0) throw new PaymentInputError('updated_at');
    const primary = input.primary as PgName;
    const fallback = input.fallback as PgName | undefined;
    const conflict = subProviderConflict(primary, fallback, this.deps.portone);
    if (conflict !== undefined) throw new PgFallbackSameProviderError(conflict);
    const written = await this.deps.store.assignEvent({ eventId: input.eventId, primary, ...(fallback === undefined ? {} : { fallback }), updatedAtMs: input.updatedAtMs });
    return { written };
  }
}
