// BAT-455 GAT-250 팬 알림의 순수 규칙: 신청 상태·문구 변수·재시도·밤 판정·수신 거부 토큰·웹 푸시 주소·키.
// 정본: docs/features/notify.md §3·§4·§7·§10, docs/security/asvs/notify.md, ADR-0109·0155.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export type SubscriptionKind = 'OPEN' | 'CANCELLATION';
export type SubscriptionStatus = 'ACTIVE' | 'ENDED';
export type SubscriptionEndReason = 'SENT_MAX' | 'BOOKED' | 'SALE_ENDED';
export type NotificationChannel = 'EMAIL' | 'WEB_PUSH' | 'ALIMTALK' | 'SMS';
export type JobStatus = 'PENDING' | 'RETRYING' | 'DEAD';
export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'DEAD' | 'EXPIRED';
export type PushService = 'FCM' | 'MOZILLA' | 'APPLE' | 'WNS';
export type FanNoticeKind =
  | 'EVENT_CANCELLATION_CONFIRMED'
  | 'EVENT_POSTPONED'
  | 'REFUNDED'
  | 'REFUND_FAILED'
  | 'LOGIN_METHOD_LINKED'
  | 'LOGIN_METHOD_UNLINKED'
  | 'ACCOUNT_MERGED'
  | 'DEVICE_KEY_REISSUED'
  | 'DEVICE_KEY_LATE_ISSUE'
  | 'OPEN_LOBBY'
  | 'OPEN_VERIFY'
  | 'CANCELLATION_ALERT'
  | 'AD';

export const SUBSCRIPTION_LIMIT = 200;
export const PUSH_SUBSCRIPTION_LIMIT = 10;
export const NOTIFY_LEASE_MS = 120_000;
export const NOTIFY_MAX_ATTEMPTS = 6;
/** 이메일·푸시 재시도 간격(1분·5분·30분·2시간·6시간·12시간 [가정], notify §10) */
const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000] as const;
export const notificationRetryDelayMs = (attempt: number): number => RETRY_DELAYS_MS[Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, attempt - 1))]!;
/** 결과를 모르는 실패를 한 번 더 보내도 되는 돈·보안·법정 통지(notify §10, d5 §9.1.1) */
const DUBIOUS_RETRY_KINDS: ReadonlySet<FanNoticeKind> = new Set(['EVENT_CANCELLATION_CONFIRMED', 'EVENT_POSTPONED', 'REFUNDED', 'REFUND_FAILED', 'DEVICE_KEY_REISSUED', 'DEVICE_KEY_LATE_ISSUE']);
export const needsDubiousRetry = (kind: FanNoticeKind): boolean => DUBIOUS_RETRY_KINDS.has(kind);
/** 신청 알림(신청 하나에 묶인 알림) */
const SUBSCRIPTION_KINDS: ReadonlySet<FanNoticeKind> = new Set(['OPEN_LOBBY', 'OPEN_VERIFY', 'CANCELLATION_ALERT']);
export const isSubscriptionNotice = (kind: FanNoticeKind): boolean => SUBSCRIPTION_KINDS.has(kind);
/** 밤에도 웹 푸시를 보내지 않는 채널 규칙: 이메일은 늘 보내고 웹 푸시만 nightPush를 본다 */
export const nightSkipsWebPush = (kind: FanNoticeKind): boolean => kind !== 'AD';

export const FAN_NOTICE_KINDS: readonly FanNoticeKind[] = [
  'EVENT_CANCELLATION_CONFIRMED',
  'EVENT_POSTPONED',
  'REFUNDED',
  'REFUND_FAILED',
  'LOGIN_METHOD_LINKED',
  'LOGIN_METHOD_UNLINKED',
  'ACCOUNT_MERGED',
  'DEVICE_KEY_REISSUED',
  'DEVICE_KEY_LATE_ISSUE',
  'OPEN_LOBBY',
  'OPEN_VERIFY',
  'CANCELLATION_ALERT',
  'AD',
];

