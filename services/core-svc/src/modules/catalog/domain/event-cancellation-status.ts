// core 회차 상태 반영의 값과 포트(docs/features/transfer-refund.md §5 'core 회차 상태 반영'·'core 반영의 구현에서 정한 것', BUILD_ORDER GAT-110, ADR-0280 결정 6).
// ops-svc가 회차 취소·연기 확정 뒤 내부 HTTP로 부른다. 프레임워크·저장소를 모른다(트랜잭션 꼴은 어댑터가 정한다).

export const EVENT_STATUS_STORE = Symbol('EVENT_STATUS_STORE');

export type EventCancellationKind = 'CANCEL' | 'POSTPONE';
export type CoreEventStatus = 'SCHEDULED' | 'CANCELLED' | 'POSTPONED';

/** 행 잠금으로 읽은 회차 */
export interface LockedEventStatus {
  readonly productionId: string;
  readonly status: CoreEventStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly entryOpensAt?: Date;
}

/** 쓸 값. 연기면 시작·끝·입장 시작을 같은 만큼 옮긴 값을 싣는다 */
export interface EventStatusWrite {
  readonly status: 'CANCELLED' | 'POSTPONED';
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly entryOpensAt?: Date;
}

/** 회차 상태 쓰기(운영은 core_ops 연결 한 트랜잭션, 회차 행 FOR UPDATE). Tx는 어댑터의 트랜잭션 꼴이다 */
export interface EventStatusStore<Tx> {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** 그 회차 행을 잠그고 읽는다. 없으면 undefined */
  lock(tx: Tx, eventId: string): Promise<LockedEventStatus | undefined>;
  /** 회차 상태(와 연기면 시각)를 쓰고 판(version)을 1 올린다 */
  write(tx: Tx, eventId: string, next: EventStatusWrite): Promise<void>;
}

/** 없는 회차(404 not-found) */
export class EventNotFound extends Error {
  constructor() {
    super('회차를 찾지 못했다');
    this.name = 'EventNotFound';
  }
}

/** CANCELLED 회차의 연기, 지금보다 이른 연기 시작(409 event-status-conflict) */
export class EventStatusConflict extends Error {
  constructor(readonly reason: 'CANCELLED' | 'POSTPONE_IN_PAST') {
    super(`회차 상태와 맞지 않는 반영이다(${reason})`);
    this.name = 'EventStatusConflict';
  }
}

/**
 * 반영할 값을 정한다. undefined면 이미 같은 상태다(바꾸지 않는다, 멱등).
 * @throws EventStatusConflict CANCELLED 회차의 연기·지금보다 이르거나 같은 연기 시작
 */
export function decideEventStatus(current: LockedEventStatus, q: { readonly kind: EventCancellationKind; readonly postponedTo?: Date }, now: Date): EventStatusWrite | undefined {
  if (q.kind === 'CANCEL') return current.status === 'CANCELLED' ? undefined : { status: 'CANCELLED' };
  const to = q.postponedTo;
  // '이미 같은 상태'를 먼저 본다: 같은 시각으로 이미 연기된 회차는 그 시각이 지난 뒤 다시 와도 바꾸지 않는다(다시 하기의 멱등,
  // transfer-refund §5 'core 반영의 구현에서 정한 것' ⑥, BAT-420-rest 리뷰 반영 RV-06)
  if (current.status === 'POSTPONED' && to !== undefined && current.startsAt.getTime() === to.getTime()) return undefined;
  if (current.status === 'CANCELLED') throw new EventStatusConflict('CANCELLED');
  if (to === undefined || to.getTime() <= now.getTime()) throw new EventStatusConflict('POSTPONE_IN_PAST');
  const shift = to.getTime() - current.startsAt.getTime();
  return {
    status: 'POSTPONED',
    startsAt: to,
    endsAt: new Date(current.endsAt.getTime() + shift),
    ...(current.entryOpensAt !== undefined ? { entryOpensAt: new Date(current.entryOpensAt.getTime() + shift) } : {}),
  };
}
