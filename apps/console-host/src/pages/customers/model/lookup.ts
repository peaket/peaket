// SCR-066 팬 조회 화면 값 해석(F-06-5). 서버가 가린 값만 주므로 모르는 칸(원문 이름·전화·이메일)은 버린다.
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export interface FanSummaryView {
  accountId: string;
  memberCode: string;
  nickname: string;
  status: string;
  mergedIntoAccountId: string | null;
}
export interface FanDetailView {
  accountId: string;
  memberCode: string;
  nickname: string;
  status: string;
  nameMasked: string | null;
  phoneMasked: string | null;
  emailMasked: string | null;
  identityVerifiedAt: string | null;
  loginProviders: string[];
  mergeHistory: Array<{ absorbedAccountId: string; mergedAt: string }>;
  bookingRestriction: { reasonCode: string; startsAt: string; endsAt: string; appealDueAt: string } | null;
  selfRequestCaseIds: string[];
}
export interface FanOrderView {
  orderId: string;
  orderNo: string;
  reservationNo: string | null;
  kind: string;
  eventId: string | null;
  title: string;
  status: string;
  amount: number;
  orderedAt: string;
  buyerNameMasked: string | null;
  buyerPhoneMasked: string | null;
}
export interface FanTicketView {
  ticketId: string;
  orderId: string;
  eventId: string;
  title: string;
  seatLabel: string;
  status: string;
  transferLocked: boolean;
  holderIsPayer: boolean;
}
export interface FanTransferView {
  offerId: string;
  ticketId: string;
  direction: string;
  counterpartNicknameMasked: string | null;
  status: string;
  createdAt: string;
  closedAt: string | null;
}
export interface FanQueueView {
  eventId: string;
  title: string;
  status: string;
  enteredAt: string;
  endedAt: string | null;
}
export interface FanPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface UnmaskingView {
  name: string | null;
  phone: string | null;
  email: string | null;
  reason: string;
  unmaskedAt: string;
}

export function fanSummaryOf(raw: unknown): FanSummaryView | null {
  if (!isRecord(raw) || !text(raw.accountId)) return null;
  return {
    accountId: text(raw.accountId),
    memberCode: text(raw.memberCode),
    nickname: text(raw.nickname),
    status: text(raw.status),
    mergedIntoAccountId: textOrNull(raw.mergedIntoAccountId),
  };
}

export function fanDetailOf(raw: unknown): FanDetailView | null {
  if (!isRecord(raw) || !text(raw.accountId)) return null;
  const restriction = isRecord(raw.bookingRestriction)
    ? { reasonCode: text(raw.bookingRestriction.reasonCode), startsAt: text(raw.bookingRestriction.startsAt), endsAt: text(raw.bookingRestriction.endsAt), appealDueAt: text(raw.bookingRestriction.appealDueAt) }
    : null;
  return {
    accountId: text(raw.accountId),
    memberCode: text(raw.memberCode),
    nickname: text(raw.nickname),
    status: text(raw.status),
    nameMasked: textOrNull(raw.nameMasked),
    phoneMasked: textOrNull(raw.phoneMasked),
    emailMasked: textOrNull(raw.emailMasked),
    identityVerifiedAt: textOrNull(raw.identityVerifiedAt),
    loginProviders: Array.isArray(raw.loginProviders) ? raw.loginProviders.filter((v): v is string => typeof v === 'string') : [],
    mergeHistory: Array.isArray(raw.mergeHistory)
      ? raw.mergeHistory.filter(isRecord).map((m) => ({ absorbedAccountId: text(m.absorbedAccountId), mergedAt: text(m.mergedAt) }))
      : [],
    bookingRestriction: restriction,
    selfRequestCaseIds: Array.isArray(raw.selfRequestCaseIds) ? raw.selfRequestCaseIds.filter((v): v is string => typeof v === 'string') : [],
  };
}

