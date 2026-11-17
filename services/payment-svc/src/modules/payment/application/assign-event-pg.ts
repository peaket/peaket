// 회차의 결제사 지정 쓰임새(명령 12, docs/features/payment.md §2.2 '회차별 지정'·'하위 결제사 검사의 첫 구현', BUILD_ORDER PRF-203).
// 하위 결제사 규칙에 걸린 지정은 이름 붙은 오류 pg-fallback-same-provider로 거절하고 표를 바꾸지 않는다. 지정 시각이 표의 값보다 늦을 때만 쓴다.
// 지정 시각은 payment-svc 시계의 지금 + 5분 [가정] 이하여야 한다(경계 포함). 넘으면 입력 오류(updated_at)이고 하위 결제사 규칙보다 먼저 본다
// (W9-fix2, BAT-020 정리 PRF-203: 상한이 없으면 아주 먼 미래 시각 하나가 표에 남아 그 회차의 뒤 지정을 모두 조용히 막는다).
// 명령 12를 받아 이 쓰임새를 부르는 전송(core-svc 저장·설정 사건 소비자·dry-run·콘솔 422)은 OPS-290이다.
import type { Clock } from '@peaket/platform';
import { isLowerUuid, PaymentInputError } from '../domain/confirm-command.js';
import type { PgName } from '../domain/payment-gateway.js';
import { PgFallbackSameProviderError, type PortoneChannelMap, subProviderConflict } from '../domain/pg-sub-provider.js';
import type { EventPgAssignmentStore } from '../domain/ports.js';

const PG_NAMES: readonly string[] = ['TOSS', 'PORTONE', 'SIMULATOR'];

/** 지정 시각 상한의 여유 5분 [가정](파드와 core-svc 사이 시계 어긋남, docs/features/payment.md §2.2 '회차 지정(명령 12의 쓰임새)', W9-fix2 PRF-203) */
export const EVENT_PG_ASSIGN_MAX_SKEW_MS = 300_000;

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
  /** payment-svc 시계(지정 시각 상한 = 지금 + EVENT_PG_ASSIGN_MAX_SKEW_MS, docs/features/payment.md §2.2, W9-fix2 PRF-203) */
  readonly clock: Pick<Clock, 'now'>;
}

export class AssignEventPg {
  constructor(private readonly deps: AssignEventPgDeps) {}

  /**
   * @returns written: 썼으면 true(표의 지정 시각이 같거나 더 늦으면 false)
   * @throws PaymentInputError 입력이 틀림(field. 지정 시각이 지금 + 5분을 넘어도 updated_at) · PgFallbackSameProviderError 하위 결제사 규칙에 걸림(표는 그대로) · 저장소 오류
   */
  async execute(input: AssignEventPgInput): Promise<{ readonly written: boolean }> {
    if (!isLowerUuid(input.eventId)) throw new PaymentInputError('event_id');
    if (!PG_NAMES.includes(input.primary)) throw new PaymentInputError('primary');
    if (input.fallback !== undefined && (!PG_NAMES.includes(input.fallback) || input.fallback === input.primary)) throw new PaymentInputError('fallback');
    if (!Number.isSafeInteger(input.updatedAtMs) || input.updatedAtMs < 0) throw new PaymentInputError('updated_at');
    // 먼 미래 지정 시각은 표에 남아 뒤 지정을 모두 막으므로 거절한다(정확히 지금 + 5분은 받는다)
    if (input.updatedAtMs > this.deps.clock.now() + EVENT_PG_ASSIGN_MAX_SKEW_MS) throw new PaymentInputError('updated_at');
    const primary = input.primary as PgName;
    const fallback = input.fallback as PgName | undefined;
    const conflict = subProviderConflict(primary, fallback, this.deps.portone);
    if (conflict !== undefined) throw new PgFallbackSameProviderError(conflict);
    const written = await this.deps.store.assignEvent({ eventId: input.eventId, primary, ...(fallback === undefined ? {} : { fallback }), updatedAtMs: input.updatedAtMs });
    return { written };
  }
}
