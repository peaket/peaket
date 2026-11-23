// SCR-014 티켓 양도 실제 흐름(계획 docs/review/plans/F-05-2.md §4 '웹 모듈'·§5 T9·T10·T13·T14·T15).
// 화면 상태·오류 문구는 d5 §5.14·§9.2에서, 재인증 목적·제공자 규칙은 identity I-T54 ④에서 온다.
// 팬 API 경계만 주입한다(origin·fetch). 시각은 인자로 받아 실제 시계를 기다리지 않는다.
import type { Scr014State } from '../../../shared/config/screens.booking.ts';

export type TransferResult<T> =
  | { kind: 'ok'; body: T }
  | { kind: 'problem'; status: number; type: string; retryAfterSec?: number }
  | { kind: 'network' };

export interface TransferTicketBody {
  readonly ticketId?: string;
  readonly eventId?: string;
  readonly status?: string;
  readonly transferable?: boolean;
  readonly transferLocked?: boolean;
  readonly transferLockExpiresAt?: string | null;
  readonly transferDeadline?: string;
  readonly eventStartsAt?: string;
  readonly cancelDeadline?: string;
  readonly receivedFromNickname?: string | null;
  readonly pendingTransfer?: { readonly offerId: string; readonly expiresAt: string } | null;
}