/** 입장 키 알림 종류(docs/features/notify.md §4.7, ADR-0363 결정 4) */
export type TicketKeyNoticeKind = Extract<FanNoticeKind, 'DEVICE_KEY_REISSUED' | 'DEVICE_KEY_LATE_ISSUE'>;
export const TICKET_KEY_NOTICE_KINDS: readonly TicketKeyNoticeKind[] = ['DEVICE_KEY_REISSUED', 'DEVICE_KEY_LATE_ISSUE'];

/**
 * 입장 키 알림의 중복 키 `{type}:{ticketId}:{noticeId}:{accountId}:{채널}`(notify §4.3·§4.7). 웹 푸시는 그 계정의 구독마다 작업 하나라
 * 채널 칸 뒤에 구독 키(구독 주소 SHA-256 base64url)를 붙인다. 워커는 그 구독에만 보낸다(webPushTargetOf)
 */
export function ticketKeyNoticeDedupKey(o: { type: TicketKeyNoticeKind; ticketId: string; noticeId: string; accountId: string; channel: 'EMAIL' | 'WEB_PUSH'; subscriptionKey?: string }): string {
  const base = `${o.type}:${o.ticketId}:${o.noticeId}:${o.accountId}:${o.channel}`;
  return o.channel === 'WEB_PUSH' && o.subscriptionKey ? `${base}:${o.subscriptionKey}` : base;
}

const SUBSCRIPTION_KEY = /^[A-Za-z0-9_-]{43}$/;

/** 구독 하나에 묶인 웹 푸시 작업이면 그 구독 키. 계정 단위 작업(로그인 수단·병합 등)이면 undefined(그 계정의 모든 구독에 보낸다) */
export function webPushTargetOf(kind: string, dedupKey: string): string | undefined {
  if (!(TICKET_KEY_NOTICE_KINDS as readonly string[]).includes(kind)) return undefined;
  const parts = dedupKey.split(':');
  if (parts.length !== 6 || parts[4] !== 'WEB_PUSH') return undefined;
  const key = parts[5]!;
  return SUBSCRIPTION_KEY.test(key) ? key : undefined;
}

/** 문안 변수 허용 목록(notify §12). 주소·전화번호·이름은 종류를 가리지 않고 받지 않는다 */
const VARS_ALLOWED: Record<FanNoticeKind, readonly string[]> = {
  EVENT_CANCELLATION_CONFIRMED: ['fanNoticeReason'],
  EVENT_POSTPONED: ['fanNoticeReason', 'postponedTo', 'refundWindowClosesAt'],
  REFUNDED: ['refundAmount'],
  REFUND_FAILED: ['fanNoticeReason'],
  LOGIN_METHOD_LINKED: ['provider'],
  LOGIN_METHOD_UNLINKED: ['provider'],
  ACCOUNT_MERGED: [],
  DEVICE_KEY_REISSUED: ['type', 'registeredAt', 'ticketId'],
  DEVICE_KEY_LATE_ISSUE: ['type', 'registeredAt', 'ticketId'],
  OPEN_LOBBY: ['title', 'body', 'url'],
  OPEN_VERIFY: ['title', 'body', 'url'],
  CANCELLATION_ALERT: ['title', 'body', 'url', 'eventTitle', 'startsAt'],
  AD: ['title', 'body', 'url', 'sender', 'contact', 'unsubscribeUrl'],
};
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_LIKE = /(?:\+?82[-\s]?)?0?1[016789][-\s]?\d{3,4}[-\s]?\d{4}/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_KEYS = new Set(['email', 'phone', 'name', 'address', 'accountNumber', 'pid', 'ticketNumber', 'seatNumber']);
export const VARS_MAX_BYTES = 1024;

export type Vars = Record<string, string | number | boolean | null>;

