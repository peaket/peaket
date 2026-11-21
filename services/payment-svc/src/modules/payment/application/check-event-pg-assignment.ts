// 명령 12(결제사 지정)의 사전 판정 쓰임새(gRPC CheckEventPgAssignment, ADR-0349 결정 3, BUILD_ORDER BAT-360 OPS-290).
// 회차 지정 쓰임새 AssignEventPg와 같은 하위 결제사 규칙 함수(subProviderConflict)와 같은 포트원 채널 표로 판정하고 아무것도 쓰지 않는다
// (docs/features/payment.md §2.2 '하위 결제사 검사의 첫 구현'). 부르는 쪽은 ops-svc뿐이다(메시 허용 표, docs/api/proto/README.md §3).
// 명령 12의 결제사는 TOSS·PORTONE뿐이라(ADR-0349 결정 1) SIMULATOR는 입력 오류다. 지금 회차 지정은 event_pg_config를 읽고,
// 결제사별 승인 상한은 설정(PEAKET_PG_APPROVAL_TPS)에 있는 것만 싣는다(없으면 빈 목록, 부르는 쪽 dry-run이 '세지 못함'으로 둔다, ADR-0349 결정 4).
import { isLowerUuid, PaymentInputError } from '../domain/confirm-command.js';
import type { PgName } from '../domain/payment-gateway.js';
import type { EventPgAssignment } from '../domain/pg-selection.js';
import { type PortoneChannelMap, type SubProviderConflict, subProviderConflict } from '../domain/pg-sub-provider.js';
import type { CallBudget, PgSelectionReader } from '../domain/ports.js';

/** 명령 12가 받는 결제사(ADR-0349 결정 1) */
const COMMAND_PGS: readonly string[] = ['TOSS', 'PORTONE'];

/** 받는 층이 넘기는 값(검사 전). 결제사는 앞머리 PG_PROVIDER_를 뗀 이름이고, 대체가 없으면 빈 글이거나 UNSPECIFIED다 */
export interface CheckEventPgAssignmentInput {
  readonly eventId: string;
  readonly primary: string;
  readonly fallback?: string;
}

export interface PgApprovalLimit {
  readonly pg: PgName;
  readonly approvalsPerSecond: number;
}

export interface CheckEventPgAssignmentAnswer {
  readonly allowed: boolean;
  /** 걸렸을 때만: 하위 결제사 이름과 까닭(채널 키는 싣지 않는다) */
  readonly conflict?: SubProviderConflict;
  /** 지금 회차 지정. 없으면 undefined */
  readonly current?: EventPgAssignment;
  /** 설정에 있는 결제사의 승인 상한(이름 차례) */
  readonly approvalLimits: readonly PgApprovalLimit[];
}

export interface CheckEventPgAssignmentDeps {
  /** 회차 지정 읽기(캐시를 거치지 않는 읽기를 넘긴다: 판정은 지금 값을 본다) */
  readonly selection: PgSelectionReader;
  /** 설정의 포트원 채널 표(하위 결제사). AssignEventPg에 넘긴 것과 같은 값. 없으면 규칙이 보지 못한다 */
  readonly portone?: PortoneChannelMap;
  /** 결제사별 초당 승인 상한(설정 PEAKET_PG_APPROVAL_TPS) */
  readonly approvalTps: ReadonlyMap<PgName, number>;
}

export class CheckEventPgAssignment {
  constructor(private readonly deps: CheckEventPgAssignmentDeps) {}

  /**
   * @throws PaymentInputError 회차가 소문자 UUID가 아님(event_id)·기본이 TOSS·PORTONE이 아님(primary)·대체가 TOSS·PORTONE이 아니거나 기본과 같음(fallback) · 저장소 오류
   */
  async execute(input: CheckEventPgAssignmentInput, budget?: CallBudget): Promise<CheckEventPgAssignmentAnswer> {
    if (!isLowerUuid(input.eventId)) throw new PaymentInputError('event_id');
    if (!COMMAND_PGS.includes(input.primary)) throw new PaymentInputError('primary');
    const fallbackRaw = input.fallback === undefined || input.fallback === '' || input.fallback === 'UNSPECIFIED' ? undefined : input.fallback;
    if (fallbackRaw !== undefined && (!COMMAND_PGS.includes(fallbackRaw) || fallbackRaw === input.primary)) throw new PaymentInputError('fallback');
    const primary = input.primary as PgName;
    const fallback = fallbackRaw as PgName | undefined;
    const conflict = subProviderConflict(primary, fallback, this.deps.portone);
    const state = await this.deps.selection.read(input.eventId, budget);
    const approvalLimits = [...this.deps.approvalTps].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([pg, approvalsPerSecond]) => ({ pg, approvalsPerSecond }));
    return {
      allowed: conflict === undefined,
      ...(conflict === undefined ? {} : { conflict }),
      ...(state.assignment === undefined ? {} : { current: state.assignment }),
      approvalLimits,
    };
  }
}
