// 파트너 웹훅 도메인(BUILD_ORDER BAT-610 서버 잔여, FR-025, ADR-0053·0109, docs/features/notify.md §9).
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

export class WebhookProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = 'WebhookProblem';
  }
}

export type WebhookEventType = 'order.confirmed' | 'order.cancelled' | 'event.sold_out' | 'event.cancelled' | 'event.postponed' | 'statement.notified' | 'payout.completed' | 'payout.failed';
export type WebhookStatus = 'ACTIVE' | 'DISABLED';
export type WebhookDisabledReason = 'PARTNER' | 'FAILING' | null;
export type DeliveryStatus = 'PENDING' | 'RETRYING' | 'SUCCEEDED' | 'DEAD';

export interface WebhookEndpointRecord {
  endpointId: string;
  promoterId: string;
  url: string;
  eventTypes: WebhookEventType[];
  status: WebhookStatus;
  disabledReason: WebhookDisabledReason;
  /** 실제 서명 비밀. 목록·응답에는 원문을 싣지 않는다 */
  secret: string;
  previousSecret: string | null;
  secretIssuedAt: Date;
  previousSecretValidUntil: Date | null;
  version: number;
}

export interface WebhookEndpointView {
  endpointId: string;
  url: string;
  eventTypes: WebhookEventType[];
  status: WebhookStatus;
  disabledReason: WebhookDisabledReason;
  secretIssuedAt: string;
  previousSecretValidUntil: string | null;
  version: number;
}

export interface WebhookDeliveryRecord {
  deliveryId: string;
  endpointId: string;
  webhookId: string;
  eventType: string;
  status: DeliveryStatus;
  attemptCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** thin 본문({type, timestamp, data}). 다시 보내도 같은 값을 쓴다 */
  payload: Record<string, unknown>;
}

export interface WebhookDeliveryView {
  deliveryId: string;
  webhookId: string;
  eventType: string;
  status: DeliveryStatus;
  attemptCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const bad = (type: string, title: string): WebhookProblem => new WebhookProblem(type, 400, title);
const preconditionRequired = () => new WebhookProblem('precondition-required', 428, '고칠 판(If-Match)을 보내 주세요');
const preconditionFailed = () => new WebhookProblem('precondition-failed', 412, '다른 사람이 먼저 고쳤습니다');
const rotationTooSoon = () => new WebhookProblem('rotation-too-soon', 409, '비밀을 너무 자주 바꿀 수 없습니다');
const redeliveryConflict = () => new WebhookProblem('webhook-delivery-not-redeliverable', 409, '지금은 다시 보낼 수 없습니다');

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;
const NUMERIC_HOST = /^\d+$/;

/** 등록·고치기 때 보는 주소 규칙. DNS 해석 뒤 사설 IP 검사는 발송기가 다시 한다. */
export function checkWebhookUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw bad('webhook-url-not-allowed', '주소 모양이 맞지 않습니다');
  }
  if (url.protocol !== 'https:') throw bad('webhook-url-not-allowed', 'https 주소만 등록할 수 있습니다');
  if (url.port !== '' && url.port !== '443') throw bad('webhook-url-not-allowed', '443 포트만 받습니다');
  if (url.username || url.password) throw bad('webhook-url-not-allowed', '주소에 사용자 정보를 넣을 수 없습니다');
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 || NUMERIC_HOST.test(host)) throw bad('webhook-url-not-allowed', 'IP 주소를 그대로 쓴 주소는 등록할 수 없습니다');
  if (PRIVATE_HOST.test(host)) throw bad('webhook-url-not-allowed', '사설·루프백 주소로는 보낼 수 없습니다');
}

export const newWebhookSecret = (): string => `whsec_${randomBytes(32).toString('base64')}`;

/** Standard Webhooks 서명: v1, + base64(HMAC-SHA256(비밀, `${id}.${timestamp}.${본문}`)). 비밀 교체 중이면 공백으로 잇는다. */
export function webhookSignature(secrets: readonly string[], id: string, timestamp: number, body: string): string {
  const content = `${id}.${timestamp}.${body}`;
  return secrets.map((secret) => `v1,${createHmac('sha256', secret).update(content).digest('base64')}`).join(' ');
}

/** 처음 보낸 뒤 1분·5분·30분·2시간·6시간·12시간 [가정](docs/features/notify.md §9). 다 보내면 DEAD다. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000] as const;

/** 다음 재시도까지 남은 시간. null이면 더 보내지 않고 DEAD다. */
export function retryDelayMs(attemptCount: number): number | null {
  return RETRY_DELAYS_MS[attemptCount - 1] ?? null;
}

/** 계속 실패하는 엔드포인트 판정: 5일 [가정] 동안 성공 없이 DEAD 50건 [가정]을 넘으면 DISABLED(FAILING). */
export const FAILING_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
export const FAILING_DEAD_THRESHOLD = 50;

export function shouldDisableEndpoint(now: Date, lastSuccessAt: Date | null, deadCount: number): boolean {
  if (deadCount < FAILING_DEAD_THRESHOLD) return false;
  return lastSuccessAt === null || now.getTime() - lastSuccessAt.getTime() > FAILING_WINDOW_MS;
}

export const activeSecrets = (e: WebhookEndpointRecord, now: Date): string[] =>
  e.previousSecret && e.previousSecretValidUntil && e.previousSecretValidUntil.getTime() > now.getTime() ? [e.secret, e.previousSecret] : [e.secret];


export function endpointView(e: WebhookEndpointRecord): WebhookEndpointView {
  return {
    endpointId: e.endpointId,
    url: e.url,
    eventTypes: e.eventTypes,
    status: e.status,
    disabledReason: e.disabledReason,
    secretIssuedAt: e.secretIssuedAt.toISOString(),
    previousSecretValidUntil: e.previousSecretValidUntil?.toISOString() ?? null,
    version: e.version,
  };
}

export function deliveryView(d: WebhookDeliveryRecord): WebhookDeliveryView {
  return {
    deliveryId: d.deliveryId,
    webhookId: d.webhookId,
    eventType: d.eventType,
    status: d.status,
    attemptCount: d.attemptCount,
    lastHttpStatus: d.lastHttpStatus,
    lastError: d.lastError,
    nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    finishedAt: d.finishedAt?.toISOString() ?? null,
  };
}

export function parseIfMatch(value: string | undefined): number {
  if (value === undefined) throw preconditionRequired();
  const m = /^"(\d+)"$/.exec(value.trim());
  if (!m) throw preconditionFailed();
  return Number(m[1]);
}

export { bad, preconditionFailed, rotationTooSoon, redeliveryConflict };
