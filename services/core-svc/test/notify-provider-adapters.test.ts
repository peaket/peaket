// F-06-6 GAT-250 B1~B6: SES·Solapi 운영 어댑터의 요청 모양·오류 분류·한도·알림톡 payload.
// 실제 네트워크를 쓰지 않는다. SES 클라이언트와 Solapi fetch는 시험이 준 가짜다(경계 가짜).
// 정본: docs/features/notify.md §4.4·§10, docs/review/plans/F-06-6.md §3.2·§3.3.
import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { MailTransportError, SmsTransportError, type MailMessage } from '../src/modules/notify/index.js';

type Env = Record<string, string | undefined>;

interface SesInput {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  ReplyToAddresses?: string[];
  Content: {
    Simple: {
      Subject: { Data: string; Charset?: string };
      Body: { Text: { Data: string; Charset?: string } };
      Headers?: { Name: string; Value: string }[];
    };
  };
  ConfigurationSetName: string;
  EmailTags: { Name: string; Value: string }[];
}
interface SesClient {
  send(input: SesInput): Promise<{ MessageId?: string }>;
}
interface SesOptions {
  client: SesClient;
  from: string;
  fromDomain: string;
  configurationSet: string;
  replyTo?: string;
  ratePerSec?: number;
  clock?: () => number;
}
interface SesTransport {
  send(input: MailMessage): Promise<{ providerMessageId?: string }>;
}
interface SolapiOptions {
  apiKey: string;
  apiSecret: string;
  senderNumber: string;
  ratePerSec?: number;
  clock?: () => number;
  fetch: (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>;
  alimtalk?: { pfId: string; templates: Record<string, string> };
}
interface SolapiTransport {
  send(input: { to: string; body: string; messageKey: string; kind?: string; templateVariables?: Record<string, string> }): Promise<{ providerMessageId?: string }>;
}

const sesUrl = new URL('../src/modules/notify/adapters/ses-mail-transport.ts', import.meta.url).href;
const solapiUrl = new URL('../src/modules/notify/adapters/solapi-sms-transport.ts', import.meta.url).href;
const sesPath = fileURLToPath(sesUrl);
const solapiPath = fileURLToPath(solapiUrl);

const loadSes = async (): Promise<{ SesMailTransport?: new (o: SesOptions) => SesTransport }> =>
  (await import(/* @vite-ignore */ sesUrl)) as { SesMailTransport?: new (o: SesOptions) => SesTransport };
const loadSolapi = async (): Promise<{ SolapiSmsTransport?: new (o: SolapiOptions) => SolapiTransport }> =>
  (await import(/* @vite-ignore */ solapiUrl)) as { SolapiSmsTransport?: new (o: SolapiOptions) => SolapiTransport };

const mail = (over: Partial<MailMessage> = {}): MailMessage => ({
  to: 'fan@example.com',
  subject: '환급이 완료되었습니다',
  body: '환급 금액 110,000원이 결제 수단으로 돌아갑니다.',
  headers: {
    'content-type': 'text/plain; charset=utf-8',
    'list-unsubscribe': '<https://peaket.example/v1/subscription-opt-outs/token>',
    'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
    'x-other': 'drop-me',
  },
  messageKey: 'REFUNDED:01900000-0000-7000-8000-0000000000d1:01900000-0000-7000-8000-0000000000a1:EMAIL',
  ...over,
});

const sesBase = (client: SesClient, over: Partial<SesOptions> = {}): SesOptions => ({
  client,
  from: 'no-reply@notify.peaket.example',
  fromDomain: 'notify.peaket.example',
  configurationSet: 'peaket-notify-events',
  ...over,
});

const sesError = (status: number): Error => Object.assign(new Error(`ses-${status}`), { $metadata: { httpStatusCode: status }, status });
const jsonOk = (body: unknown) => ({ status: 200, text: async () => JSON.stringify(body) });

describe('GAT-250 B 운영 대행 어댑터', () => {
  test('GAT-250 B1 SES 요청은 발신 도메인·평문 본문·허용 머리·해시 태그만 보낸다', async () => {
    expect(existsSync(sesPath)).toBe(true);
    if (!existsSync(sesPath)) return;
    const { SesMailTransport } = await loadSes();
    expect(typeof SesMailTransport).toBe('function');
    if (typeof SesMailTransport !== 'function') return;

    const sent: SesInput[] = [];
    const t = new SesMailTransport(sesBase({ send: async (input) => { sent.push(input); return { MessageId: 'ses-1' }; } }));
    const r = await t.send(mail());

    expect(sent).toHaveLength(1);
    const s = sent[0]!;
    expect(s.FromEmailAddress).toBe('no-reply@notify.peaket.example');
    expect(s.Destination.ToAddresses).toEqual(['fan@example.com']);
    expect(s.ConfigurationSetName).toBe('peaket-notify-events');
    expect(s.Content.Simple.Subject.Data).toBe('환급이 완료되었습니다');
    expect(s.Content.Simple.Body.Text.Data).toContain('110,000원');
    expect((s.Content.Simple.Headers ?? []).map((h) => h.Name.toLowerCase())).toEqual(['list-unsubscribe', 'list-unsubscribe-post']);
    const tag = s.EmailTags.find((x) => x.Name === 'peaket-dedup');
    expect(tag?.Value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tag?.Value).toBe(createHash('sha256').update(mail().messageKey, 'utf8').digest('base64url'));
    expect(tag?.Value).not.toContain('01900000');
    expect(r.providerMessageId).toBe('ses-1');
  });

  test('GAT-250 B2 SES 오류는 400 영구, 429·5xx·시간 초과는 재시도, 그 밖은 결과 모름이다', async () => {
    expect(existsSync(sesPath)).toBe(true);
    if (!existsSync(sesPath)) return;
    const { SesMailTransport } = await loadSes();
    if (typeof SesMailTransport !== 'function') return;

    for (const [status, kind] of [[400, 'PERMANENT'], [401, 'RETRYABLE'], [403, 'RETRYABLE'], [404, 'RETRYABLE'], [409, 'RETRYABLE'], [429, 'RETRYABLE'], [500, 'RETRYABLE'], [503, 'RETRYABLE']] as const) {
      const t = new SesMailTransport(sesBase({ send: async () => { throw sesError(status); } }));
      await expect(t.send(mail())).rejects.toMatchObject({ name: 'MailTransportError', kind });
    }
    const timeout = new SesMailTransport(sesBase({ send: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); } }));
    await expect(timeout.send(mail())).rejects.toMatchObject({ kind: 'RETRYABLE' });
    expect(new MailTransportError('RETRYABLE', 'x', 429).status).toBe(429);
  });