function pageOf<T>(raw: unknown, map: (v: unknown) => T | null): FanPage<T> {
  if (!isRecord(raw)) return { items: [], nextCursor: null };
  return {
    items: Array.isArray(raw.items) ? raw.items.map(map).filter((v): v is T => v !== null) : [],
    nextCursor: textOrNull(raw.nextCursor),
  };
}

export function orderPageOf(raw: unknown): FanPage<FanOrderView> {
  return pageOf(raw, (v) => {
    if (!isRecord(v) || !text(v.orderId)) return null;
    return {
      orderId: text(v.orderId), orderNo: text(v.orderNo), reservationNo: textOrNull(v.reservationNo), kind: text(v.kind), eventId: textOrNull(v.eventId),
      title: text(v.title), status: text(v.status), amount: typeof v.amount === 'number' ? v.amount : 0, orderedAt: text(v.orderedAt),
      buyerNameMasked: textOrNull(v.buyerNameMasked), buyerPhoneMasked: textOrNull(v.buyerPhoneMasked),
    };
  });
}

export function ticketPageOf(raw: unknown): FanPage<FanTicketView> {
  return pageOf(raw, (v) => {
    if (!isRecord(v) || !text(v.ticketId)) return null;
    return { ticketId: text(v.ticketId), orderId: text(v.orderId), eventId: text(v.eventId), title: text(v.title), seatLabel: text(v.seatLabel), status: text(v.status), transferLocked: v.transferLocked === true, holderIsPayer: v.holderIsPayer === true };
  });
}

export function transferPageOf(raw: unknown): FanPage<FanTransferView> {
  return pageOf(raw, (v) => {
    if (!isRecord(v) || !text(v.offerId)) return null;
    return { offerId: text(v.offerId), ticketId: text(v.ticketId), direction: text(v.direction), counterpartNicknameMasked: textOrNull(v.counterpartNicknameMasked), status: text(v.status), createdAt: text(v.createdAt), closedAt: textOrNull(v.closedAt) };
  });
}

export function queuePageOf(raw: unknown): FanPage<FanQueueView> {
  return pageOf(raw, (v) => {
    if (!isRecord(v) || !text(v.eventId)) return null;
    return { eventId: text(v.eventId), title: text(v.title), status: text(v.status), enteredAt: text(v.enteredAt), endedAt: textOrNull(v.endedAt) };
  });
}

export function unmaskingOf(raw: unknown): UnmaskingView | null {
  if (!isRecord(raw) || !text(raw.reason) || !text(raw.unmaskedAt)) return null;
  return { name: textOrNull(raw.name), phone: textOrNull(raw.phone), email: textOrNull(raw.email), reason: text(raw.reason), unmaskedAt: text(raw.unmaskedAt) };
}

export interface LookupBody {
  orderNo?: string;
  reservationNo?: string;
  memberCode?: string;
}
export function lookupBody(input: { orderNo?: string; reservationNo?: string; memberCode?: string }): { ok: true; body: LookupBody } | { ok: false } {
  const pairs = (['orderNo', 'reservationNo', 'memberCode'] as const).map((k) => [k, input[k]?.trim()] as const).filter(([, v]) => v);
  if (pairs.length !== 1) return { ok: false };
  return { ok: true, body: { [pairs[0]![0]]: pairs[0]![1]! } as LookupBody };
}

export const reasonValid = (v: string): boolean => {
  const n = [...v].length;
  return n >= 4 && n <= 500;
};

export function unmaskBodyValid(input: { fields: string[]; reason: string; orderId?: string }): boolean {
  if (!reasonValid(input.reason)) return false;
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 3) return false;
  if (new Set(input.fields).size !== input.fields.length) return false;
  if (input.fields.some((f) => !['NAME', 'PHONE', 'EMAIL'].includes(f))) return false;
  if (input.orderId && input.fields.includes('EMAIL')) return false;
  return true;
}

export const customerHref = (accountId: string): string => `/customers/${encodeURIComponent(accountId)}`;