export class FanNotifyProblem extends Error {
  constructor(
    readonly code:
      | 'INVALID'
      | 'NOT_FOUND'
      | 'OPEN_PASSED'
      | 'SALE_ENDED'
      | 'SUBSCRIPTION_LIMIT'
      | 'PUSH_SERVICE_NOT_ALLOWED'
      | 'PUSH_KEY_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'FanNotifyProblem';
  }
}

const bad = (message: string) => new FanNotifyProblem('INVALID', message);

export function assertVars(kind: FanNoticeKind, vars: Vars | undefined): Vars {
  const v = vars ?? {};
  const allowed = new Set(VARS_ALLOWED[kind]);
  for (const [k, value] of Object.entries(v)) {
    if (FORBIDDEN_KEYS.has(k) || !allowed.has(k)) throw bad(`알림 문구 변수에 넣을 수 없는 키입니다: ${k}`);
    if (value === null) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw bad('알림 문구 변수 숫자가 올바르지 않습니다');
      continue;
    }
    if (typeof value === 'boolean') continue;
    if (typeof value !== 'string') throw bad('알림 문구 변수는 문자열·숫자·불리언이어야 합니다');
    // 티켓 ID(UUID)는 숫자 자리가 우연히 전화번호 꼴과 겹칠 수 있어 UUID 꼴이면 그 검사를 건너뛴다(입장 키 알림의 ticketId, notify §4.7)
    const uuidLike = k === 'ticketId' && UUID_TEXT.test(value);
    if (!uuidLike && (EMAIL_LIKE.test(value) || PHONE_LIKE.test(value))) throw bad('알림 문구 변수에 이메일·전화번호 꼴 값이 있습니다');
    if (/[\u0000-\u001f\u007f]/.test(value)) throw bad('알림 문구 변수에 제어 문자가 있습니다');
  }
  if (Buffer.byteLength(JSON.stringify(v), 'utf8') > VARS_MAX_BYTES) throw bad('알림 문구 변수가 1KB를 넘습니다');
  return v;
}

const PROVIDER: Record<string, string> = { google: '구글', kakao: '카카오', naver: '네이버', apple: '애플' };

export interface NoticeMessage {
  title: string;
  body: string;
  url?: string;
}

