// 티켓 발권·취소·월렛 목록의 순수 규칙(BUILD_ORDER HOT-160, docs/features/payment.md §2·§4.1).
// 저장소·gRPC와 분리해 시험한다. 티켓 키는 발권 응답에만 싣고 DB에는 SHA-256만 둔다.
import { createHash, randomBytes } from 'node:crypto';

/** 티켓 상태. docs/planning/03 §2.5와 docs/data.md `ticket.status`의 값. 이 최소 구현은 ISSUED·ACTIVE·REFUNDED·VOIDED만 쓰고, 나머지는 뒤 모듈이 채운다. */
export type TicketStatus = 'ISSUED' | 'ACTIVE' | 'TRANSFER_PENDING' | 'CANCEL_REQUESTED' | 'REFUNDED' | 'FLAGGED' | 'VOIDED';

/** 한 번에 발권하는 좌석 수 상한(1인당 매수 상한 4의 두 배, 방어적 상한) */
export const MAX_TICKETS_PER_ISSUE = 10;
/** 월렛 목록 한 쪽 기본·최대 */
export const DEFAULT_WALLET_LIMIT = 20;
export const MAX_WALLET_LIMIT = 100;

export interface IssueTicketsInput {
  readonly orderId: string;
  readonly eventId: string;
  readonly payerAccountId: string;
  readonly seatIds: readonly string[];
  readonly issueGeneration: number;
  /** 회차 시작 시각(epoch ms). 없으면 취소는 입장 전으로 본다. */
  readonly eventStartsAtMs?: number;
}

export interface TicketRecord {
  readonly ticketId: string;
  readonly accountId: string;
  readonly payerAccountId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly seatId: string;
  /** 좌석 배치의 게이트 구역. 최소 구현은 빈 값이다(좌석 배치 연결은 후속). */
  readonly gateZone: string;
  readonly status: TicketStatus;
  readonly issueGeneration: number;
  /** 스캐너가 읽는 공개 포인터(PEAKET1:<ticket_id>) */
  readonly qrPayload: string;
  /** 티켓 키의 SHA-256(hex). 원문은 발권 응답에만 있다. */
  readonly keyHash: string;
  /** 발권 응답에만 붙는 키 원문. 저장소에서 다시 읽은 기록에는 없다. */
  readonly ticketKey?: string;
  readonly keyRevokedAtMs?: number;
  /** 양도 요청이 진행 중이면 취소를 거절하는 자리(양도 모듈은 후속). */
  readonly transferPending: boolean;
  /** 부정 예매 양도 잠금 사건 ID 자리(후속). */
  readonly fraudLockCaseId?: string;
  readonly version: number;
  readonly issuedAtMs: number;
  readonly eventStartsAtMs?: number;
}

export interface IssueTicketsResult {
  readonly tickets: readonly TicketRecord[];
  /** 같은 주문·세대의 재요청이면 true. 이때 ticketKey는 비어 있다. */
  readonly replayed: boolean;
}

export type CancelTicketResult = 'REFUND_NOW' | 'REFUND_AFTER_CLOSE' | 'NOT_PAYER_HOLDER' | 'TRANSFER_PENDING' | 'EVENT_STARTED' | 'ALREADY_CANCELLED';

export interface CancelTicketsInput {
  readonly orderId: string;
  readonly ticketIds: readonly string[];
  readonly requestedByAccountId: string;
  readonly cancellationId: string;
  readonly nowMs: number;
}

export interface CancelTicketOutcome {
  readonly ticketId: string;
  readonly result: CancelTicketResult;
}

export interface ListTicketsInput {
  readonly accountId: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface WalletTicket {
  readonly ticketId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly seatId: string;
  readonly status: TicketStatus;
  readonly qrPayload: string;
  readonly issuedAtMs: number;
}

export interface ListTicketsResult {
  readonly tickets: readonly WalletTicket[];
  readonly nextCursor?: string;
}

/** 잘못된 입력(빈 값·UUID 아님·중복 좌석·상한 초과). gRPC INVALID_ARGUMENT로 바꾼다. */
export class TicketInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketInputError';
  }
}

/** 같은 주문·세대에 다른 내용으로 다시 발권하려 했다. gRPC FAILED_PRECONDITION로 바꾼다. */
export class TicketConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketConflictError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID.test(v);
}

function requireUuid(name: string, v: string): string {
  const t = v.trim();
  if (!isUuid(t)) throw new TicketInputError(`${name}는 UUID여야 한다`);
  return t.toLowerCase();
}

function requireText(name: string, v: string, max = 200): string {
  const t = v.trim();
  if (!t || t.length > max) throw new TicketInputError(`${name}는 1~${max}자여야 한다`);
  return t;
}

