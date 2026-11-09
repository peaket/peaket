// 주문 만들기의 값(SCR-011, docs/features/payment.md §2 '주문 생성의 첫 구현', docs/api/openapi.yaml createOrder, ADR-0228).

/** 이 화면에 보인 두 고지 문안의 판. 서버의 PEAKET_ORDER_CONSENT_VERSION과 같아야 하고, 다르면 422 consent-version-outdated로 다시 동의받는다 */
export const ORDER_CONSENT_VERSION = '2026-10-30';

export interface StoredAdmissionRef {
  admissionToken: string;
  serverEcdhPublicKey?: Record<string, string>;
  purchaseSessionExpiresAt?: string;
}

export type CheckoutRefs = { kind: 'ok'; admission: StoredAdmissionRef; holdId: string } | { kind: 'no-admission' } | { kind: 'no-hold' };

function readJson(storage: Pick<Storage, 'getItem'>, key: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 탭 저장소의 입장 저장값과 홀드(좌석 화면이 넣었다, docs/frontend.md §3.12) */
export function readCheckoutRefs(eventId: string, storage: Pick<Storage, 'getItem'>): CheckoutRefs {
  const admission = readJson(storage, `peaket.admission.${eventId}`);
  if (typeof admission?.admissionToken !== 'string' || !admission.admissionToken) return { kind: 'no-admission' };
  const holdId = readJson(storage, `peaket.hold.${eventId}`)?.holdId;
  if (typeof holdId !== 'string' || !holdId) return { kind: 'no-hold' };
  return { kind: 'ok', admission: admission as unknown as StoredAdmissionRef, holdId };
}

/** 예매자 입력 오류(서버 기준과 같다. 없으면 빈 객체) */
export function buyerErrors(name: string, phone: string): { name?: string; phone?: string } {
  const out: { name?: string; phone?: string } = {};
  const n = name.trim();
  if (!n) out.name = '예매자 이름을 입력해 주세요';
  else if ([...n].length > 100) out.name = '예매자 이름은 100자 이하로 입력해 주세요';
  // eslint-disable-next-line no-control-regex -- 제어 문자를 막으려고 쓴다(서버와 같은 범위)
  else if (/[\u0000-\u001f\u007f-\u009f]/.test(n)) out.name = '예매자 이름에 쓸 수 없는 글자가 있습니다';
  const raw = phone.trim();
  if (!raw) out.phone = '휴대폰 번호를 입력해 주세요';
  else if (!isPhone(raw)) out.phone = '휴대폰 번호 자릿수가 맞지 않습니다. 숫자 10~11자리로 입력해 주세요.';
  return out;
}

function isPhone(raw: string): boolean {
  const digits = raw.replace(/[\s-]/g, '');
  if (/^(\+82|0082)/.test(digits)) return /^\d{9,10}$/.test(digits.replace(/^(\+82|0082)0?/, ''));
  return /^0\d{9,10}$/.test(digits);
}

export type OrderOutcome =
  | { kind: 'refresh' }
  | { kind: 'ended' }
  | { kind: 'no-id' }
  | { kind: 'restricted' }
  | { kind: 'hold-gone' }
  | { kind: 'other-tab'; orderId?: string }
  | { kind: 'sale-ended' }
  | { kind: 'sale-paused' }
  | { kind: 'consent' }
  | { kind: 'input' }
  | { kind: 'retry' };

/** 주문 실패 → 화면(createOrder 응답표, docs/frontend.md §5.3 '401') */
export function orderOutcome(e: { status?: number; type?: string; extensions?: Record<string, unknown> }): OrderOutcome {
  switch (e.status) {
    case 401:
      return !e.type || e.type === 'about:blank' || e.type.startsWith('http-') ? { kind: 'refresh' } : { kind: 'ended' };
    case 403:
      if (e.type === 'identity-verification-required') return { kind: 'no-id' };
      if (e.type === 'booking-restricted') return { kind: 'restricted' };
      return { kind: 'ended' };
    case 404:
      return { kind: 'hold-gone' };
    case 409:
      // 같은 멱등 키의 앞 요청이 아직 처리 중이면(idempotency-request-in-progress) 다시 시도한다
      if (e.type === 'hold-already-ordered') return typeof e.extensions?.orderId === 'string' ? { kind: 'other-tab', orderId: e.extensions.orderId } : { kind: 'other-tab' };
      return { kind: 'retry' };
    case 410:
      return { kind: 'sale-ended' };
    case 423:
      return { kind: 'sale-paused' };
    case 422:
      return { kind: 'consent' };
    case 400:
      return { kind: 'input' };
    default:
      return { kind: 'retry' };
  }
}

/** 멱등 키: 같은 본문을 다시 보내면 같은 키(docs/frontend.md §4.1 '멱등키'), 본문이 바뀌면 새 키 */
export function orderIdempotencyKey(prev: { key: string; body: string } | null, body: string, make: () => string): { key: string; body: string } {
  return prev && prev.body === body ? prev : { key: make(), body };
}

export interface GradeLine {
  grade: string;
  price: number;
  quantity: number;
}

/** 등급·가격이 같은 좌석을 한 줄로 묶는다(금액은 서버가 준 값 그대로) */
export function gradeLines(seats: ReadonlyArray<{ tierName?: string; tierId: string; price: number }>): GradeLine[] {
  const lines = new Map<string, GradeLine>();
  for (const s of seats) {
    const grade = s.tierName ?? s.tierId;
    const key = `${grade}|${s.price}`;
    const line = lines.get(key);
    if (line) line.quantity += 1;
    else lines.set(key, { grade, price: s.price, quantity: 1 });
  }
  return [...lines.values()];
}

/** 회차 시각 한 줄 '11. 28. (토) 19:00'(한국 시각). 값이 틀리면 빈 글 */
export function roundText(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.month}. ${p.day}. (${p.weekday}) ${p.hour}:${p.minute}`;
}
