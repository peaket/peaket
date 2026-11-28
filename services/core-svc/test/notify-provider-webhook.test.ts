// F-06-6 GAT-250 C1~C7: SES(SNS)·Solapi 결과 웹훅의 서명 검증·HTTP 경로·사건 분류·지표.
// 실제 인증서·대행사에 닿지 않는다. SNS 인증서 해석기와 개인키는 이 파일이 그 자리에서 만든다.
// 정본: docs/features/notify.md §4.4·§10·§11, docs/review/plans/F-06-6.md §3.4.
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createService } from '@peaket/platform';
import { describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  FakeMailTransport,
  FakePushTransport,
  MemoryFanNotifyStore,
  MemoryRecipientDirectory,
} from '../src/modules/notify/index.js';
import { FakeIdentity, quiet } from './support.js';
import { vapidKeys } from './fan-notify-support.js';

const webhookUrl = new URL('../src/modules/notify/domain/provider-webhook.ts', import.meta.url).href;
const controllerUrl = new URL('../src/modules/notify/inbound/provider-events.controller.ts', import.meta.url).href;
const webhookPath = fileURLToPath(webhookUrl);
const controllerPath = fileURLToPath(controllerUrl);

type SnsMessage = {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  SigningCertURL: string;
  Signature: string;
  SubscribeURL?: string;
};
type SnsDeps = {
  allowedTopicArn: string;
  certHost: string;
  nowMs: number;
  maxAgeMs?: number;
  maxBytes?: number;
  certResolver: (url: string) => Promise<string>;
};
type ProviderEvent = { kind: string; providerMessageId: string | null };
type WebhookModule = {
  verifySnsNotification?: (rawBody: string, o: SnsDeps) => Promise<{ topicArn: string; message: unknown }>;
  sesEventOf?: (message: unknown) => ProviderEvent | null;
  verifyProviderWebhook?: (input: { rawBody: string; timestamp: string | undefined; signature: string | undefined }, o: { secret: string; nowMs: number; toleranceMs?: number }) => void;
  solapiEventOf?: (message: unknown) => ProviderEvent | null;
  PROVIDER_EVENTS_METRIC?: string;
  PROVIDER_EVENTS_LABELS?: readonly string[];
  PROVIDER_REJECTED_METRIC?: string;
  PROVIDER_REJECTED_LABELS?: readonly string[];
};
const load = async (): Promise<WebhookModule> => (await import(/* @vite-ignore */ webhookUrl)) as WebhookModule;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pub = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const TOPIC = 'arn:aws:sns:ap-northeast-2:123456789012:peaket-notify-events';
const NOW = Date.parse('2026-11-28T05:01:00.000Z');
const WEBHOOK_SECRET = Buffer.alloc(32, 3).toString('base64url');
const WEBHOOK_KEY = Buffer.from(WEBHOOK_SECRET, 'base64url');

const eventBody = {
  eventType: 'Complaint',
  mail: { messageId: 'ses-1', destination: ['fan@example.com'] },
  complaint: { complaintFeedbackType: 'abuse' },
};

