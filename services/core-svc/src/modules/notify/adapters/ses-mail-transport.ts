// F-06-6 GAT-250 Amazon SES v2 메일 전송기. IAM 역할(Pod Identity)로 ses:SendEmail만 쓰고 정적 키를 두지 않는다.
// SDK 자체 재시도는 끄고(maxAttempts: 1) 원장 재시도 하나만 쓴다. 실제 발송은 운영 키가 없어 미실행이다.
// 정본: docs/features/notify.md §4.4·§10, docs/review/plans/F-06-6.md §3.2.
import { createHash } from 'node:crypto';
import { MailTransportError, type MailMessage, type MailSendResult, type MailTransport } from '../domain/fan-notify-ports.js';
import { redactProviderText } from './redact.js';
import { RefillingRateLimiter } from './rate-limit.js';

export interface SesSendInput {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  ReplyToAddresses?: string[];
  Content: {
    Simple: {
      Subject: { Data: string; Charset: 'UTF-8' };
      Body: { Text: { Data: string; Charset: 'UTF-8' } };
      Headers?: { Name: string; Value: string }[];
    };
  };
  ConfigurationSetName: string;
  EmailTags: { Name: string; Value: string }[];
}
export interface SesClientLike {
  send(input: SesSendInput): Promise<{ MessageId?: string }>;
}

interface SesOptions {
  client?: SesClientLike;
  region: string;
  snsTopicArn: string;
  from: string;
  fromDomain: string;
  configurationSet: string;
  replyTo?: string;
  ratePerSec?: number;
  clock?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

const ALLOWED_HEADERS: Readonly<Record<string, string>> = {
  'list-unsubscribe': 'List-Unsubscribe',
  'list-unsubscribe-post': 'List-Unsubscribe-Post',
};

const headerValue = (headers: Record<string, unknown>, name: string): string | undefined => {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  }
  return undefined;
};

const retryAfterMsOf = (headers: unknown): number | undefined => {
  if (headers === null || typeof headers !== 'object') return undefined;
  const raw = headerValue(headers as Record<string, unknown>, 'retry-after');
  if (!raw) return undefined;
  const sec = Number(raw);
  return Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1_000) : undefined;
};

export class SesMailTransport implements MailTransport {
  #client: SesClientLike | undefined;
  #limiter: RefillingRateLimiter | undefined;

  constructor(private readonly o: SesOptions) {
    if (!o.from.endsWith(`@${o.fromDomain}`)) throw new Error('SES 발신 주소가 발신 도메인과 다릅니다');
    if (o.ratePerSec !== undefined) this.#limiter = new RefillingRateLimiter({ ratePerSec: o.ratePerSec, clock: o.clock ?? Date.now });
  }

  describe(): { provider: 'ses'; region: string; from: string; fromDomain: string; configurationSet: string; snsTopicArn: string; ratePerSec: number } {
    return {
      provider: 'ses',
      region: this.o.region,
      from: this.o.from,
      fromDomain: this.o.fromDomain,
      configurationSet: this.o.configurationSet,
      snsTopicArn: this.o.snsTopicArn,
      ratePerSec: this.o.ratePerSec ?? 0,
    };
  }

  async send(input: MailMessage): Promise<MailSendResult> {
    if (this.#limiter && !this.#limiter.take()) throw new MailTransportError('RETRYABLE', 'rate-limited', 429);
    const headers: { Name: string; Value: string }[] = [];
    for (const [key, value] of Object.entries(input.headers)) {
      const name = ALLOWED_HEADERS[key.toLowerCase()];
      if (!name) continue;
      if (/[\r\n]/.test(value)) throw new MailTransportError('PERMANENT', '헤더 값에 줄바꿈이 있습니다', 400);
      headers.push({ Name: name, Value: value });
    }
    const tag = createHash('sha256').update(input.messageKey, 'utf8').digest('base64url');
    const payload: SesSendInput = {
      FromEmailAddress: this.o.from,
      Destination: { ToAddresses: [input.to] },
      ...(this.o.replyTo ? { ReplyToAddresses: [this.o.replyTo] } : {}),
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: input.body, Charset: 'UTF-8' } },
          ...(headers.length ? { Headers: headers } : {}),
        },
      },
      ConfigurationSetName: this.o.configurationSet,
      EmailTags: [{ Name: 'peaket-dedup', Value: tag }],
    };
    try {
      const client = await this.#resolveClient();
      const out = await client.send(payload);
      return { ...(out.MessageId ? { providerMessageId: out.MessageId } : {}) };
    } catch (e) {
      const { kind, status, retryAfterMs } = sesFailure(e);
      const message = redactProviderText(e instanceof Error ? e.message : String(e), []);
      this.o.log?.({ provider: 'ses', status, error: message });
      throw new MailTransportError(kind, message, status, retryAfterMs);
    }
  }

  async #resolveClient(): Promise<SesClientLike> {
    if (this.o.client) return this.o.client;
    if (!this.#client) {
      const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
      const client = new SESv2Client({ region: this.o.region, maxAttempts: 1 });
      this.#client = {
        send: async (payload) => {
          const out = await client.send(new SendEmailCommand(payload));
          return { ...(out.MessageId ? { MessageId: out.MessageId } : {}) };
        },
      };
    }
    return this.#client;
  }
}

function sesFailure(e: unknown): { kind: 'RETRYABLE' | 'PERMANENT' | 'UNKNOWN'; status?: number; retryAfterMs?: number } {
  if (e !== null && typeof e === 'object') {
    const obj = e as {
      name?: unknown;
      code?: unknown;
      status?: unknown;
      $metadata?: { httpStatusCode?: unknown };
      $response?: { headers?: unknown };
      headers?: unknown;
    };
    const rawStatus = obj.$metadata?.httpStatusCode ?? obj.status;
    const status = typeof rawStatus === 'number' ? rawStatus : undefined;
    const retryAfterMs = retryAfterMsOf(obj.$response?.headers ?? obj.headers);
    const name = typeof obj.name === 'string' ? obj.name : '';
    const code = typeof obj.code === 'string' ? obj.code : '';
    if (name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ENOTFOUND') return { kind: 'RETRYABLE', ...(status !== undefined ? { status } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    if (status === 400) return { kind: 'PERMANENT', status };
    if (status !== undefined && (status === 401 || status === 403 || status === 404 || status === 409 || status === 429 || status >= 500)) {
      return { kind: 'RETRYABLE', status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    if (status === undefined && (name === 'TooManyRequestsException' || name === 'ThrottlingException')) {
      return { kind: 'RETRYABLE', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    return { kind: 'UNKNOWN', ...(status !== undefined ? { status } : {}) };
  }
  return { kind: 'UNKNOWN' };
}
