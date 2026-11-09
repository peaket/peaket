// 결제 시도의 값(SCR-011, docs/frontend.md §5.3 '결제사 SDK 싣기', docs/features/payment.md §2 '결제 시도 시작의 첫 구현', BUILD_ORDER HOT-358).

export type PaymentPg = 'TOSS' | 'PORTONE' | 'SIMULATOR';
export type PayMethod = 'CARD' | 'EASY_PAY' | 'TRANSFER' | 'VIRTUAL_ACCOUNT' | 'MOBILE';

export interface TossCheckout {
  clientKey: string;
  customerKey: string;
  orderId: string;
  orderName: string;
  amount: number;
  successUrl: string;
  failUrl: string;
}

export interface PortoneCheckout {
  storeId: string;
  channelKey: string;
  paymentId: string;
  orderName: string;
  totalAmount: number;
  currency: string;
  redirectUrl: string;
  customer?: Record<string, string>;
  customData?: { orderId: string };
}

export interface PaymentAttempt {
  attemptId: string;
  pg: PaymentPg;
  switched?: boolean;
  holdExpiresAt?: string;
  allowedPayMethods?: PayMethod[];
  checkout: TossCheckout | PortoneCheckout;
}

export type AttemptOutcome =
  | { kind: 'refresh' }
  | { kind: 'ended' }
  | { kind: 'hold-gone' }
  /** 이미 접수된 주문: 결과 화면으로 간다 */
  | { kind: 'already-accepted' }
  | { kind: 'order-expired' }
  | { kind: 'exceeded' }
  | { kind: 'sale-paused' }
  /** 503 new-payment-paused: 멈춘 동안 다시 시도한다 */
  | { kind: 'pay-paused'; holdRemainingSeconds?: number; retryAfterSeconds?: number }
  /** 일시 장애(503 pg-unavailable 등): 다시 시도할 수 있다 */
  | { kind: 'unavailable' }
  | { kind: 'bad-method' }
  | { kind: 'retry' };

/** 결제 시도 실패 → 화면(createOrderPayment 응답표). 모르는 코드는 다시 시도(확정 실패로 단정하지 않는다) */
export function attemptOutcome(e: { status?: number; type?: string; extensions?: Record<string, unknown>; retryAfterSeconds?: number }): AttemptOutcome {
  switch (e.status) {
    case 401:
      return !e.type || e.type === 'about:blank' || e.type.startsWith('http-') ? { kind: 'refresh' } : { kind: 'ended' };
    case 403:
      return { kind: 'ended' };
    case 404:
      return { kind: 'hold-gone' };
    case 409:
      if (e.type === 'payment-already-accepted') return { kind: 'already-accepted' };
      if (e.type === 'order-expired') return { kind: 'order-expired' };
      if (e.type === 'payment-attempts-exceeded') return { kind: 'exceeded' };
      return { kind: 'retry' };
    case 423:
      return { kind: 'sale-paused' };
    case 400:
      return { kind: 'bad-method' };
    case 503: {
      if (e.type !== 'new-payment-paused') return { kind: 'unavailable' };
      const left = e.extensions?.holdRemainingSeconds;
      return { kind: 'pay-paused', ...(typeof left === 'number' ? { holdRemainingSeconds: left } : {}), ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}) };
    }
    default:
      return { kind: 'retry' };
  }
}

/** 주문별 시도 멱등 키(탭 저장소). opened는 이 키의 결제창을 실제로 열었는가다 */
export interface AttemptKeyRecord {
  key: string;
  method: string;
  opened: boolean;
}

/** 시도 멱등 키: 결제창을 열기 전 같은 수단이면 같은 키(재생이라 행이 늘지 않는다, P-T25), 창을 열었거나 수단이 바뀌면 새 키 */
export function nextAttemptKey(prev: AttemptKeyRecord | null, method: string, make: () => string): AttemptKeyRecord {
  return prev && !prev.opened && prev.method === method ? prev : { key: make(), method, opened: false };
}

/** 저장값 → 기록. 모양이 틀리면 null(다시 만든다) */
export function readAttemptKey(raw: string | null): AttemptKeyRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AttemptKeyRecord> | null;
    return v && typeof v.key === 'string' && v.key && typeof v.method === 'string' && typeof v.opened === 'boolean' ? { key: v.key, method: v.method, opened: v.opened } : null;
  } catch {
    return null;
  }
}

/** 응답 본문 → PaymentAttempt. 모양이 틀리면 null(그대로 쓰지 않는다) */
export function attemptOf(v: unknown): PaymentAttempt | null {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as Partial<PaymentAttempt>;
  if (typeof a.attemptId !== 'string' || (a.pg !== 'TOSS' && a.pg !== 'PORTONE' && a.pg !== 'SIMULATOR') || typeof a.checkout !== 'object' || a.checkout === null) return null;
  return a as PaymentAttempt;
}

/** 토스 위젯이 고른 수단이 서버가 허용한 수단인가(BUILD_ORDER PRF-190). 모르는 값은 허용하지 않는다 */
export function tossMethodAllowed(method: string, allowed: readonly PayMethod[] | undefined): boolean {
  if (!allowed) return false;
  switch (method) {
    case 'CARD':
    case 'BRANDPAY':
      return allowed.includes('CARD');
    case 'TRANSFER':
      return allowed.includes('TRANSFER');
    case 'VIRTUAL_ACCOUNT':
      return allowed.includes('VIRTUAL_ACCOUNT');
    case 'MOBILE_PHONE':
      return allowed.includes('MOBILE');
    case 'FOREIGN_EASY_PAY':
      return allowed.includes('EASY_PAY');
    case 'CUSTOM':
      return allowed.includes('EASY_PAY');
    default:
      return false;
  }
}

/** 시도 멱등 키의 탭 저장소 키. 앞머리 peaket.checkout.은 끝날 때(접수·홀드 만료·세션 끝) 함께 지워진다(docs/frontend.md §3.12) */
export const attemptKeyStorageKey = (orderId: string): string => `peaket.checkout.attempt.${orderId}`;

/** 접수 때 싣는 attemptId의 탭 저장소 키(docs/frontend.md §5.3 '결제창 방식') */
export const attemptStorageKey = (orderId: string): string => `peaket.attempt.${orderId}`;
