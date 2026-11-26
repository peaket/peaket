// F-04-15 support 소명 도메인(동결 로컬, LCH-310). 순수 함수만 둔다.
// 정본: docs/data.md appeal, docs/features/transfer-refund.md §7.1, docs/api/openapi.yaml 태그 support.
import { randomUUID } from 'node:crypto';

export type AppealKind = 'RESTRICTION' | 'RECLAIM' | 'FRAUD_CASE';
export type AppealStatus = 'SUBMITTED' | 'DECIDED' | 'INVALID';
export type AppealResult = 'LIFTED' | 'KEPT' | 'NOT_RECLAIMED' | 'RECLAIMED' | 'ACCEPTED' | 'REJECTED';
export type FraudParty = 'PAYER' | 'HOLDER';
export type FraudAppealState = 'OPEN' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';

export interface AppealRecord {
  readonly id: string;
  readonly accountId: string;
  readonly kind: AppealKind;
  readonly targetId: string;
  readonly body: string;
  readonly status: AppealStatus;
  readonly result: AppealResult | null;
  readonly caseId: string | null;
  readonly submittedAtMs: number;
  readonly decidedAtMs: number | null;
}

export interface FraudAppealActionResult {
  readonly cancelledTicketIds: readonly string[];
  readonly restrictedUntilMs?: number | null;
}

export interface FraudPriorityPurchase {
  readonly grantId: string;
  readonly seatLabel: string;
  readonly price: number;
  readonly expiresAtMs: number;
  readonly status: 'OFFERED' | 'USED' | 'EXPIRED' | 'WITHDRAWN';
}

export interface FraudAppealViewRecord {
  readonly accountId: string;
  readonly caseId: string;
  readonly eventId: string;
  readonly party: FraudParty;
  readonly reasonCategories: readonly string[];
  readonly dueAtMs: number;
  readonly lockedTicketIds: readonly string[];
  readonly heldTicketIds: readonly string[];
  readonly excludedTicketIds: readonly string[];
  readonly lockActive: boolean;
  readonly lockExpiresAtMs: number | null;
  readonly state: FraudAppealState;
  readonly objectionDueAtMs: number | null;
  readonly objectionState: 'NONE' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED';
  readonly objectionNote: string | null;
  readonly actionResult: FraudAppealActionResult | null;
  readonly priorityPurchases: readonly FraudPriorityPurchase[];
  readonly version: number;
  readonly updatedAtMs: number;
}

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** NFC 뒤 제로 폭·제어 문자를 지우고 앞뒤 공백을 지운다. 코드 포인트로 센다. */
export function normalizeAppealBody(input: string): string {
  return input.normalize('NFC').replace(ZERO_WIDTH, '').replace(CONTROL, '').trim();
}

export function codePoints(s: string): number {
  return Array.from(s).length;
}

/** 코드 포인트 1~2,000자. 넘으면 400(계약 상한), 비면 422(업무 검증). */
export function validateAppealBody(input: string): { body: string } | { status: 400 | 422; type: 'invalid-body'; title: string } {
  const body = normalizeAppealBody(input);
  const n = codePoints(body);
  if (n === 0) return { status: 422, type: 'invalid-body', title: '소명 내용을 1자 이상 적어 주세요' };
  if (n > 2_000) return { status: 400, type: 'invalid-body', title: '소명 내용은 2,000자까지 쓸 수 있습니다' };
  return { body };
}

export function newAppeal(o: { accountId: string; kind: AppealKind; targetId: string; body: string; nowMs: number }): AppealRecord {
  return { id: randomUUID(), accountId: o.accountId, kind: o.kind, targetId: o.targetId, body: o.body, status: 'SUBMITTED', result: null, caseId: null, submittedAtMs: o.nowMs, decidedAtMs: null };
}

export function appealResponse(a: AppealRecord): Record<string, unknown> {
  return { appealId: a.id, kind: a.kind, targetId: a.targetId, status: a.status, result: a.result, caseId: a.caseId, submittedAt: new Date(a.submittedAtMs).toISOString(), decidedAt: a.decidedAtMs === null ? null : new Date(a.decidedAtMs).toISOString() };
}