export interface TransferOfferBody {
  readonly offerId: string;
  readonly ticketId?: string;
  readonly role?: string;
  readonly status: string;
  readonly expiresAt?: string;
  readonly eventId?: string;
  readonly withdrawReason?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface Net {
  readonly origin: string;
  readonly fetch: FetchLike;
}

/** 받는 사람 참조 수명(10분 [가정], transfer-refund §4). 그 시각과 같으면 못 쓴다 */
export const RECIPIENT_REF_TTL_MS = 10 * 60_000;

const problemTypeOf = async (r: Response): Promise<string> => {
  try {
    const b = (await r.json()) as { type?: unknown } | null;
    if (b && typeof b.type === 'string') return b.type.split('/').filter(Boolean).pop() ?? 'about:blank';
  } catch {
    // 본문이 JSON이 아니다
  }
  return `http-${r.status}`;
};

const retryAfterOf = (r: Response): number | undefined => {
  const raw = r.headers.get('retry-after');
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

async function reader<T>(r: Response): Promise<TransferResult<T>> {
  if (r.status === 200 || r.status === 201) {
    try {
      return { kind: 'ok', body: (await r.json()) as T };
    } catch {
      return { kind: 'problem', status: r.status, type: 'bad-response' };
    }
  }
  const retryAfterSec = retryAfterOf(r);
  return { kind: 'problem', status: r.status, type: await problemTypeOf(r), ...(retryAfterSec === undefined ? {} : { retryAfterSec }) };
}

async function send<T>(net: Net, method: 'GET' | 'POST', path: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<TransferResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json', ...(o.headers ?? {}) };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  try {
    const r = await net.fetch(`${net.origin}${path}`, {
      method,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      headers,
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    });
    return await reader<T>(r);
  } catch {
    // 연결 실패·시간 초과·이동 응답(redirect: 'error')
    return { kind: 'network' };
  }
}

/** 받은 티켓인가. 결제자가 보유한 표는 receivedFromNickname이 null이고, 받은 표는 문자열이다 */
const isReceived = (t: TransferTicketBody): boolean => typeof t.receivedFromNickname === 'string' && t.receivedFromNickname.length > 0;

const future = (iso: string | null | undefined, nowMs: number): boolean => typeof iso === 'string' && Number.isFinite(Date.parse(iso)) && Date.parse(iso) > nowMs;

/**
 * 상세 → SCR-014 상태 이름(d5 §5.14 상태 표). 차례: 받은 티켓 → 진행 중 요청 → 잠김 → 양도 불가/모름 → 마감 → 양식.
 * 칸이 없으면 '양도 가능'으로 읽지 않는다(계획 §10).
 */
export function transferStateOf(t: TransferTicketBody, nowMs: number): Scr014State {
  if (isReceived(t)) return '양도 불가 · 받은 티켓';
  if (t.pendingTransfer && future(t.pendingTransfer.expiresAt, nowMs)) return '요청 보냄';
  if (t.transferLocked === true && (t.transferLockExpiresAt === null || t.transferLockExpiresAt === undefined || future(t.transferLockExpiresAt, nowMs))) {
    return '부정 예매 조사로 잠김';
  }
  if (typeof t.transferDeadline === 'string' && Number.isFinite(Date.parse(t.transferDeadline)) && nowMs >= Date.parse(t.transferDeadline)) return '양도 불가 · 마감 지남';
  if (t.transferable !== true) return '양도 불가 상품';
  return '받는 사람 확인';
}

export interface TransferFailure {
  readonly state: Scr014State;
  readonly text: string;
  /** 받는 사람 참조가 만료돼 다시 찾아야 하는가 */
  readonly relookup: boolean;
}

const typeOf = (p: { type: string }): string => p.type.split('/').filter(Boolean).pop() ?? p.type;

/** d5 §9.2 양도 요청 409 transfer-locked 문구(상태 글 §5.14와 달리 '입장 시작' 줄이 없다) */
const transferLocked409Text = (expiresText: string): string =>
  `부정 예매 조사가 끝날 때까지 이 티켓은 양도할 수 없습니다. 늦어도 ${expiresText}에 풀립니다. 입장과 직접 취소는 그대로 할 수 있습니다`;

const lockDateText = (iso: string): string => {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  try {
    return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
  } catch {
    return iso;
  }
};

/** 409·404·429를 d5 §5.14·§9.2 문구로 가른다. 서버 title·detail은 쓰지 않는다 */
export function transferFailureOf(
  step: 'lookup' | 'request' | 'withdraw',
  p: { status: number; type: string },
  o: { lockExpiresAt?: string } = {},
): TransferFailure {
  const type = typeOf(p);
  if (step === 'lookup' && p.status === 404) return { state: '비회원·본인확인 전', text: '본인확인을 마친 피켓 회원에게만 양도할 수 있습니다', relookup: false };
  if (step === 'lookup' && p.status === 429) return { state: '확인 시도 초과', text: '잠시 뒤 다시 확인해 주세요', relookup: false };
  if (p.status === 403 && type === 'reauth-required') {
    return { state: '재인증 만료', text: '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다. 다시 로그인해 주세요', relookup: false };
  }
  if (step === 'withdraw' && p.status === 409) return { state: '철회 불가', text: '이미 처리된 요청입니다', relookup: false };
  if (step === 'request' && p.status === 409 && type === 'reoffer-not-allowed') {
    return { state: '양도 불가 · 받은 티켓', text: '받은 티켓은 다시 양도할 수 없고 결제한 분에게 돌려주기만 할 수 있습니다', relookup: false };
  }
  if (p.status === 409 && type === 'transfer-closed') return { state: '양도 불가 · 마감 지남', text: '양도 가능 시간이 지났습니다', relookup: false };
  if (p.status === 409 && type === 'transfer-locked') {
    return {
      state: '오류 · transfer-locked',
      text: transferLocked409Text(o.lockExpiresAt === undefined ? '잠금 기한' : lockDateText(o.lockExpiresAt)),
      relookup: false,
    };
  }
  if (p.status === 400 && type === 'invalid-body') return { state: '받는 사람 확인', text: '받는 사람을 다시 확인해 주세요', relookup: true };
  return { state: '받는 사람 확인', text: '잠시 뒤 다시 시도해 주세요', relookup: false };
}

/** I-T54 ④: 카카오를 먼저, 없으면 네이버. 둘 다 없으면 undefined */
export function reauthProviderFor(linked: readonly string[]): string | undefined {
  if (linked.includes('kakao')) return 'kakao';
  if (linked.includes('naver')) return 'naver';
  return undefined;
}

/** 재인증 목적과 돌아올 주소(티켓 ID만, 회원 코드·참조·닉네임 없음 — ASVS 14.2.1) */
export function transferReauthTarget(ticketId: string): { readonly purpose: 'transfer-request'; readonly returnTo: string } {
  return { purpose: 'transfer-request', returnTo: `/my/tickets/${encodeURIComponent(ticketId)}/transfer` };
}

/** 받는 사람 참조가 아직 쓸 수 있는가(10분 − 1ms는 참, 10분 0ms는 거짓) */
export function recipientRefUsable(lookedUpAtMs: number, nowMs: number): boolean {
  return nowMs - lookedUpAtMs < RECIPIENT_REF_TTL_MS;
}

/** ⑥ 카드의 남은 시간(d5 §5.14 '시:분'). 지났으면 '0:00' */
export function remainingText(expiresAt: string, nowMs: number): string {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return '0:00';
  const minutes = Math.max(0, Math.floor((at - nowMs) / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** 같은 받는 사람 참조로 다시 보내면 같은 멱등 키, 참조가 바뀌면 새 키(FRN 계획 §5 T15) */
export function transferAttemptFor(
  prev: { readonly recipientRef: string; readonly key: string } | null,
  recipientRef: string,
  makeKey: () => string,
): { readonly recipientRef: string; readonly key: string } {
  if (prev !== null && prev.recipientRef === recipientRef) return prev;
  return { recipientRef, key: makeKey() };
}

export function loadTransferTicket(i: { readonly ticketId: string } & Net): Promise<TransferResult<TransferTicketBody>> {
  return send<TransferTicketBody>(i, 'GET', `/v1/tickets/${encodeURIComponent(i.ticketId)}`);
}

export function lookupRecipient(i: { readonly memberCode: string } & Net): Promise<TransferResult<{ recipientRef: string; nicknameMasked: string }>> {
  return send(i, 'POST', '/v1/transfer-recipient-lookups', { body: { memberCode: i.memberCode } });
}

export function sendTransferRequest(
  i: {
    readonly ticketId: string;
    readonly recipientRef: string;
    readonly reauthToken: string;
    readonly idempotencyKey: string;
  } & Net,
): Promise<TransferResult<TransferOfferBody>> {
  return send(i, 'POST', `/v1/tickets/${encodeURIComponent(i.ticketId)}/transfers`, {
    body: { recipientRef: i.recipientRef },
    headers: { 'idempotency-key': i.idempotencyKey, 'x-reauth-token': i.reauthToken },
  });
}

/** 연결한 로그인 수단(제공자 이름). 재인증 제공자를 고르는 데 쓴다(I-T54 ④) */
export async function loadLinkedProviders(net: Net): Promise<string[]> {
  try {
    const r = await net.fetch(`${net.origin}/v1/identity/providers`, { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' } });
    if (r.status !== 200) return [];
    const b = (await r.json()) as { providers?: { provider?: unknown }[] };
    return (b.providers ?? []).map((p) => p.provider).filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return [];
  }
}

export function withdrawTransferRequest(i: { readonly offerId: string; readonly idempotencyKey: string } & Net): Promise<TransferResult<TransferOfferBody>> {
  return send(i, 'POST', `/v1/transfers/${encodeURIComponent(i.offerId)}/withdrawal`, {
    headers: { 'idempotency-key': i.idempotencyKey },
  });
}
