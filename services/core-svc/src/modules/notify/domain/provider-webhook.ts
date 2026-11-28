// F-06-6 GAT-250 대행사 결과 웹훅의 순수 검증·분류. SNS 서명은 인증서를 비동기로 받아 확인한다.
// 실제 인증서·대행사에 닿지 않는다(해석기 주입). 정본: docs/features/notify.md §4.4·§10·§11, 계획 §3.4.
import { createHmac, createVerify, timingSafeEqual } from 'node:crypto';

export type ProviderEventKind = 'BOUNCE' | 'COMPLAINT' | 'DELIVERY' | 'SMS_DELIVERED' | 'SMS_FAILED';
export interface ProviderEvent {
  kind: ProviderEventKind;
  providerMessageId: string | null;
}
export type ProviderWebhookCode =
  | 'SIGNATURE'
  | 'TOPIC'
  | 'CERT_HOST'
  | 'STALE'
  | 'MALFORMED'
  | 'TOO_LARGE'
  | 'SUBSCRIPTION_CONFIRMATION';
export class ProviderWebhookError extends Error {
  constructor(readonly code: ProviderWebhookCode, message: string) {
    super(message);
    this.name = 'ProviderWebhookError';
  }
}

export const PROVIDER_EVENTS_METRIC = 'notify_provider_events_total';
export const PROVIDER_EVENTS_LABELS = ['provider', 'kind', 'result'] as const;
export const PROVIDER_REJECTED_METRIC = 'notify_provider_webhook_rejected_total';
export const PROVIDER_REJECTED_LABELS = ['provider', 'reason'] as const;

const MAX_BYTES = 256 * 1024;
const MAX_AGE_MS = 60 * 60 * 1_000;
const MAX_FUTURE_MS = 5 * 60 * 1_000;
const HMAC_TOLERANCE_MS = 5 * 60 * 1_000;

export interface SnsVerifyOptions {
  allowedTopicArn: string;
  certHost: string;
  nowMs: number;
  certResolver: (url: string) => Promise<string>;
  maxAgeMs?: number;
  maxBytes?: number;
}

interface SnsShape {
  Type?: unknown;
  MessageId?: unknown;
  TopicArn?: unknown;
  Subject?: unknown;
  Message?: unknown;
  Timestamp?: unknown;
  SignatureVersion?: unknown;
  SigningCertURL?: unknown;
  Signature?: unknown;
  SubscribeURL?: unknown;
}

const bad = (code: ProviderWebhookCode, message: string): never => {
  throw new ProviderWebhookError(code, message);
};

const canonical = (m: SnsShape, type: string): string => {
  const parts: string[] = ['Message', String(m.Message), 'MessageId', String(m.MessageId)];
  if (type === 'SubscriptionConfirmation') parts.push('SubscribeURL', String(m.SubscribeURL));
  else if (m.Subject !== undefined) parts.push('Subject', String(m.Subject));
  parts.push('Timestamp', String(m.Timestamp), 'TopicArn', String(m.TopicArn), 'Type', type);
  return `${parts.join('\n')}\n`;
};

