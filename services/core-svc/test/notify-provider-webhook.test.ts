// F-06-6 GAT-250 C1~C7: SES(SNS)·Solapi 결과 웹훅의 서명 검증과 사건 분류.
// 실제 인증서·대행사에 닿지 않는다. SNS 인증서 해석기와 개인키는 이 파일이 그 자리에서 만든다.
// 정본: docs/features/notify.md §4.4·§10·§11, docs/review/plans/F-06-6.md §3.4.
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const webhookUrl = new URL('../src/modules/notify/domain/provider-webhook.ts', import.meta.url).href;
const webhookPath = fileURLToPath(webhookUrl);

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
  verifySnsNotification?: (rawBody: string, o: SnsDeps) => { topicArn: string; message: unknown };
  sesEventOf?: (message: unknown) => ProviderEvent | null;
  verifyProviderWebhook?: (input: { rawBody: string; timestamp: string | undefined; signature: string | undefined }, o: { secret: string; nowMs: number; toleranceMs?: number }) => void;
  solapiEventOf?: (message: unknown) => ProviderEvent | null;
};
const load = async (): Promise<WebhookModule> => (await import(/* @vite-ignore */ webhookUrl)) as WebhookModule;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pub = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const TOPIC = 'arn:aws:sns:ap-northeast-2:123456789012:peaket-notify-events';
const NOW = Date.parse('2026-11-28T05:01:00.000Z');

const eventBody = {
  notificationType: 'Complaint',
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
  if (m.Subject !== undefined) parts.push('Subject', m.Subject);
  parts.push('Timestamp', m.Timestamp, 'TopicArn', m.TopicArn, 'Type', m.Type);
  return `${parts.join('\n')}\n`;
};
const signed = (over: Partial<SnsMessage> = {}): SnsMessage => {
  const m = sns(over);
  return { ...m, Signature: sign('RSA-SHA256', Buffer.from(canonical(m), 'utf8'), privateKey).toString('base64') };
};
const deps = (over: Partial<SnsDeps> = {}): SnsDeps => ({
  allowedTopicArn: TOPIC,
  certHost: 'sns.ap-northeast-2.amazonaws.com',
  nowMs: NOW,
  certResolver: async () => pub,
  ...over,
});
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'none';
  } catch (e) {
    return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : e instanceof Error ? e.name : 'unknown';
  }
};