/** 종류별 문안. 화면 링크는 같은 출처 상대 경로만 받는다(서비스 워커 허용 경로) */
export function messageOf(kind: FanNoticeKind, vars: Vars): NoticeMessage {
  const text = (k: string): string | undefined => (typeof vars[k] === 'string' ? (vars[k] as string) : undefined);
  const safeUrl = (raw: string | undefined): string | undefined => (raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : undefined);
  switch (kind) {
    case 'EVENT_CANCELLATION_CONFIRMED':
      return { title: '공연이 취소되었습니다', body: text('fanNoticeReason') ?? '회차가 취소되어 환급을 진행합니다.' };
    case 'EVENT_POSTPONED':
      return { title: '공연 일정이 바뀌었습니다', body: text('fanNoticeReason') ?? '새 일정과 환급 신청 기간을 확인해 주세요.' };
    case 'REFUNDED':
      return { title: '환급이 완료되었습니다', body: `환급 금액 ${typeof vars.refundAmount === 'number' ? vars.refundAmount : 0}원이 결제 수단으로 돌아갑니다.` };
    case 'REFUND_FAILED':
      return { title: '환급을 마치지 못했습니다', body: text('fanNoticeReason') ?? '고객센터에서 처리 상황을 확인해 주세요.' };
    case 'LOGIN_METHOD_LINKED': {
      const p = PROVIDER[text('provider') ?? ''] ?? text('provider') ?? '로그인';
      return { title: '로그인 수단을 연결했습니다', body: `${p} 로그인 수단을 연결했습니다. 본인이 아니라면 고객센터에 알려 주세요.`, url: '/my/settings' };
    }
    case 'LOGIN_METHOD_UNLINKED': {
      const p = PROVIDER[text('provider') ?? ''] ?? text('provider') ?? '로그인';
      return { title: '로그인 수단을 해제했습니다', body: `${p} 로그인 수단을 해제했습니다. 본인이 아니라면 고객센터에 알려 주세요.`, url: '/my/settings' };
    }
    case 'ACCOUNT_MERGED':
      return { title: '계정을 합쳤습니다', body: 'PEAKET 계정 두 개를 하나로 합쳤습니다. 예매·알림 설정은 대표 계정에서 확인해 주세요.', url: '/my' };
    case 'DEVICE_KEY_REISSUED':
    case 'DEVICE_KEY_LATE_ISSUE': {
      // 문안은 notify §4.7. 링크는 허용한 앞부분 `/my/`의 티켓 펼침(§3.5)
      const at = kstMinuteText(text('registeredAt'));
      const ticketId = text('ticketId');
      const url = ticketId && UUID_TEXT.test(ticketId) ? `/my/tickets/${ticketId}` : '/my/tickets';
      const body =
        kind === 'DEVICE_KEY_REISSUED'
          ? `티켓 한 장의 입장 키를 ${at}에 새 휴대폰으로 옮겼습니다. 이전 휴대폰의 QR은 더 쓸 수 없습니다. 직접 하신 일이 아니면 고객센터로 알려 주세요`
          : `입장이 시작된 뒤 티켓 한 장을 ${at}에 이 계정의 휴대폰에 등록했습니다. 직접 하신 일이 아니면 고객센터로 알려 주세요`;
      return { title: '티켓 입장 키를 새 휴대폰에 등록했습니다', body, url };
    }
    case 'OPEN_LOBBY':
      return { title: text('title') ?? '대기실이 열렸습니다', body: text('body') ?? '공연 상세에서 대기실에 들어가세요.', ...(safeUrl(text('url')) ? { url: safeUrl(text('url')) } : {}) };
    case 'OPEN_VERIFY':
      return { title: text('title') ?? '본인확인을 마쳐 주세요', body: text('body') ?? '대기실에 들어가려면 휴대폰 본인확인이 필요합니다.', ...(safeUrl(text('url')) ? { url: safeUrl(text('url')) } : {}) };
    case 'CANCELLATION_ALERT':
      return { title: text('title') ?? '취소표가 나왔습니다', body: text('body') ?? '좌석이 돌아왔습니다. 공연 상세에서 확인해 주세요.', ...(safeUrl(text('url')) ? { url: safeUrl(text('url')) } : {}) };
    case 'AD':
      return { title: text('title') ?? '피켓 소식', body: text('body') ?? '', ...(safeUrl(text('url')) ? { url: safeUrl(text('url')) } : {}) };
  }
}