/** SNS Notification 서명을 인증서까지 기다려 확인한다. SubscriptionConfirmation은 서명 확인 뒤에도 자동 승인하지 않는다 */
export async function verifySnsNotification(rawBody: string, o: SnsVerifyOptions): Promise<{ topicArn: string; message: unknown }> {
  if (Buffer.byteLength(rawBody, 'utf8') > (o.maxBytes ?? MAX_BYTES)) return bad('TOO_LARGE', 'SNS 본문이 너무 큽니다');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return bad('MALFORMED', 'SNS 본문이 JSON이 아닙니다');
  }
  if (parsed === null || typeof parsed !== 'object') return bad('MALFORMED', 'SNS 본문이 객체가 아닙니다');
  const m = parsed as SnsShape;
  const type = typeof m.Type === 'string' ? m.Type : '';
  if (!type) return bad('MALFORMED', 'SNS Type이 없습니다');
  if (typeof m.TopicArn !== 'string' || m.TopicArn !== o.allowedTopicArn) return bad('TOPIC', '허용하지 않은 SNS 토픽입니다');
  if (typeof m.SigningCertURL !== 'string') return bad('CERT_HOST', 'SNS 인증서 주소가 없습니다');
  let certUrl: URL;
  try {
    certUrl = new URL(m.SigningCertURL);
  } catch {
    return bad('CERT_HOST', 'SNS 인증서 주소가 URL이 아닙니다');
  }
  if (
    certUrl.protocol !== 'https:' ||
    certUrl.hostname !== o.certHost ||
    (certUrl.port !== '' && certUrl.port !== '443') ||
    !/^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/.test(certUrl.pathname)
  ) {
    return bad('CERT_HOST', '허용하지 않은 SNS 인증서 주소입니다');
  }
  const ts = typeof m.Timestamp === 'string' ? Date.parse(m.Timestamp) : Number.NaN;
  if (!Number.isFinite(ts)) return bad('MALFORMED', 'SNS Timestamp가 올바르지 않습니다');
  if (o.nowMs - ts > (o.maxAgeMs ?? MAX_AGE_MS)) return bad('STALE', 'SNS 메시지가 너무 오래되었습니다');
  if (ts - o.nowMs > MAX_FUTURE_MS) return bad('STALE', 'SNS 메시지 시각이 미래입니다');
  if (typeof m.Signature !== 'string' || m.Signature === '') return bad('SIGNATURE', 'SNS 서명이 없습니다');
  const version = m.SignatureVersion === '1' ? '1' : m.SignatureVersion === '2' ? '2' : undefined;
  if (!version) return bad('MALFORMED', 'SNS SignatureVersion이 올바르지 않습니다');
  const algo = version === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
  let cert: string;
  try {
    cert = await o.certResolver(m.SigningCertURL);
  } catch {
    return bad('CERT_HOST', 'SNS 인증서를 읽지 못했습니다');
  }
  let ok = false;
  try {
    ok = createVerify(algo).update(canonical(m, type), 'utf8').verify(cert, m.Signature, 'base64');
  } catch {
    ok = false;
  }
  if (!ok) return bad('SIGNATURE', 'SNS 서명이 맞지 않습니다');
  if (typeof m.Message !== 'string') return bad('MALFORMED', 'SNS Message가 없습니다');
  let message: unknown;
  try {
    message = JSON.parse(m.Message);
  } catch {
    return bad('MALFORMED', 'SNS Message가 JSON이 아닙니다');
  }
  if (type === 'SubscriptionConfirmation') return bad('SUBSCRIPTION_CONFIRMATION', 'SNS 구독 확인은 자동 승인하지 않습니다');
  if (type !== 'Notification') return bad('MALFORMED', '지원하지 않는 SNS 메시지 종류입니다');
  return { topicArn: m.TopicArn, message };
}

/** SES configuration set 이벤트. eventType이 정본이고 notificationType은 옛 알림 호환이다 */
export function sesEventOf(message: unknown): ProviderEvent | null {
  if (message === null || typeof message !== 'object') return null;
  const m = message as { eventType?: unknown; notificationType?: unknown; mail?: { messageId?: unknown } };
  const type = typeof m.eventType === 'string' ? m.eventType : typeof m.notificationType === 'string' ? m.notificationType : '';
  const kind = type === 'Bounce' ? 'BOUNCE' : type === 'Complaint' ? 'COMPLAINT' : type === 'Delivery' ? 'DELIVERY' : null;
  if (!kind) return null;
  const id = m.mail && typeof m.mail.messageId === 'string' ? m.mail.messageId : null;
  return { kind, providerMessageId: id };
}

/** Solapi 결과 웹훅 HMAC. 비밀은 base64url로 푼 바이트 키다. 비교는 상수 시간이며 오류에 비밀을 싣지 않는다 */
export function verifyProviderWebhook(
  input: { rawBody: string; timestamp: string | undefined; signature: string | undefined },
  o: { secret: string; nowMs: number; toleranceMs?: number },
): void {
  const tsText = input.timestamp;
  if (!tsText || !/^\d+$/.test(tsText)) bad('MALFORMED', '웹훅 timestamp가 없거나 숫자가 아닙니다');
  const ts = Number(tsText) * 1_000;
  if (!Number.isFinite(ts) || Math.abs(o.nowMs - ts) > (o.toleranceMs ?? HMAC_TOLERANCE_MS)) bad('STALE', '웹훅 시각이 허용 범위 밖입니다');
  const m = /^v1=([0-9a-f]{64})$/i.exec(input.signature ?? '');
  if (!m) bad('MALFORMED', '웹훅 서명 모양이 올바르지 않습니다');
  const key = Buffer.from(o.secret, 'base64url');
  const want = createHmac('sha256', key).update(`${tsText}.${input.rawBody}`, 'utf8').digest();
  const got = Buffer.from(m![1]!, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) bad('SIGNATURE', '웹훅 서명이 맞지 않습니다');
}

/** Solapi 결과 사건 분류([가정] 봉투). 전화번호·주소는 결과에 싣지 않는다 */
export function solapiEventOf(message: unknown): ProviderEvent | null {
  if (message === null || typeof message !== 'object') return null;
  const m = message as { type?: unknown; messageId?: unknown };
  const kind = m.type === 'DELIVERED' ? 'SMS_DELIVERED' : m.type === 'FAILED' ? 'SMS_FAILED' : null;
  if (!kind) return null;
  return { kind, providerMessageId: typeof m.messageId === 'string' ? m.messageId : null };
}
