// 판매 중지·재개 판정과 저장 포트(ADR-0123, LCH-090, BAT-620).
// 정본: docs/features/transfer-refund.md §2.1 '판매 중지와 재개', docs/features/control-tower.md §5 제어 상태 표,
// docs/features/search.md §2.3 '구현 자리'·§12 SR-T8 ③.
// 판매 중지는 한 트랜잭션으로 공연 상태·비공개·검색 읽기 모델을 함께 바꾸고, 커밋 뒤 CDN을 비운다(유스케이스 ChangeSaleSuspension).
// 판매 재개는 마지막 승인본(APPROVED)으로 돌아가되, 중지 동안 오픈 시각이 지난 회차는 다시 열지 않는다(ADR-0123 결정 5).
import type { EventStatus, SaleReview } from './production.js';

export const SALE_SUSPENSION_STORE = Symbol('SALE_SUSPENSION_STORE');

/** 판매 중지 사유 코드(ADR-0123 결정 2) */
export const SALE_SUSPENSION_REASON_CODES = ['SELLER_IDENTITY', 'LEGAL_REQUEST', 'FRAUD_SUSPECTED', 'OTHER'] as const;
export type SaleSuspensionReasonCode = (typeof SALE_SUSPENSION_REASON_CODES)[number];

export type SaleSuspensionKind = 'SUSPENDED' | 'RESUMED';

/** 판정에 쓰는 회차 한 줄 */
export interface SaleSuspensionEvent {
  readonly eventId: string;
  readonly status: EventStatus;
  readonly openAt: Date;
  readonly startsAt: Date;
}

/** 공연 행을 잠그고 읽은 판매 승인 상태와 회차들 */
export interface LockedSaleSuspension {
  readonly productionId: string;
  readonly saleReview: SaleReview;
  readonly saleApprovedAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly suspensionApprovalId: string | null;
  /** 중지 때 이미 판매 중이던 회차. 재개 때 이 목록에 든 회차만 다시 연다 */
  readonly suspensionOpenEventIds: readonly string[];
  readonly events: readonly SaleSuspensionEvent[];
}

/** 받는 층이 검증한 뒤 넘기는 값 */
export interface SaleSuspensionInput {
  readonly kind: SaleSuspensionKind;
  readonly approvalId: string;
  readonly reasonCode?: SaleSuspensionReasonCode;
  readonly reason?: string;
}

/** 커밋할 값 */
export interface SaleSuspensionWrite {
  readonly kind: SaleSuspensionKind;
  readonly approvalId: string;
  readonly at: Date;
  readonly reasonCode?: SaleSuspensionReasonCode;
  readonly reason?: string;
  /** 중지면 지금 판매 중이던 회차(재개 때 다시 열 목록) */
  readonly openEventIds?: readonly string[];
}

export interface SaleSuspensionDecision {
  /** undefined면 이미 같은 상태다(멱등) */
  readonly write?: SaleSuspensionWrite;
  /** 비취소 회차 모두(집행 순서를 정할 때 쓴다) */
  readonly eventIds: readonly string[];
  /** 재개 때 다시 열 회차. 중지면 빈 목록 */
  readonly resumeEventIds: readonly string[];
}

/** 없는 회차(404 not-found) */
export class SaleSuspensionNotFound extends Error {
  constructor() {
    super('회차를 찾지 못했다');
    this.name = 'SaleSuspensionNotFound';
  }
}

/** 상태와 맞지 않는 판매 중지·재개(409 sale-suspension-conflict) */
export class SaleSuspensionConflict extends Error {
  constructor(readonly reason: 'not-approved' | 'already-suspended' | 'not-suspended') {
    super(`판매 승인 상태와 맞지 않는 판매 중지·재개다(${reason})`);
    this.name = 'SaleSuspensionConflict';
  }
}

/**
 * 지금 상태에서 커밋할 값을 정한다.
 * - 중지: 승인 이력이 있어야 하고(APPROVED·SUBMITTED·REJECTED), 이미 중지면 같은 승인 업무만 멱등이다.
 * - 재개: SUSPENDED에서만 하고, 이미 APPROVED면 멱등이다. 중지 동안 오픈 시각이 지난 회차(중지 때 판매 중이 아니던 회차)는 열지 않는다.
 */
export function decideSaleSuspension(current: LockedSaleSuspension, input: SaleSuspensionInput, now: Date): SaleSuspensionDecision {
  const live = current.events.filter((e) => e.status !== 'CANCELLED');
  const eventIds = live.map((e) => e.eventId);

  if (input.kind === 'SUSPENDED') {
    if (current.saleReview === 'SUSPENDED') {
      if (current.suspensionApprovalId === input.approvalId) return { eventIds, resumeEventIds: [] };
      throw new SaleSuspensionConflict('already-suspended');
    }
    // 승인 이력이 없으면 내릴 것이 없다(첫 승인 전 공연은 이미 비공개다)
    if (current.saleApprovedAt === null) throw new SaleSuspensionConflict('not-approved');
    if (current.saleReview !== 'APPROVED' && current.saleReview !== 'SUBMITTED' && current.saleReview !== 'REJECTED') {
      throw new SaleSuspensionConflict('not-approved');
    }
    // 중지 뒤에는 기다리던 변경분·제출 시각·반려 사유를 거둔다(ADR-0123 결정 1 'Submitted·Rejected → Suspended')
    const openEventIds = live.filter((e) => e.openAt.getTime() <= now.getTime() && now.getTime() < e.startsAt.getTime()).map((e) => e.eventId);
    return {
      write: { kind: 'SUSPENDED', approvalId: input.approvalId, at: now, reasonCode: input.reasonCode, reason: input.reason, openEventIds },
      eventIds,
      resumeEventIds: [],
    };
  }

  if (current.saleReview === 'APPROVED') return { eventIds, resumeEventIds: [] };
  if (current.saleReview !== 'SUSPENDED') throw new SaleSuspensionConflict('not-suspended');
  const resumeEventIds = live
    .filter((e) => e.openAt.getTime() > now.getTime() || current.suspensionOpenEventIds.includes(e.eventId))
    .map((e) => e.eventId);
  return { write: { kind: 'RESUMED', approvalId: input.approvalId, at: now }, eventIds, resumeEventIds };
}

/** 집행 전에 회차 목록을 읽는 값(중지는 판매를 먼저 막고 공개를 내린다) */
export interface SaleSuspensionScope {
  readonly productionId: string;
  readonly saleReview: SaleReview;
  /** 비취소 회차 모두 */
  readonly eventIds: readonly string[];
}

/**
 * 판매 승인 상태 저장 포트. 운영은 core_ops 연결 한 트랜잭션에서 공연 행을 잠그고,
 * 같은 트랜잭션에 검색 동기화를 부르는 것은 유스케이스(withSearchSync)다. Tx는 어댑터의 트랜잭션 꼴이다.
 */
export interface SaleSuspensionStore<Tx> {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** 그 회차가 속한 공연 행을 잠그고 판매 승인 상태·회차를 읽는다. 없으면 undefined */
  lockByEvent(tx: Tx, eventId: string): Promise<LockedSaleSuspension | undefined>;
  /** 상태·사유·다시 열 목록을 쓰고 기다리던 변경분을 거둔다 */
  write(tx: Tx, productionId: string, write: SaleSuspensionWrite): Promise<void>;
  /** 잠그지 않고 집행 순서용 회차 목록만 읽는다. 없으면 undefined */
  scope(eventId: string): Promise<SaleSuspensionScope | undefined>;
}