/** 등록 시각(ISO 8601)을 KST 'YYYY-MM-DD HH:mm'으로. 읽지 못하면 '방금' */
function kstMinuteText(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return '방금';
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}(KST)`;
}

/** 21:00:00 이상 08:00:00 미만 KST. 한국은 서머타임이 없어 UTC+9로 계산한다 */
export function isNightKst(nowMs: number): boolean {
  const kstHour = new Date(nowMs + 9 * 60 * 60 * 1000).getUTCHours();
  return kstHour >= 21 || kstHour < 8;
}

export function subscriptionKeyOf(endpoint: string): string {
  return createHash('sha256').update(endpoint, 'utf8').digest('base64url');
}

/** 한 번 누름 수신 거부 토큰: base64url(신청 ID ASCII ‖ HMAC-SHA256(키, ID) 앞 16바이트) */
export function optOutTokenFor(subscriptionId: string, key: string): string {
  const mac = createHmac('sha256', Buffer.from(key, 'base64url')).update(subscriptionId, 'utf8').digest().subarray(0, 16);
  return Buffer.concat([Buffer.from(subscriptionId, 'utf8'), mac]).toString('base64url');
}

export function readOptOutToken(token: string, key: string): string | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(token, 'base64url');
  } catch {
    return null;
  }
  if (raw.length < 16 || raw.length > 80) return null;
  const id = raw.subarray(0, raw.length - 16).toString('utf8');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const got = raw.subarray(raw.length - 16);
  const want = createHmac('sha256', Buffer.from(key, 'base64url')).update(id, 'utf8').digest().subarray(0, 16);
  return timingSafeEqual(got, want) ? id : null;
}

const hostAllowed = (host: string): boolean =>
  host === 'fcm.googleapis.com' ||
  host === 'push.services.mozilla.com' ||
  host.endsWith('.push.services.mozilla.com') ||
  host === 'web.push.apple.com' ||
  host.endsWith('.push.apple.com') ||
  host.endsWith('.notify.windows.com') ||
  host === 'notify.windows.com';

export function pushServiceOf(host: string): PushService {
  if (host === 'fcm.googleapis.com') return 'FCM';
  if (host === 'push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com')) return 'MOZILLA';
  if (host === 'web.push.apple.com' || host.endsWith('.push.apple.com')) return 'APPLE';
  return 'WNS';
}

export interface PushEndpointParts {
  endpoint: string;
  service: PushService;
  host: string;
}

/** 등록 때 주소 검사(https·443·사용자 정보 없음·허용 호스트). IP 해석 검사는 부르는 쪽이 한다 */
export function checkPushEndpoint(raw: string): PushEndpointParts {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FanNotifyProblem('PUSH_SERVICE_NOT_ALLOWED', '구독 주소가 URL이 아닙니다');
  }
  if (raw.length > 1024) throw new FanNotifyProblem('PUSH_SERVICE_NOT_ALLOWED', '구독 주소가 1,024자를 넘습니다');
  if (url.protocol !== 'https:') throw new FanNotifyProblem('PUSH_SERVICE_NOT_ALLOWED', '구독 주소는 https여야 합니다');
  if (url.port !== '' && url.port !== '443') throw new FanNotifyProblem('PUSH_SERVICE_NOT_ALLOWED', '구독 주소는 443 포트만 됩니다');
  if (url.username || url.password) throw new FanNotifyProblem('PUSH_SERVICE_NOT_ALLOWED', '구독 주소에 사용자 정보가 있습니다');
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) throw new FanNotifyProblem('PUSH_SERVICE_NOT_ALLOWED', '구독 주소에 IP를 그대로 쓸 수 없습니다');
  if (!hostAllowed(host)) throw new FanNotifyProblem('PUSH_SERVICE_NOT_ALLOWED', `푸시 서비스 허용 목록 밖입니다: ${host}`);
  return { endpoint: raw, host, service: pushServiceOf(host) };
}

export interface PushKeys {
  p256dh: string;
  auth: string;
}

/** p256dh는 65바이트 비압축 P-256 점(04로 시작), auth는 16바이트 */
export function checkPushKeys(keys: PushKeys): PushKeys {
  let p: Buffer;
  let a: Buffer;
  try {
    p = Buffer.from(keys.p256dh, 'base64url');
    a = Buffer.from(keys.auth, 'base64url');
  } catch {
    throw new FanNotifyProblem('PUSH_KEY_INVALID', '구독 키가 base64url이 아닙니다');
  }
  if (p.length !== 65 || p[0] !== 4) throw new FanNotifyProblem('PUSH_KEY_INVALID', 'p256dh는 65바이트 비압축 P-256 점이어야 합니다');
  if (a.length !== 16) throw new FanNotifyProblem('PUSH_KEY_INVALID', 'auth는 16바이트여야 합니다');
  return keys;
}

export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return false;
    if (v.startsWith('fc') || v.startsWith('fd')) return false;
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return false;
    if (v.startsWith('::ffff:')) return isPublicAddress(v.slice(7));
    return true;
  }
  return false;
}

export const newId = (): string => randomUUID();