const sns = (over: Partial<SnsMessage> = {}): SnsMessage => ({
  Type: 'Notification',
  MessageId: 'm-1',
  TopicArn: TOPIC,
  Subject: 'Amazon SES Email Event Notification',
  Message: JSON.stringify(eventBody),
  Timestamp: '2026-11-28T05:00:00.000Z',
  SignatureVersion: '2',
  SigningCertURL: 'https://sns.ap-northeast-2.amazonaws.com/SimpleNotificationService-test.pem',
  Signature: '',
  ...over,
});
const canonical = (m: SnsMessage): string => {
  const parts = ['Message', m.Message, 'MessageId', m.MessageId];
  if (m.Type === 'SubscriptionConfirmation') parts.push('SubscribeURL', m.SubscribeURL ?? '');
  else if (m.Subject !== undefined) parts.push('Subject', m.Subject);
  parts.push('Timestamp', m.Timestamp, 'TopicArn', m.TopicArn, 'Type', m.Type);
  return `${parts.join('\n')}\n`;
};
const signed = (over: Partial<SnsMessage> = {}): SnsMessage => {
  const m = sns(over);
  const algo = m.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
  return { ...m, Signature: sign(algo, Buffer.from(canonical(m), 'utf8'), privateKey).toString('base64') };
};
const deps = (over: Partial<SnsDeps> = {}): SnsDeps => ({
  allowedTopicArn: TOPIC,
  certHost: 'sns.ap-northeast-2.amazonaws.com',
  nowMs: NOW,
  certResolver: async () => pub,
  ...over,
});
const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return 'none';
  } catch (e) {
    return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : e instanceof Error ? e.name : 'unknown';
  }
};
const hmac = (data: string): string => `v1=${createHmac('sha256', WEBHOOK_KEY).update(data, 'utf8').digest('hex')}`;

