// F-04-15 SCR-042 부정 예매 소명 화면 모델(동결 로컬, LCH-310).
// 정본: docs/features/forensic-replay.md §6.7.5 '팬 화면', docs/api/openapi.yaml FraudAppealView.
export type FraudParty = 'PAYER' | 'HOLDER';
export type FraudAppealState = 'OPEN' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
export type ObjectionState = 'NONE' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED';

export interface FraudLiveView {
  caseId: string;
  eventId: string;
  party: FraudParty;
  reasonCategories: readonly string[];
  dueAtMs: number;
  remainingHours: number;
  status: FraudAppealState;
  lockActive: boolean;
  lockExpiresAtMs: number | null;
  lockedTicketIds: readonly string[];
  heldTicketIds: readonly string[];
  excludedTicketIds: readonly string[];
  objectionDueAtMs: number | null;
  objectionStatus: ObjectionState;
  objectionNote: string | null;
  actionResult: { cancelledTicketIds: readonly string[]; restrictedUntilMs: number | null } | null;
  priorityPurchases: readonly { grantId: string; seatLabel: string; price: number; expiresAtMs: number; status: 'OFFERED' | 'USED' | 'EXPIRED' | 'WITHDRAWN' }[];
}

const HOUR = 3_600_000;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const obj = (v: unknown): Record<string, any> | null => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : null);
const msOf = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const len = (s: string) => Array.from(s).length;
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s: string) => s.normalize('NFC').replace(ZERO_WIDTH, '').replace(CONTROL, '').trim();

export function mapFraudLive(raw: Record<string, unknown>, nowMs: number): FraudLiveView {
  const party: FraudParty = raw.party === 'HOLDER' ? 'HOLDER' : 'PAYER';
  const action = obj(raw.actionResult);
  const due = msOf(raw.dueAt) ?? nowMs;
  const base: FraudLiveView = {
    caseId: str(raw.caseId),
    eventId: str(raw.eventId),
    party,
    reasonCategories: arr(raw.reasonCategories),
    dueAtMs: due,
    remainingHours: Math.max(0, Math.floor((due - nowMs) / HOUR)),
    status: (raw.status === 'SUBMITTED' || raw.status === 'ACCEPTED' || raw.status === 'REJECTED' || raw.status === 'EXPIRED' ? raw.status : 'OPEN') as FraudAppealState,
    lockActive: raw.lockActive === true,
    lockExpiresAtMs: msOf(raw.lockExpiresAt),
    lockedTicketIds: arr(raw.lockedTicketIds),
    heldTicketIds: arr(raw.heldTicketIds),
    excludedTicketIds: arr(raw.excludedTicketIds),
    objectionDueAtMs: msOf(raw.objectionDueAt),
    objectionStatus: raw.objectionStatus === 'SUBMITTED' || raw.objectionStatus === 'ACCEPTED' || raw.objectionStatus === 'REJECTED' ? raw.objectionStatus : 'NONE',
    objectionNote: typeof raw.objectionNote === 'string' ? raw.objectionNote : null,
    actionResult: action ? { cancelledTicketIds: arr(action.cancelledTicketIds), restrictedUntilMs: msOf(action.restrictedUntil) } : null,
    priorityPurchases: Array.isArray(raw.priorityPurchases) ? raw.priorityPurchases.map((p) => {
      const o = p as Record<string, any>;
      return { grantId: str(o.grantId), seatLabel: str(o.seatLabel), price: num(o.price), expiresAtMs: msOf(o.expiresAt) ?? 0, status: o.status === 'USED' || o.status === 'EXPIRED' || o.status === 'WITHDRAWN' ? o.status : 'OFFERED' };
    }) : [],
  };
  if (party !== 'HOLDER') return base;
  return {
    ...base,
    reasonCategories: [],
    lockedTicketIds: [],
    lockActive: false,
    lockExpiresAtMs: null,
    objectionDueAtMs: null,
    objectionStatus: 'NONE',
    objectionNote: null,
    actionResult: action ? { cancelledTicketIds: arr(action.cancelledTicketIds), restrictedUntilMs: null } : null,
    priorityPurchases: [],
  };
}

export function submissionOf(v: FraudLiveView, nowMs: number): { allowed: boolean; reason?: 'submitted' | 'decided' | 'expired' | 'not-open' } {
  if (v.party === 'HOLDER') {
    if (v.status === 'OPEN' || v.status === 'EXPIRED') return { allowed: true };
    return { allowed: false, reason: v.status === 'SUBMITTED' ? 'submitted' : 'decided' };
  }
  if (v.status === 'SUBMITTED') return { allowed: false, reason: 'submitted' };
  if (v.status === 'ACCEPTED' || v.status === 'REJECTED') return { allowed: false, reason: 'decided' };
  if (v.status === 'EXPIRED') return { allowed: false, reason: 'expired' };
  if (nowMs <= v.dueAtMs) return { allowed: true };
  if (v.objectionDueAtMs !== null && nowMs <= v.objectionDueAtMs) return { allowed: true };
  return { allowed: false, reason: 'expired' };
}

export function appealContentError(text: string): string | undefined {
  const n = len(clean(text));
  if (n === 0) return '소명 내용을 1자 이상 적어 주세요';
  if (n > 2_000) return '소명 내용은 2,000자까지 쓸 수 있습니다';
  return undefined;
}

export function createFraudAppealBody(v: FraudLiveView, text: string): { kind: 'FRAUD_CASE'; targetId: string; body: string } {
  return { kind: 'FRAUD_CASE', targetId: v.caseId, body: text.trim() };
}

export function fraudAppealProblem(e: unknown): { kind: 'auth' | 'deadline' | 'invalid' | 'config' | 'error'; message: string } {
  const o = obj(e) ?? {};
  const status = typeof o.status === 'number' ? o.status : 0;
  if (status === 401) return { kind: 'auth', message: '로그인한 뒤 다시 시도해 주세요' };
  if (status === 409) return { kind: 'deadline', message: '소명 기한이 지났거나 지금 상태에서는 낼 수 없습니다' };
  if (status === 422) return { kind: 'invalid', message: '소명 내용을 확인해 주세요' };
  if (status === 503) return { kind: 'config', message: '잠시 뒤 다시 시도해 주세요' };
  return { kind: 'error', message: '소명을 내지 못했습니다' };
}

const won = new Intl.NumberFormat('ko-KR');
const when = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function priorityPurchaseRows(v: FraudLiveView, nowMs: number): readonly { seatLabel: string; priceText: string; deadlineText: string; statusText: string }[] {
  return v.priorityPurchases
    .filter((p) => p.status === 'OFFERED' && p.expiresAtMs >= nowMs)
    .map((p) => ({ seatLabel: p.seatLabel, priceText: `₩${won.format(p.price)}(원래 가격, 수수료 없음)`, deadlineText: when.format(new Date(p.expiresAtMs)), statusText: '구매 가능' }));
}

export function canSeeReasonCategories(v: FraudLiveView): boolean {
  return v.party === 'PAYER' && v.reasonCategories.length > 0;
}

export function holderTicketText(v: FraudLiveView): string {
  return `가진 표 ${v.heldTicketIds.length}매`;
}

export function fraudDeadlineText(v: FraudLiveView): string {
  return `소명 기한 ${when.format(new Date(v.dueAtMs))}`;
}
