// 시뮬레이터의 포트원 V2 모양(BUILD_ORDER HOT-140, docs/features/payment.md §2.1 '포트원 어댑터의 첫 구현').
// 엔진은 토스 모양 답을 낸다. 여기서 포트원의 상태 코드·오류 type·결제 건 모양으로 바꾼다. 답의 모양은 포트원 V2 공식 스키마(2026-11-09 확인)를 따랐다.
import { createHash, createHmac } from 'node:crypto';
import type { SimResponse, WebhookEvent } from './engine.js';

/** 시뮬레이터의 상점 ID. 요청의 storeId가 다르면 404 PAYMENT_NOT_FOUND다(BUILD_ORDER HOT-140, 코드 리뷰) */
export const PORTONE_STORE_ID = 'store-sim';

/** 토스 모양 오류 코드 → 포트원 상태 코드와 type */
const ERROR: ReadonlyMap<string, { status: number; type: string }> = new Map([
  ['ALREADY_PROCESSED_PAYMENT', { status: 409, type: 'ALREADY_PAID' }],
  ['DUPLICATED_ORDER_ID', { status: 409, type: 'ALREADY_PAID' }],
  ['ALREADY_PROCESSING_REQUEST', { status: 409, type: 'IDEMPOTENCY_OUTSTANDING_REQUEST' }],
  ['IDEMPOTENT_REQUEST_PROCESSING', { status: 409, type: 'IDEMPOTENCY_OUTSTANDING_REQUEST' }],
  ['NOT_FOUND_PAYMENT', { status: 404, type: 'PAYMENT_NOT_FOUND' }],
  ['NOT_FOUND_PAYMENT_SESSION', { status: 400, type: 'INVALID_PAYMENT_TOKEN' }],
  ['FAILED_INTERNAL_SYSTEM_PROCESSING', { status: 502, type: 'PG_PROVIDER' }],
  ['ALREADY_CANCELED_PAYMENT', { status: 409, type: 'PAYMENT_ALREADY_CANCELLED' }],
  ['NOT_CANCELABLE_PAYMENT', { status: 409, type: 'PAYMENT_NOT_PAID' }],
  ['NOT_CANCELABLE_AMOUNT', { status: 409, type: 'CANCEL_AMOUNT_EXCEEDS_CANCELLABLE_AMOUNT' }],
]);
const STATUS: ReadonlyMap<string, string> = new Map([
  ['READY', 'READY'],
  ['IN_PROGRESS', 'PAY_PENDING'],
  ['DONE', 'PAID'],
  ['PARTIAL_CANCELED', 'PARTIAL_CANCELLED'],
  ['CANCELED', 'CANCELLED'],
  ['ABORTED', 'FAILED'],
  // 공식 상태에 만료가 없어 승인 기한이 지나도 READY로 둔다(BUILD_ORDER HOT-140, 코드 리뷰. 실제 동작은 HOT-145에서 확인)
  ['EXPIRED', 'READY'],
]);
const WEBHOOK_TYPE: ReadonlyMap<string, string> = new Map([
  ['DONE', 'Transaction.Paid'],
  ['PARTIAL_CANCELED', 'Transaction.PartialCancelled'],
  ['CANCELED', 'Transaction.Cancelled'],
  ['ABORTED', 'Transaction.Failed'],
]);

type TossView = Record<string, unknown> & { status?: string; paymentKey?: string; cancels?: Array<Record<string, unknown>> | null };

const errorBody = (type: string, message: unknown) => ({ type, message });

/** 엔진의 답을 포트원 모양으로 바꾼다. mapOk는 200 답의 본문을 바꾼다 */
function translate(r: SimResponse, mapOk: (view: TossView) => unknown, invalidRequestType: string): SimResponse {
  if (r.drop) return r;
  const code = (r.body as { code?: string } | undefined)?.code;
  if (code === undefined) return r.status === 200 ? { status: 200, body: mapOk(r.body as TossView) } : r;
  const message = (r.body as { message?: unknown }).message;
  if (code === 'INVALID_REQUEST') return { status: invalidRequestType === 'INVALID_REQUEST' ? 400 : 409, body: errorBody(invalidRequestType, message) };
  if (code === 'PG_PROVIDER') return { status: 502, body: errorBody(code, message) };
  const mapped = ERROR.get(code);
  return mapped ? { status: mapped.status, body: errorBody(mapped.type, message) } : { status: r.status, body: errorBody(code, message) };
}

export function portoneConfirmResponse(r: SimResponse): SimResponse {
  return translate(r, (v) => ({ pgTxId: v.lastTransactionKey ?? v.txId, paidAt: v.approvedAt }), 'INFORMATION_MISMATCH');
}

export function portoneAuthenticateResponse(r: SimResponse): SimResponse {
  return translate(r, (v) => v, 'INVALID_REQUEST');
}