describe('GAT-250 C 대행사 결과 웹훅', () => {
  test('GAT-250 C1 SNS 유효 서명을 await로 통과하고 HTTP ses·sms 경로가 맞으면 202, 틀린 서명은 401이다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    expect(existsSync(controllerPath)).toBe(true);
    if (!existsSync(webhookPath) || !existsSync(controllerPath)) return;
    const mod = await load();
    expect(typeof mod.verifySnsNotification).toBe('function');
    if (!mod.verifySnsNotification) return;

    const m = signed();
    const r = await mod.verifySnsNotification(JSON.stringify(m), deps());
    expect(r.topicArn).toBe(TOPIC);
    expect(r.message).toMatchObject({ eventType: 'Complaint', mail: { messageId: 'ses-1' } });

    const svc = await createService({
      name: 'core-svc',
      module: AppModule.register({
        memory: true,
        notify: {
          fanNotify: {
            store: new MemoryFanNotifyStore(),
            mail: new FakeMailTransport(),
            push: new FakePushTransport(),
            recipients: new MemoryRecipientDirectory(),
            optOutKey: Buffer.alloc(32, 1).toString('base64url'),
            vapid: vapidKeys(),
            providerEvents: {
              ses: { allowedTopicArn: TOPIC, certHost: 'sns.ap-northeast-2.amazonaws.com', certResolver: async () => pub, now: () => NOW },
              sms: { secret: WEBHOOK_SECRET, now: () => NOW },
            },
          },
        },
      }),
      env: { PEAKET_ENV: 'ci' },
      logDestination: quiet(),
      adminAuthz: new FakeIdentity(),
    });
    try {
      const ses = await svc.http.inject({ method: 'POST', url: '/internal/v1/notify/provider-events/ses', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(signed()) });
      expect(ses.statusCode).toBe(202);
      const bad = await svc.http.inject({ method: 'POST', url: '/internal/v1/notify/provider-events/ses', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ ...signed(), Signature: 'AAAA' }) });
      expect(bad.statusCode).toBe(401);
      const raw = JSON.stringify({ type: 'DELIVERED', messageId: 'sms-1' });
      const ts = String(Math.floor(NOW / 1000));
      const sms = await svc.http.inject({
        method: 'POST',
        url: '/internal/v1/notify/provider-events/sms',
        headers: { 'content-type': 'application/json', 'x-peaket-timestamp': ts, 'x-peaket-signature': hmac(`${ts}.${raw}`) },
        payload: raw,
      });
      expect(sms.statusCode).toBe(202);
    } finally {
      await svc.close();
    }
  });

  test('GAT-250 C2 서명·토픽·인증서 호스트·오래된/미래 시각을 거절하고 SHA-1도 받으며 나쁜 호스트는 해석기를 부르지 않는다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    if (!existsSync(webhookPath)) return;
    const mod = await load();
    if (!mod.verifySnsNotification) return;

    const valid = signed();
    const badSig = { ...valid, Signature: `${valid.Signature.slice(0, -4)}AAAA` };
    expect(await codeOf(() => mod.verifySnsNotification!(JSON.stringify(badSig), deps()))).toBe('SIGNATURE');

    const wrongTopic = signed({ TopicArn: 'arn:aws:sns:ap-northeast-2:123456789012:other' });
    expect(await codeOf(() => mod.verifySnsNotification!(JSON.stringify(wrongTopic), deps()))).toBe('TOPIC');

    for (const url of [
      'http://sns.ap-northeast-2.amazonaws.com/SimpleNotificationService-test.pem',
      'https://evil.example/SimpleNotificationService-test.pem',
      'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem',
      'https://sns.ap-northeast-2.amazonaws.com/other.pem',
    ]) {
      const m = signed({ SigningCertURL: url });
      let resolverCalls = 0;
      const code = await codeOf(() =>
        mod.verifySnsNotification!(JSON.stringify(m), deps({ certResolver: async () => { resolverCalls += 1; return pub; } })),
      );
      expect(code, url).toBe('CERT_HOST');
      expect(resolverCalls, url).toBe(0);
    }

    const old = signed({ Timestamp: '2026-11-28T03:00:00.000Z' });
    expect(await codeOf(() => mod.verifySnsNotification!(JSON.stringify(old), deps()))).toBe('STALE');
    const future = signed({ Timestamp: '2026-11-28T05:10:00.000Z' });
    expect(await codeOf(() => mod.verifySnsNotification!(JSON.stringify(future), deps()))).toBe('STALE');

    const v1 = signed({ SignatureVersion: '1' });
    await expect(mod.verifySnsNotification(JSON.stringify(v1), deps())).resolves.toMatchObject({ topicArn: TOPIC });
  });

  test('GAT-250 C3 SNS 구독 확인은 종류별 canonical로 서명해도 자동 승인하지 않고 SubscribeURL을 부르지 않는다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    if (!existsSync(webhookPath)) return;
    const mod = await load();
    if (!mod.verifySnsNotification) return;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('fetch not allowed'); });
    try {
      const m = signed({ Type: 'SubscriptionConfirmation', Subject: undefined, SubscribeURL: 'https://sns.ap-northeast-2.amazonaws.com/confirm?x=1' });
      expect(await codeOf(() => mod.verifySnsNotification!(JSON.stringify(m), deps()))).toBe('SUBSCRIPTION_CONFIRMATION');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('GAT-250 C4 SES 사건은 eventType·notificationType을 읽고 받는 사람 주소를 남기지 않는다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    if (!existsSync(webhookPath)) return;
    const mod = await load();
    expect(typeof mod.sesEventOf).toBe('function');
    if (!mod.sesEventOf) return;

    expect(mod.sesEventOf(eventBody)).toEqual({ kind: 'COMPLAINT', providerMessageId: 'ses-1' });
    expect(mod.sesEventOf({ eventType: 'Bounce', mail: { messageId: 'ses-2', destination: ['fan@example.com'] } })).toMatchObject({ kind: 'BOUNCE', providerMessageId: 'ses-2' });
    expect(mod.sesEventOf({ eventType: 'Delivery', mail: { messageId: 'ses-3' } })).toMatchObject({ kind: 'DELIVERY' });
    expect(mod.sesEventOf({ notificationType: 'Complaint', mail: { messageId: 'ses-4' } })).toMatchObject({ kind: 'COMPLAINT' });
    expect(mod.sesEventOf({ eventType: 'Other', mail: { messageId: 'ses-5' } })).toBeNull();
    expect(JSON.stringify(mod.sesEventOf(eventBody))).not.toContain('fan@example.com');
  });

  test('GAT-250 C5 Solapi HMAC은 base64url을 푼 바이트 키로 검증하고 본문 변조·오래된 시각·모양 오류를 거절한다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    if (!existsSync(webhookPath)) return;
    const mod = await load();
    expect(typeof mod.verifyProviderWebhook).toBe('function');
    if (!mod.verifyProviderWebhook) return;

    const raw = JSON.stringify({ type: 'DELIVERED', messageId: 'sms-1' });
    const ts = String(Math.floor(NOW / 1000));
    const good = hmac(`${ts}.${raw}`);
    expect(() => mod.verifyProviderWebhook!({ rawBody: raw, timestamp: ts, signature: good }, { secret: WEBHOOK_SECRET, nowMs: NOW })).not.toThrow();
    const err = (() => {
      try {
        mod.verifyProviderWebhook!({ rawBody: `${raw} `, timestamp: ts, signature: good }, { secret: WEBHOOK_SECRET, nowMs: NOW });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).not.toBeNull();
    expect(String(err)).not.toContain(WEBHOOK_SECRET);
    expect(await codeOf(async () => mod.verifyProviderWebhook!({ rawBody: raw, timestamp: String(Number(ts) - 600), signature: good }, { secret: WEBHOOK_SECRET, nowMs: NOW }))).not.toBe('none');
    expect(await codeOf(async () => mod.verifyProviderWebhook!({ rawBody: raw, timestamp: undefined, signature: good }, { secret: WEBHOOK_SECRET, nowMs: NOW }))).not.toBe('none');
    expect(await codeOf(async () => mod.verifyProviderWebhook!({ rawBody: raw, timestamp: ts, signature: 'nope' }, { secret: WEBHOOK_SECRET, nowMs: NOW }))).not.toBe('none');
  });

  test('GAT-250 C6 Solapi 사건은 성공·실패만 분류하고 전화번호를 남기지 않는다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    if (!existsSync(webhookPath)) return;
    const mod = await load();
    expect(typeof mod.solapiEventOf).toBe('function');
    if (!mod.solapiEventOf) return;

    expect(mod.solapiEventOf({ type: 'DELIVERED', messageId: 'sms-1', to: '01099998888' })).toEqual({ kind: 'SMS_DELIVERED', providerMessageId: 'sms-1' });
    expect(mod.solapiEventOf({ type: 'FAILED', messageId: 'sms-2', to: '01099998888' })).toEqual({ kind: 'SMS_FAILED', providerMessageId: 'sms-2' });
    expect(mod.solapiEventOf({ type: 'OTHER', messageId: 'sms-3' })).toBeNull();
    expect(JSON.stringify(mod.solapiEventOf({ type: 'DELIVERED', messageId: 'sms-1', to: '01099998888' }))).not.toContain('01099998888');
  });

  test('GAT-250 C7 256KiB 경계·모양 오류를 거절하고 지표 이름·라벨에 개인정보가 없다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    if (!existsSync(webhookPath)) return;
    const mod = await load();
    if (!mod.verifySnsNotification) return;

    const over = signed({ Message: 'x'.repeat(256 * 1024 + 1) });
    let resolverCalls = 0;
    const code = await codeOf(() =>
      mod.verifySnsNotification!(JSON.stringify(over), deps({ certResolver: async () => { resolverCalls += 1; return pub; } })),
    );
    expect(code).toBe('TOO_LARGE');
    expect(resolverCalls).toBe(0);
    expect(await codeOf(() => mod.verifySnsNotification!('not-json', deps()))).toBe('MALFORMED');

    expect(mod.PROVIDER_EVENTS_METRIC).toBe('notify_provider_events_total');
    expect(mod.PROVIDER_EVENTS_LABELS).toEqual(['provider', 'kind', 'result']);
    expect(mod.PROVIDER_REJECTED_METRIC).toBe('notify_provider_webhook_rejected_total');
    expect(mod.PROVIDER_REJECTED_LABELS).toEqual(['provider', 'reason']);
    const labels = [...(mod.PROVIDER_EVENTS_LABELS ?? []), ...(mod.PROVIDER_REJECTED_LABELS ?? [])].join(',');
    for (const pii of ['account', 'email', 'phone', 'messageId', 'address']) expect(labels).not.toContain(pii);
  });
});