describe('GAT-250 C 대행사 결과 웹훅', () => {
  test('GAT-250 C1 SNS 유효 서명을 통과하고 Message를 돌려준다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    if (!existsSync(webhookPath)) return;
    const mod = await load();
    expect(typeof mod.verifySnsNotification).toBe('function');
    if (!mod.verifySnsNotification) return;

    const m = signed();
    const r = mod.verifySnsNotification(JSON.stringify(m), deps());
    expect(r.topicArn).toBe(TOPIC);
    expect(r.message).toMatchObject({ notificationType: 'Complaint', mail: { messageId: 'ses-1' } });
  });

  test('GAT-250 C2 서명·토픽·인증서 호스트·오래된 시각을 거절한다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    if (!existsSync(webhookPath)) return;
    const mod = await load();
    if (!mod.verifySnsNotification) return;

    const valid = signed();
    const badSig = { ...valid, Signature: `${valid.Signature.slice(0, -4)}AAAA` };
    expect(codeOf(() => mod.verifySnsNotification!(JSON.stringify(badSig), deps()))).toBe('SIGNATURE');

    const wrongTopic = signed({ TopicArn: 'arn:aws:sns:ap-northeast-2:123456789012:other' });
    expect(codeOf(() => mod.verifySnsNotification!(JSON.stringify(wrongTopic), deps()))).toBe('TOPIC');

    for (const url of [
      'http://sns.ap-northeast-2.amazonaws.com/SimpleNotificationService-test.pem',
      'https://evil.example/SimpleNotificationService-test.pem',
      'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem',
      'https://sns.ap-northeast-2.amazonaws.com/other.pem',
    ]) {
      const m = signed({ SigningCertURL: url });
      expect(codeOf(() => mod.verifySnsNotification!(JSON.stringify(m), deps())), url).toBe('CERT_HOST');
    }

    const old = signed({ Timestamp: '2026-11-28T03:00:00.000Z' });
    expect(codeOf(() => mod.verifySnsNotification!(JSON.stringify(old), deps()))).toBe('STALE');
  });

  test('GAT-250 C3 SNS 구독 확인은 자동으로 승인하지 않는다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    if (!existsSync(webhookPath)) return;
    const mod = await load();
    if (!mod.verifySnsNotification) return;

    const m = signed({ Type: 'SubscriptionConfirmation', Subject: 'Confirm subscription', SubscribeURL: 'https://sns.ap-northeast-2.amazonaws.com/confirm?x=1' });
    expect(codeOf(() => mod.verifySnsNotification!(JSON.stringify(m), deps()))).toBe('SUBSCRIPTION_CONFIRMATION');
  });

  test('GAT-250 C4 SES 사건은 Bounce·Complaint·Delivery만 분류하고 받는 사람 주소를 남기지 않는다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    if (!existsSync(webhookPath)) return;
    const mod = await load();
    expect(typeof mod.sesEventOf).toBe('function');
    if (!mod.sesEventOf) return;

    expect(mod.sesEventOf(eventBody)).toEqual({ kind: 'COMPLAINT', providerMessageId: 'ses-1' });
    expect(mod.sesEventOf({ notificationType: 'Bounce', mail: { messageId: 'ses-2', destination: ['fan@example.com'] } })).toMatchObject({ kind: 'BOUNCE', providerMessageId: 'ses-2' });
    expect(mod.sesEventOf({ notificationType: 'Delivery', mail: { messageId: 'ses-3' } })).toMatchObject({ kind: 'DELIVERY' });
    expect(mod.sesEventOf({ notificationType: 'Other', mail: { messageId: 'ses-4' } })).toBeNull();
    expect(JSON.stringify(mod.sesEventOf(eventBody))).not.toContain('fan@example.com');
  });

  test('GAT-250 C5 Solapi HMAC은 유효하면 통과하고 본문 변조·오래된 시각·모양 오류를 거절한다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    if (!existsSync(webhookPath)) return;
    const mod = await load();
    expect(typeof mod.verifyProviderWebhook).toBe('function');
    if (!mod.verifyProviderWebhook) return;

    const secret = Buffer.alloc(32, 3).toString('base64url');
    const raw = JSON.stringify({ type: 'DELIVERED', messageId: 'sms-1' });
    const ts = String(Math.floor(NOW / 1000));
    const good = `v1=${createHmac('sha256', secret).update(`${ts}.${raw}`, 'utf8').digest('hex')}`;
    expect(() => mod.verifyProviderWebhook!({ rawBody: raw, timestamp: ts, signature: good }, { secret, nowMs: NOW })).not.toThrow();
    expect(codeOf(() => mod.verifyProviderWebhook!({ rawBody: `${raw} `, timestamp: ts, signature: good }, { secret, nowMs: NOW }))).not.toBe('none');
    expect(codeOf(() => mod.verifyProviderWebhook!({ rawBody: raw, timestamp: String(Number(ts) - 600), signature: good }, { secret, nowMs: NOW }))).not.toBe('none');
    expect(codeOf(() => mod.verifyProviderWebhook!({ rawBody: raw, timestamp: undefined, signature: good }, { secret, nowMs: NOW }))).not.toBe('none');
    expect(codeOf(() => mod.verifyProviderWebhook!({ rawBody: raw, timestamp: ts, signature: 'nope' }, { secret, nowMs: NOW }))).not.toBe('none');
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

  test('GAT-250 C7 본문 상한·모양 오류를 거절한다', async () => {
    expect(existsSync(webhookPath)).toBe(true);
    if (!existsSync(webhookPath)) return;
    const mod = await load();
    if (!mod.verifySnsNotification) return;

    const big = signed({ Message: 'x'.repeat(300 * 1024) });
    expect(codeOf(() => mod.verifySnsNotification!(JSON.stringify(big), deps()))).toBe('TOO_LARGE');
    expect(codeOf(() => mod.verifySnsNotification!('not-json', deps()))).toBe('MALFORMED');
  });
});

