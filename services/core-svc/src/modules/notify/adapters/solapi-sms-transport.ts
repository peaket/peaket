// F-06-6 GAT-250 Solapi v4 문자·알림톡 전송기. 실제 발송은 자격 증명이 없어 미실행이다.
// HMAC 인증·발신번호·문자 본문·알림톡 템플릿 payload·오류 분류·한도만 담당한다.
// 정본: docs/features/notify.md §4.4·§10, docs/review/plans/F-06-6.md §3.3.
import { createHmac, randomBytes } from 'node:crypto';
import { SmsTransportError, type SmsMessage, type SmsSendResult, type SmsTransport } from '../domain/fan-notify-ports.js';
import { redactProviderText } from './redact.js';
import { RefillingRateLimiter } from './rate-limit.js';

export interface SolapiResult {
  status: number;
  headers?: Record<string, string>;
  text(): Promise<string>;
}
export interface SolapiFetch {
  (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }): Promise<SolapiResult>;
}
interface SolapiOptions {
  apiKey: string;
  apiSecret: string;
  senderNumber: string;
  ratePerSec?: number;
  clock?: () => number;
  fetch: SolapiFetch;
  alimtalk?: { pfId: string; templates: Readonly<Record<string, string>> };
  log?: (line: Record<string, unknown>) => void;
}

interface SolapiBody {
  message: {
    to: string;
    from: string;
    text: string;
    kakaoOptions?: { pfId: string; templateId: string; variables: Record<string, string> };
  };
}

const ENDPOINT = 'https://api.solapi.com/messages/v4/send';

const retryAfterMsOf = (headers: Record<string, string> | undefined): number | undefined => {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'retry-after') continue;
    const sec = Number(v);
    return Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1_000) : undefined;
  }
  return undefined;
};

export class SolapiSmsTransport implements SmsTransport {
  #limiter: RefillingRateLimiter | undefined;

  constructor(private readonly o: SolapiOptions) {
    if (!/^\d+$/.test(o.senderNumber)) throw new Error('Solapi 발신번호는 숫자만이어야 합니다');
    if (o.ratePerSec !== undefined) this.#limiter = new RefillingRateLimiter({ ratePerSec: o.ratePerSec, clock: o.clock ?? Date.now });
  }

  describe(): { provider: 'solapi'; senderNumber: string; ratePerSec: number; alimtalk: { pfId: string; templateCount: number } | null } {
    return {
      provider: 'solapi',
      senderNumber: this.o.senderNumber,
      ratePerSec: this.o.ratePerSec ?? 0,
      alimtalk: this.o.alimtalk ? { pfId: this.o.alimtalk.pfId, templateCount: Object.keys(this.o.alimtalk.templates).length } : null,
    };
  }

  async send(input: SmsMessage): Promise<SmsSendResult> {
    if (this.#limiter && !this.#limiter.take()) throw new SmsTransportError('RETRYABLE', 'rate-limited', 429);
    const templateId = input.kind && this.o.alimtalk ? this.o.alimtalk.templates[input.kind] : undefined;
    if (input.kind && this.o.alimtalk && !templateId) {
      throw new SmsTransportError('PERMANENT', `template-missing: ${input.kind}`, 400);
    }
    const body: SolapiBody = {
      message: {
        to: input.to,
        from: this.o.senderNumber,
        text: input.body,
        ...(templateId && this.o.alimtalk
          ? { kakaoOptions: { pfId: this.o.alimtalk.pfId, templateId, variables: input.templateVariables ?? {} } }
          : {}),
      },
    };
    const nowMs = this.o.clock?.() ?? Date.now();
    const date = new Date(nowMs).toISOString();
    const salt = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', this.o.apiSecret).update(`${date}${salt}`, 'utf8').digest('hex');
    try {
      const res = await this.o.fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `HMAC-SHA256 apiKey=${this.o.apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
        },
        body: JSON.stringify(body),
      });
      if (res.status < 200 || res.status >= 300) {
        const { kind, status, retryAfterMs } = solapiFailure(res.status, res.headers);
        throw new SmsTransportError(kind, `http-${status}`, status, retryAfterMs);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await res.text());
      } catch {
        throw new SmsTransportError('UNKNOWN', 'invalid-json', res.status);
      }
      const messageId = parsed !== null && typeof parsed === 'object' && 'messageId' in parsed && typeof (parsed as { messageId?: unknown }).messageId === 'string' ? (parsed as { messageId: string }).messageId : undefined;
      return { ...(messageId ? { providerMessageId: messageId } : {}) };
    } catch (e) {
      const err = e instanceof SmsTransportError ? e : new SmsTransportError('RETRYABLE', e instanceof Error ? e.message : 'transport-error');
      const message = redactProviderText(err.message, [this.o.apiSecret, this.o.apiKey]);
      this.o.log?.({ provider: 'solapi', status: err.status, error: message });
      throw new SmsTransportError(err.kind, message, err.status, err.retryAfterMs);
    }
  }
}

function solapiFailure(status: number, headers: Record<string, string> | undefined): { kind: 'RETRYABLE' | 'PERMANENT' | 'UNKNOWN'; status: number; retryAfterMs?: number } {
  const retryAfterMs = retryAfterMsOf(headers);
  if (status === 400) return { kind: 'PERMANENT', status };
  if (status === 401 || status === 403 || status === 404 || status === 409 || status === 429 || status >= 500) {
    return { kind: 'RETRYABLE', status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  return { kind: 'UNKNOWN', status };
}