  test('GAT-250 B3 SES 한도는 ratePerSec까지만 부르고 그 뒤는 재시도로 돌려준다', async () => {
    expect(existsSync(sesPath)).toBe(true);
    if (!existsSync(sesPath)) return;
    const { SesMailTransport } = await loadSes();
    if (typeof SesMailTransport !== 'function') return;

    let now = 1_000;
    let calls = 0;
    const t = new SesMailTransport(sesBase({ send: async () => { calls += 1; return { MessageId: `s-${calls}` }; } }, { ratePerSec: 2, clock: () => now }));
    await t.send(mail());
    await t.send(mail());
    await expect(t.send(mail())).rejects.toMatchObject({ kind: 'RETRYABLE', message: /rate/ });
    expect(calls).toBe(2);
    now = 2_000;
    await t.send(mail());
    expect(calls).toBe(3);
  });

  test('GAT-250 B4 Solapi 요청은 HMAC 인증·발신번호·본문을 보내고 messageId를 돌려준다', async () => {
    expect(existsSync(solapiPath)).toBe(true);
    if (!existsSync(solapiPath)) return;
    const { SolapiSmsTransport } = await loadSolapi();
    expect(typeof SolapiSmsTransport).toBe('function');
    if (typeof SolapiSmsTransport !== 'function') return;

    const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
    const now = Date.UTC(2026, 10, 28, 0, 0, 0);
    const t = new SolapiSmsTransport({
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret',
      senderNumber: '01012345678',
      clock: () => now,
      fetch: async (url, init) => { calls.push({ url, init }); return jsonOk({ messageId: 'solapi-1' }); },
    });
    const r = await t.send({ to: '01099998888', body: '[피켓] 공연 전날 월렛을 열어 주세요', messageKey: 'WALLET_OPEN_REMINDER:e1:a1:SMS' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.solapi.com/messages/v4/send');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ message: { to: '01099998888', from: '01012345678', text: '[피켓] 공연 전날 월렛을 열어 주세요' } });
    const auth = calls[0]!.init.headers.Authorization ?? calls[0]!.init.headers.authorization ?? '';
    const m = /^HMAC-SHA256 apiKey=([^,]+), date=([^,]+), salt=([^,]+), signature=([0-9a-f]+)$/.exec(auth);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m[1]).toBe('test-api-key');
    expect(Date.parse(m[2]!)).toBe(now);
    expect(m[4]).toBe(createHmac('sha256', 'test-api-secret').update(`${m[2]}${m[3]}`).digest('hex'));
    expect(r.providerMessageId).toBe('solapi-1');
  });

  test('GAT-250 B5 Solapi 오류는 400 영구, 401·409·429·5xx·연결 실패는 재시도, 잘못된 응답은 결과 모름이다', async () => {
    expect(existsSync(solapiPath)).toBe(true);
    if (!existsSync(solapiPath)) return;
    const { SolapiSmsTransport } = await loadSolapi();
    if (typeof SolapiSmsTransport !== 'function') return;

    const base: Omit<SolapiOptions, 'fetch'> = { apiKey: 'k', apiSecret: 's', senderNumber: '01012345678' };
    for (const [status, kind] of [[400, 'PERMANENT'], [401, 'RETRYABLE'], [403, 'RETRYABLE'], [409, 'RETRYABLE'], [429, 'RETRYABLE'], [500, 'RETRYABLE'], [503, 'RETRYABLE']] as const) {
      const t = new SolapiSmsTransport({ ...base, fetch: async () => ({ status, text: async () => '{"error":"x"}' }) });
      await expect(t.send({ to: '01099998888', body: '[피켓] x', messageKey: 'k' })).rejects.toMatchObject({ name: 'SmsTransportError', kind });
    }
    const network = new SolapiSmsTransport({ ...base, fetch: async () => { throw new TypeError('fetch failed'); } });
    await expect(network.send({ to: '01099998888', body: '[피켓] x', messageKey: 'k' })).rejects.toMatchObject({ kind: 'RETRYABLE' });
    const broken = new SolapiSmsTransport({ ...base, fetch: async () => ({ status: 200, text: async () => 'not-json' }) });
    await expect(broken.send({ to: '01099998888', body: '[피켓] x', messageKey: 'k' })).rejects.toMatchObject({ kind: 'UNKNOWN' });
    expect(new SmsTransportError('RETRYABLE', 'x', 503).status).toBe(503);
  });

  test('GAT-250 B6 알림톡은 pfId·템플릿 ID·허용 변수만 싣고 템플릿이 없으면 영구 실패다', async () => {
    expect(existsSync(solapiPath)).toBe(true);
    if (!existsSync(solapiPath)) return;
    const { SolapiSmsTransport } = await loadSolapi();
    if (typeof SolapiSmsTransport !== 'function') return;

    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    const t = new SolapiSmsTransport({
      apiKey: 'k',
      apiSecret: 's',
      senderNumber: '01012345678',
      alimtalk: { pfId: 'pf-test', templates: { REFUNDED: 'tpl-refund' } },
      fetch: async (_url, init) => { calls += 1; bodies.push(JSON.parse(init.body) as Record<string, unknown>); return jsonOk({ messageId: 'kakao-1' }); },
    });
    const r = await t.send({
      to: '01099998888',
      body: '[피켓] 환급 안내',
      messageKey: 'REFUNDED:o:a:ALIMTALK',
      kind: 'REFUNDED',
      templateVariables: { orderNo: '1234' },
    });
    const message = bodies[0]!.message as Record<string, unknown>;
    expect(message.to).toBe('01099998888');
    expect(message.from).toBe('01012345678');
    expect(message.kakaoOptions).toEqual({ pfId: 'pf-test', templateId: 'tpl-refund', variables: { orderNo: '1234' } });
    expect(r.providerMessageId).toBe('kakao-1');

    await expect(t.send({ to: '01099998888', body: '[피켓] x', messageKey: 'AD:o:a:ALIMTALK', kind: 'AD' })).rejects.toMatchObject({ kind: 'PERMANENT', message: /template/ });
    expect(calls).toBe(1);
  });
});