/** 발권 입력을 검사하고 정규화한다. 좌석은 중복을 없애고 정렬해 멱등 지문을 안정적으로 만든다. */
export function normalizeIssueInput(i: IssueTicketsInput): IssueTicketsInput & { readonly seatIds: readonly string[] } {
  const orderId = requireUuid('orderId', i.orderId);
  const eventId = requireUuid('eventId', i.eventId);
  const payerAccountId = requireUuid('payerAccountId', i.payerAccountId);
  if (!Number.isSafeInteger(i.issueGeneration) || i.issueGeneration < 0) throw new TicketInputError('issueGeneration은 0 이상의 정수여야 한다');
  const seatIds = [...new Set(i.seatIds.map((s) => requireUuid('seatId', s)))].sort();
  if (seatIds.length === 0) throw new TicketInputError('seatIds가 비었다');
  if (seatIds.length > MAX_TICKETS_PER_ISSUE) throw new TicketInputError(`한 번에 ${MAX_TICKETS_PER_ISSUE}좌석까지만 발권한다`);
  if (i.eventStartsAtMs !== undefined && (!Number.isFinite(i.eventStartsAtMs) || i.eventStartsAtMs < 0)) throw new TicketInputError('eventStartsAtMs가 올바르지 않다');
  return { orderId, eventId, payerAccountId, seatIds, issueGeneration: i.issueGeneration, ...(i.eventStartsAtMs === undefined ? {} : { eventStartsAtMs: i.eventStartsAtMs }) };
}

/** 같은 주문·세대의 재요청인지 가리는 지문. 좌석 차례가 달라도 같은 값이고, 회차 시작 시각 같은 표시 값은 넣지 않는다. */
export function issueFingerprint(i: IssueTicketsInput): string {
  const n = normalizeIssueInput(i);
  return createHash('sha256').update(JSON.stringify([n.orderId, n.eventId, n.payerAccountId, n.seatIds, n.issueGeneration]), 'utf8').digest('hex');
}

/** 티켓 소지 증명 키(32바이트 base64url). 발권 응답에만 싣는다. */
export function newTicketKey(): string {
  return randomBytes(32).toString('base64url');
}

export function ticketKeyHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** 스캐너가 읽는 공개 QR 포인터. 키·서명을 담지 않는다(회전 QR은 기기 키 등록 뒤). */
export function qrPayloadOf(ticketId: string): string {
  return `PEAKET1:${ticketId}`;
}

export interface WalletCursor {
  readonly issuedAtMs: number;
  readonly ticketId: string;
}

export function walletCursorOf(c: WalletCursor): string {
  return Buffer.from(JSON.stringify([c.issuedAtMs, c.ticketId]), 'utf8').toString('base64url');
}

export function parseWalletCursor(raw: string | undefined): WalletCursor | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'string' || !isUuid(v[1])) return undefined;
    return { issuedAtMs: v[0], ticketId: v[1].toLowerCase() };
  } catch {
    return undefined;
  }
}

export function normalizeListInput(i: ListTicketsInput): ListTicketsInput {
  const accountId = requireUuid('accountId', i.accountId);
  const limit = Math.max(1, Math.min(MAX_WALLET_LIMIT, Math.trunc(i.limit) || DEFAULT_WALLET_LIMIT));
  const cursor = parseWalletCursor(i.cursor);
  return { accountId, limit, ...(cursor ? { cursor: i.cursor } : {}) };
}

export function normalizeCancelInput(i: CancelTicketsInput): CancelTicketsInput {
  const orderId = requireUuid('orderId', i.orderId);
  const requestedByAccountId = requireUuid('requestedByAccountId', i.requestedByAccountId);
  const cancellationId = requireUuid('cancellationId', i.cancellationId);
  const ticketIds = [...new Set(i.ticketIds.map((t) => requireUuid('ticketId', t)))];
  if (ticketIds.length === 0) throw new TicketInputError('ticketIds가 비었다');
  if (!Number.isFinite(i.nowMs) || i.nowMs < 0) throw new TicketInputError('nowMs가 올바르지 않다');
  return { orderId, ticketIds, requestedByAccountId, cancellationId, nowMs: i.nowMs };
}

/** 월렛 목록에 싣는 값만 고른다(키 원문·해시는 싣지 않는다). */
export function walletTicketOf(t: TicketRecord): WalletTicket {
  return { ticketId: t.ticketId, orderId: t.orderId, eventId: t.eventId, seatId: t.seatId, status: t.status, qrPayload: t.qrPayload, issuedAtMs: t.issuedAtMs };
}