const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const msOf = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** gRPC·시험 입력을 내부 사본으로 정규화한다. HOLDER는 사유·잠긴 표·잠금·이용 제한·우선 구매·이의 기한을 비운다. */
export function normalizeFraudAppealView(input: Record<string, any>, nowMs: number): FraudAppealViewRecord {
  const party: FraudParty = input.party === 'HOLDER' ? 'HOLDER' : 'PAYER';
  const action = input.actionResult && typeof input.actionResult === 'object' ? input.actionResult : null;
  const cancelled = Array.isArray(action?.cancelledTicketIds) ? action.cancelledTicketIds.map(String) : [];
  const restricted = msOf(action?.restrictedUntilMs ?? action?.restrictedUntil);
  const priority = Array.isArray(input.priorityPurchases)
    ? input.priorityPurchases.map((p: any) => ({ grantId: String(p.grantId), seatLabel: String(p.seatLabel), price: Number(p.price), expiresAtMs: msOf(p.expiresAtMs ?? p.expiresAt) ?? 0, status: p.status === 'USED' || p.status === 'EXPIRED' || p.status === 'WITHDRAWN' ? p.status : 'OFFERED' }))
    : [];
  const base: FraudAppealViewRecord = {
    accountId: String(input.accountId),
    caseId: String(input.caseId),
    eventId: String(input.eventId),
    party,
    reasonCategories: Array.isArray(input.reasonCategories) ? input.reasonCategories.map(String) : [],
    dueAtMs: msOf(input.dueAtMs ?? input.dueAt) ?? nowMs,
    lockedTicketIds: Array.isArray(input.lockedTicketIds) ? input.lockedTicketIds.map(String) : [],
    heldTicketIds: Array.isArray(input.heldTicketIds) ? input.heldTicketIds.map(String) : [],
    excludedTicketIds: Array.isArray(input.excludedTicketIds) ? input.excludedTicketIds.map(String) : [],
    lockActive: input.lockActive === true,
    lockExpiresAtMs: msOf(input.lockExpiresAtMs ?? input.lockExpiresAt),
    state: input.state === 'SUBMITTED' || input.state === 'ACCEPTED' || input.state === 'REJECTED' || input.state === 'EXPIRED' ? input.state : 'OPEN',
    objectionDueAtMs: msOf(input.objectionDueAtMs ?? input.objectionDueAt),
    objectionState: input.objectionState === 'SUBMITTED' || input.objectionState === 'ACCEPTED' || input.objectionState === 'REJECTED' ? input.objectionState : 'NONE',
    objectionNote: typeof input.objectionNote === 'string' ? input.objectionNote : null,
    actionResult: action ? { cancelledTicketIds: cancelled, ...(restricted === null ? {} : { restrictedUntilMs: restricted }) } : null,
    priorityPurchases: priority,
    version: Number(input.version ?? 0),
    updatedAtMs: msOf(input.updatedAtMs) ?? nowMs,
  };
  if (party !== 'HOLDER') return base;
  return {
    ...base,
    reasonCategories: [],
    lockedTicketIds: [],
    lockActive: false,
    lockExpiresAtMs: null,
    objectionDueAtMs: null,
    objectionState: 'NONE',
    objectionNote: null,
    actionResult: action ? { cancelledTicketIds: cancelled } : null,
    priorityPurchases: [],
  };
}

/** 화면용 사본을 API 모양으로 바꾼다. */
export function fraudAppealViewResponse(v: FraudAppealViewRecord): Record<string, unknown> {
  return {
    caseId: v.caseId,
    eventId: v.eventId,
    party: v.party,
    heldTicketIds: [...v.heldTicketIds],
    excludedTicketIds: [...v.excludedTicketIds],
    reasonCategories: [...v.reasonCategories],
    dueAt: iso(v.dueAtMs),
    objectionDueAt: iso(v.objectionDueAtMs),
    objectionStatus: v.objectionState,
    objectionNote: v.objectionNote,
    actionResult: v.actionResult === null ? null : { cancelledTicketIds: [...v.actionResult.cancelledTicketIds], ...(v.actionResult.restrictedUntilMs === undefined || v.actionResult.restrictedUntilMs === null ? {} : { restrictedUntil: iso(v.actionResult.restrictedUntilMs) }) },
    status: v.state,
    lockActive: v.lockActive,
    lockExpiresAt: iso(v.lockExpiresAtMs),
    lockedTicketIds: [...v.lockedTicketIds],
    priorityPurchases: v.priorityPurchases.map((p) => ({ grantId: p.grantId, seatLabel: p.seatLabel, price: p.price, expiresAt: iso(p.expiresAtMs), status: p.status })),
    version: v.version,
  };
}
