// 결제창 복귀의 값(SCR-011, docs/frontend.md §5.3 '복귀 화면'·§3.12, openapi PaymentAccept, ADR-0229). 주소의 결제 값을 읽고, 접수 사실만 탭 저장소에 둔다.

export type AcceptBody = { pg: 'TOSS' | 'SIMULATOR'; paymentKey: string; amount: number } | { pg: 'PORTONE'; paymentId: string; paymentToken: string; txId: string };

export type ReturnValues = { kind: 'success'; orderId: string; body: AcceptBody } | { kind: 'fail'; orderId?: string; cancelled: boolean } | { kind: 'none' };

/** 결제창 복귀 주소를 읽는다. 우리가 넘긴 `order`로 주문을 알고(토스의 orderId는 결제사 쪽 번호다), 값이 모자라면 접수하지 않는다 */
export function parseReturn(search: string): ReturnValues {
  const q = new URLSearchParams(search);
  const orderId = q.get('order') ?? undefined;
  const code = q.get('code');
  // 결제사가 준 실패 글은 화면에 옮기지 않고 코드로만 가른다
  if (code) return { kind: 'fail', ...(orderId ? { orderId } : {}), cancelled: code === 'PAY_PROCESS_CANCELED' || code === 'PAY_PROCESS_ABORTED' || code === 'USER_CANCEL' };
  if (!orderId) return { kind: 'none' };
  const paymentKey = q.get('paymentKey');
  if (paymentKey) {
    const amount = Number(q.get('amount') ?? Number.NaN);
    if (!Number.isSafeInteger(amount)) return { kind: 'none' };
    return { kind: 'success', orderId, body: { pg: q.get('pg') === 'SIMULATOR' ? 'SIMULATOR' : 'TOSS', paymentKey, amount } };
  }
  const paymentId = q.get('paymentId');
  const paymentToken = q.get('paymentToken');
  const txId = q.get('txId');
  if (paymentId && paymentToken && txId) return { kind: 'success', orderId, body: { pg: 'PORTONE', paymentId, paymentToken, txId } };
  return { kind: 'none' };
}

export interface AcceptRecord {
  eventId: string;
  /** 멱등 키(결제사 값은 넣지 않는다, §3.12) */
  key: string;
  at: number;
}

const acceptKey = (orderId: string): string => `peaket.accept.${orderId}`;

export function writeAcceptRecord(s: Pick<Storage, 'setItem'>, orderId: string, r: AcceptRecord): void {
  s.setItem(acceptKey(orderId), JSON.stringify(r));
}

export function readAcceptRecord(s: Pick<Storage, 'getItem'>, orderId: string): AcceptRecord | null {
  try {
    const v = JSON.parse(s.getItem(acceptKey(orderId)) ?? 'null') as Partial<AcceptRecord> | null;
    return v && typeof v.key === 'string' && typeof v.eventId === 'string' ? (v as AcceptRecord) : null;
  } catch {
    return null;
  }
}

/** 새로고침으로 주소의 값을 잃었을 때 이 회차에서 가장 나중에 접수한 주문 ID를 찾는다 */
export function findAcceptRecord(s: Pick<Storage, 'getItem' | 'key' | 'length'>, eventId: string): string | null {
  let found: { orderId: string; at: number } | null = null;
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (!k?.startsWith('peaket.accept.')) continue;
    const orderId = k.slice('peaket.accept.'.length);
    const r = readAcceptRecord(s, orderId);
    if (r?.eventId === eventId && (!found || r.at > found.at)) found = { orderId, at: r.at };
  }
  return found?.orderId ?? null;
}

export type AcceptOutcome = { kind: 'mismatch' } | { kind: 'refresh' } | { kind: 'ended' } | { kind: 'other-tab' } | { kind: 'not-finished' } | { kind: 'order-expired' } | { kind: 'retry' };

/** 결제 접수 실패 → 화면(openapi createOrderPaymentAcceptance 응답표) */
export function acceptOutcome(e: { status?: number; type?: string }): AcceptOutcome {
  switch (e.status) {
    case 400:
      return { kind: 'mismatch' };
    case 401:
      return !e.type || e.type === 'about:blank' || e.type.startsWith('http-') ? { kind: 'refresh' } : { kind: 'ended' };
    case 404:
      return { kind: 'not-finished' };
    case 409:
      if (e.type === 'payment-already-accepted') return { kind: 'other-tab' };
      if (e.type === 'payment-attempt-mismatch') return { kind: 'mismatch' };
      if (e.type === 'order-expired') return { kind: 'order-expired' };
      return { kind: 'retry' };
    default:
      return { kind: 'retry' };
  }
}

/** 결제창에 넘길 복귀 주소(토스 successUrl·failUrl, 포트원 redirectUrl). 결제창 이동을 잇는 HOT-358이 이 값을 쓴다 */
export function paymentReturnUrls(origin: string, eventId: string, orderId: string, pg: 'TOSS' | 'SIMULATOR' | 'PORTONE'): { successUrl: string; failUrl: string; redirectUrl: string } {
  const url = `${origin}/booking/${encodeURIComponent(eventId)}/checkout/return?order=${encodeURIComponent(orderId)}&pg=${pg}`;
  return { successUrl: url, failUrl: url, redirectUrl: url };
}
