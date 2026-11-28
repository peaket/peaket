// F-06-6 GAT-250 대행사 결과 웹훅 유스케이스와 지표. 서명 검증은 domain/provider-webhook.ts가 정본이다.
// 받은 사건은 지표·로그만 올리고 원장 상태를 바꾸지 않는다(신청 삭제는 F-06-9·소유자 몫).
import { Counter, type Registry } from '@peaket/platform';
import { ProviderWebhookError, PROVIDER_EVENTS_METRIC, PROVIDER_EVENTS_LABELS, PROVIDER_REJECTED_METRIC, PROVIDER_REJECTED_LABELS, sesEventOf, solapiEventOf, verifyProviderWebhook, verifySnsNotification } from '../domain/provider-webhook.js';
import type { NotificationWorkerSignals } from './fan-notification-worker.js';

export interface ProviderEventsWiring {
  ses?: {
    allowedTopicArn: string;
    certHost: string;
    certResolver: (url: string) => Promise<string>;
    now?: () => number;
    maxAgeMs?: number;
    maxBytes?: number;
  };
  sms?: { secret: string; now?: () => number; toleranceMs?: number };
}

export interface ProviderEventSignals {
  event(provider: 'ses' | 'solapi', kind: string, result: 'accepted' | 'ignored'): void;
  rejected(provider: 'ses' | 'solapi', reason: string): void;
}

type HeaderValue = string | string[] | undefined;
const headerOf = (headers: Record<string, HeaderValue>, name: string): string | undefined => {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
};

export class ProviderEvents {
  constructor(private readonly o: { wiring?: ProviderEventsWiring; signals?: ProviderEventSignals; log?: (line: Record<string, unknown>) => void } = {}) {}

  async ses(rawBody: string, headers: Record<string, HeaderValue>): Promise<{ accepted: true; kind: string | null }> {
    const cfg = this.o.wiring?.ses;
    if (!cfg) throw new ProviderWebhookError('MALFORMED', 'SES 결과 웹훅이 설정되지 않았습니다');
    try {
      const verified = await verifySnsNotification(rawBody, {
        allowedTopicArn: cfg.allowedTopicArn,
        certHost: cfg.certHost,
        certResolver: cfg.certResolver,
        nowMs: cfg.now?.() ?? Date.now(),
        ...(cfg.maxAgeMs !== undefined ? { maxAgeMs: cfg.maxAgeMs } : {}),
        ...(cfg.maxBytes !== undefined ? { maxBytes: cfg.maxBytes } : {}),
      });
      const event = sesEventOf(verified.message);
      if (!event) {
        this.o.signals?.event('ses', 'UNKNOWN', 'ignored');
        return { accepted: true, kind: null };
      }
      this.o.signals?.event('ses', event.kind, 'accepted');
      this.o.log?.({ provider: 'ses', kind: event.kind, messageId: event.providerMessageId });
      return { accepted: true, kind: event.kind };
    } catch (e) {
      const reason = e instanceof ProviderWebhookError ? e.code : e instanceof Error ? e.name : 'unknown';
      this.o.signals?.rejected('ses', reason);
      throw e;
    }
  }

  sms(rawBody: string, headers: Record<string, HeaderValue>): { accepted: true; kind: string | null } {
    const cfg = this.o.wiring?.sms;
    if (!cfg) throw new ProviderWebhookError('MALFORMED', '문자 결과 웹훅이 설정되지 않았습니다');
    try {
      verifyProviderWebhook(
        { rawBody, timestamp: headerOf(headers, 'x-peaket-timestamp'), signature: headerOf(headers, 'x-peaket-signature') },
        { secret: cfg.secret, nowMs: cfg.now?.() ?? Date.now(), ...(cfg.toleranceMs !== undefined ? { toleranceMs: cfg.toleranceMs } : {}) },
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        throw new ProviderWebhookError('MALFORMED', '문자 결과 본문이 JSON이 아닙니다');
      }
      const event = solapiEventOf(parsed);
      if (!event) {
        this.o.signals?.event('solapi', 'UNKNOWN', 'ignored');
        return { accepted: true, kind: null };
      }
      this.o.signals?.event('solapi', event.kind, 'accepted');
      this.o.log?.({ provider: 'solapi', kind: event.kind, messageId: event.providerMessageId });
      return { accepted: true, kind: event.kind };
    } catch (e) {
      const reason = e instanceof ProviderWebhookError ? e.code : e instanceof Error ? e.name : 'unknown';
      this.o.signals?.rejected('solapi', reason);
      throw e;
    }
  }
}

/** 대행사 웹훅 지표. 라벨은 다섯 이름만 쓰고 계정·주소·전화번호·메시지 ID를 넣지 않는다 */
export class ProviderEventsMetrics implements ProviderEventSignals {
  #events: Counter<string> | undefined;
  #rejected: Counter<string> | undefined;

  register(registry: Registry): void {
    if (!this.#events) {
      this.#events = new Counter({ name: PROVIDER_EVENTS_METRIC, help: '대행사 결과 웹훅 사건', labelNames: [...PROVIDER_EVENTS_LABELS], registers: [registry] });
      this.#rejected = new Counter({ name: PROVIDER_REJECTED_METRIC, help: '대행사 결과 웹훅 거절', labelNames: [...PROVIDER_REJECTED_LABELS], registers: [registry] });
    }
  }

  event(provider: 'ses' | 'solapi', kind: string, result: 'accepted' | 'ignored'): void {
    this.#events?.inc({ provider, kind, result });
  }

  rejected(provider: 'ses' | 'solapi', reason: string): void {
    this.#rejected?.inc({ provider, reason });
  }
}

/** 워커가 보내지 않고 건너뛴 수(밤 웹 푸시 night, 광고 밤 금지 quiet_ad) */
export class NotifyWorkerMetrics implements NotificationWorkerSignals {
  #suppressed: Counter<string> | undefined;

  register(registry: Registry): void {
    if (!this.#suppressed) this.#suppressed = new Counter({ name: 'notify_suppressed_total', help: '보내지 않고 건너뛴 알림', labelNames: ['reason'], registers: [registry] });
  }

  suppressed(reason: 'night' | 'quiet_ad' | 'unsubscribed' | 'expired'): void {
    this.#suppressed?.inc({ reason });
  }
}