export function portoneCancelResponse(r: SimResponse): SimResponse {
  return translate(
    r,
    (v) => {
      const last = v.cancels?.at(-1) ?? {};
      return { cancellation: { status: 'SUCCEEDED', id: last.transactionKey, pgCancellationId: last.transactionKey, totalAmount: last.cancelAmount, taxFreeAmount: 0, vatAmount: 0, reason: last.cancelReason, requestedAt: last.canceledAt, cancelledAt: last.canceledAt } };
    },
    'INVALID_REQUEST',
  );
}

export function portoneQueryResponse(r: SimResponse): SimResponse {
  return translate(r, portoneView, 'INVALID_REQUEST');
}

/** 토스 모양 카드 종류 → 포트원 CardType(공식 스키마 열거값) */
const CARD_TYPE: ReadonlyMap<unknown, string> = new Map([
  ['신용', 'CREDIT'],
  ['체크', 'DEBIT'],
  ['기프트', 'GIFT'],
]);
const METHOD_TYPE: ReadonlyMap<unknown, string> = new Map([
  ['계좌이체', 'PaymentMethodTransfer'],
  ['가상계좌', 'PaymentMethodVirtualAccount'],
]);

/**
 * 엔진의 카드 칸 → 포트원 Card(공식 스키마의 칸. 값이 없는 칸은 빠진다).
 * issuer는 시험 카드의 값을 그대로 보낸다. 공식 스키마에 값 목록이 없어 실제 모양을 모르므로, 합성 카드에서는 토스 코드 61이 나간다(docs/features/payment.md §2.1, BUILD_ORDER HOT-145 코드 리뷰)
 */
function portoneCard(card: Record<string, unknown>): Record<string, unknown> {
  const type = CARD_TYPE.get(card.cardType);
  return { number: card.number, ...(card.issuerCode === null || card.issuerCode === undefined ? {} : { issuer: card.issuerCode }), ...(type === undefined ? {} : { type }), ...(card.bin === undefined ? {} : { bin: card.bin }) };
}

/** 엔진의 결제 보기를 포트원 Payment 모양으로 바꾼다(필요한 칸만) */
function portoneView(v: TossView): Record<string, unknown> {
  const total = v.totalAmount as number;
  const balance = v.balanceAmount as number;
  const approved = v.approvedAt !== null && v.approvedAt !== undefined;
  const card = v.card as Record<string, unknown> | null;
  return {
    status: STATUS.get(v.status ?? '') ?? v.status,
    id: v.paymentKey,
    transactionId: v.txId,
    storeId: PORTONE_STORE_ID,
    channel: { type: 'TEST', pgProvider: 'SIMULATOR' },
    version: 'V2',
    requestedAt: v.requestedAt,
    updatedAt: v.requestedAt,
    statusChangedAt: v.requestedAt,
    orderName: v.orderName,
    amount: { total, taxFree: 0, discount: 0, paid: approved ? total : 0, cancelled: approved ? total - balance : 0, cancelledTaxFree: 0 },
    currency: 'KRW',
    customer: {},
    origin: {},
    disputes: [],
    ...(approved ? { paidAt: v.approvedAt, pgTxId: v.lastTransactionKey } : {}),
    method: METHOD_TYPE.has(v.method) ? { type: METHOD_TYPE.get(v.method) } : { type: 'PaymentMethodCard', ...(card ? { card: portoneCard(card) } : {}) },
  };
}

/** 시뮬레이터 웹훅 시크릿 기본값(옵션을 주지 않았을 때 시험 키에서 만든다). whsec_ + base64다 */
export function defaultPortoneWebhookSecret(secretKey: string): string {
  return `whsec_${createHash('sha256').update(`portone-webhook:${secretKey}`).digest('base64')}`;
}

/** Standard Webhooks 서명 머리를 붙인 포트원 웹훅 사건(보낼 본문 그대로의 글) */
export function portoneWebhookEvents(events: readonly WebhookEvent[], secret: string): Array<{ headers: Record<string, string>; body: string }> {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const out: Array<{ headers: Record<string, string>; body: string }> = [];
  for (const e of events) {
    const data = e.body.data as { status?: string; paymentKey?: string };
    const type = WEBHOOK_TYPE.get(data.status ?? '');
    if (type === undefined) continue;
    const id = e.headers['tosspayments-webhook-transmission-id']!;
    const timestamp = String(Math.floor(Date.parse(e.body.createdAt) / 1000));
    const body = JSON.stringify({ type, timestamp: e.body.createdAt, data: { storeId: PORTONE_STORE_ID, paymentId: data.paymentKey, transactionId: e.txId } });
    const signature = `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
    out.push({ headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature }, body });
  }
  return out;
}

/** Idempotency-Key 머리(구조화 필드 sf-string)를 읽는다. 없으면 undefined, 규격에 맞지 않으면 null */
export function parsePortoneIdempotencyKey(header: string | string[] | undefined): string | null | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string') return null;
  const m = /^"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/.exec(header);
  if (!m) return null;
  const key = m[1]!.replace(/\\(["\\])/g, '$1');
  return key.length >= 16 && key.length <= 256 ? key : null;
}
