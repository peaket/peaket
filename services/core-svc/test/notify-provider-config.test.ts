// F-06-6 GAT-250 A1~A9: 운영 메일·문자·알림톡·VAPID 설정 계약과 fail-closed.
// 정본: docs/features/notify.md §4.4·§4.6·§16, docs/security/secrets-and-keys.md '발송 대행 자격 증명'·'Web Push VAPID 키쌍',
// docs/security/asvs/notify.md 13.2.1, docs/review/plans/F-06-6.md §3.1.
// 자격 증명 값은 쓰지 않는다. 시험 키쌍은 이 파일이 그 자리에서 만든다.
import { describe, expect, test } from 'vitest';
import { FAN_NOTIFY_MAIL, FAN_NOTIFY_SMS, FAN_NOTIFY_VAPID, fanNotifyProviders } from '../src/modules/notify/notify.module.js';
import {
  mailProviderConfigFromEnv,
  mailTransportFromEnv,
  providerConfigSummary,
  redactProviderText,
  smsProviderConfigFromEnv,
  smsTransportFromEnv,
  vapidFromEnv,
} from '../src/modules/notify/adapters/config.js';
import { vapidKeys } from './fan-notify-support.js';

type Env = Record<string, string | undefined>;

const OPTOUT = Buffer.alloc(32, 5).toString('base64url');
const VAPID = (() => {
  const keys = vapidKeys();
  return {
    PEAKET_VAPID_PRIVATE_KEY: keys.privateKey,
    PEAKET_VAPID_PUBLIC_KEY: keys.publicKey,
    PEAKET_VAPID_SUBJECT: 'mailto:notify@peaket.example',
    publicKey: keys.publicKey,
  };
})();
const SES: Env = {
  PEAKET_ENV: 'prod',
  PEAKET_NOTIFY_MAIL_PROVIDER: 'ses',
  PEAKET_SES_REGION: 'ap-northeast-2',
  PEAKET_NOTIFY_MAIL_FROM: 'no-reply@notify.peaket.example',
  PEAKET_NOTIFY_MAIL_FROM_DOMAIN: 'notify.peaket.example',
  PEAKET_SES_CONFIGURATION_SET: 'peaket-notify-events',
  PEAKET_SES_SNS_TOPIC_ARN: 'arn:aws:sns:ap-northeast-2:123456789012:peaket-notify-events',
  PEAKET_NOTIFY_MAIL_RATE_PER_SEC: '10',
};
const WEBHOOK_SECRET = Buffer.alloc(32, 9).toString('base64url');
const SOLAPI: Env = {
  PEAKET_ENV: 'prod',
  PEAKET_NOTIFY_SMS_PROVIDER: 'solapi',
  PEAKET_SOLAPI_API_KEY: 'test-api-key',
  PEAKET_SOLAPI_API_SECRET: 'test-api-secret',
  PEAKET_SOLAPI_SENDER_NUMBER: '010-1234-5678',
  PEAKET_NOTIFY_SMS_RATE_PER_SEC: '5',
  PEAKET_NOTIFY_SMS_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PEAKET_NOTIFY_ALIMTALK_PROVIDER: 'off',
};
const without = (base: Env, key: string): Env => {
  const out: Env = { ...base };
  delete out[key];
  return out;
};
const fullProd = (): Env => ({
  ...SES,
  ...SOLAPI,
  ...VAPID,
  PEAKET_NOTIFY_OPTOUT_KEY: OPTOUT,
});

describe('GAT-250 A 운영 대행 설정 계약', () => {
  test('GAT-250 A1 운영에서 메일 provider가 없으면 시작하지 않는다', () => {
    expect(() => mailProviderConfigFromEnv({ PEAKET_ENV: 'prod' })).toThrow(/PEAKET_NOTIFY_MAIL_PROVIDER/);
    expect(() => mailProviderConfigFromEnv({ PEAKET_ENV: 'staging' })).toThrow(/PEAKET_NOTIFY_MAIL_PROVIDER/);
    expect(() => mailProviderConfigFromEnv({ NODE_ENV: 'production' })).toThrow(/PEAKET_NOTIFY_MAIL_PROVIDER/);
    expect(() => mailProviderConfigFromEnv({ NODE_ENV: 'production', PEAKET_ENV: 'local' })).toThrow(/PEAKET_NOTIFY_MAIL_PROVIDER/);
  });

  test('GAT-250 A2 SES 필수 값이 없거나 비어 있으면 그 이름을 가리키며 시작하지 않는다', () => {
    for (const key of [
      'PEAKET_SES_REGION',
      'PEAKET_NOTIFY_MAIL_FROM',
      'PEAKET_NOTIFY_MAIL_FROM_DOMAIN',
      'PEAKET_SES_CONFIGURATION_SET',
      'PEAKET_SES_SNS_TOPIC_ARN',
      'PEAKET_NOTIFY_MAIL_RATE_PER_SEC',
    ]) {
      expect(() => mailProviderConfigFromEnv(without(SES, key)), key).toThrow(new RegExp(key));
      expect(() => mailProviderConfigFromEnv({ ...SES, [key]: '' }), `${key} empty`).toThrow(new RegExp(key));
    }
  });

  test('GAT-250 A3 서울 밖 리전과 발신 도메인이 다른 주소를 거부한다', () => {
    expect(() => mailProviderConfigFromEnv({ ...SES, PEAKET_SES_REGION: 'us-east-1' })).toThrow(/ap-northeast-2/);
    expect(() => mailProviderConfigFromEnv({ ...SES, PEAKET_NOTIFY_MAIL_FROM: 'no-reply@peaket.example' })).toThrow(/발신 도메인/);
    expect(mailProviderConfigFromEnv(SES)).toMatchObject({
      kind: 'ses',
      region: 'ap-northeast-2',
      fromDomain: 'notify.peaket.example',
      ratePerSec: 10,
    });
  });

  test('GAT-250 A4 문자·알림톡 provider는 명시해야 하고 Solapi·알림톡 필수 값을 검사한다', () => {
    const off: Env = { PEAKET_ENV: 'prod', PEAKET_NOTIFY_SMS_PROVIDER: 'off', PEAKET_NOTIFY_ALIMTALK_PROVIDER: 'off' };
    expect(smsProviderConfigFromEnv(off)).toEqual({ kind: 'off' });
    expect(() => smsProviderConfigFromEnv({ PEAKET_ENV: 'prod' })).toThrow(/PEAKET_NOTIFY_SMS_PROVIDER/);
    expect(() => smsProviderConfigFromEnv({ PEAKET_ENV: 'prod', PEAKET_NOTIFY_SMS_PROVIDER: 'off' })).toThrow(/PEAKET_NOTIFY_ALIMTALK_PROVIDER/);
    expect(() => smsProviderConfigFromEnv({ ...off, PEAKET_NOTIFY_ALIMTALK_PROVIDER: 'kakao' })).toThrow(/PEAKET_NOTIFY_ALIMTALK_PROVIDER/);
    expect(() => smsProviderConfigFromEnv({ NODE_ENV: 'production', PEAKET_ENV: 'local' })).toThrow(/PEAKET_NOTIFY_SMS_PROVIDER/);
    for (const key of [
      'PEAKET_SOLAPI_API_KEY',
      'PEAKET_SOLAPI_API_SECRET',
      'PEAKET_SOLAPI_SENDER_NUMBER',
      'PEAKET_NOTIFY_SMS_RATE_PER_SEC',
      'PEAKET_NOTIFY_SMS_WEBHOOK_SECRET',
    ]) {
      expect(() => smsProviderConfigFromEnv(without(SOLAPI, key)), key).toThrow(new RegExp(key));
    }
    expect(() => smsProviderConfigFromEnv({ ...SOLAPI, PEAKET_NOTIFY_ALIMTALK_PROVIDER: 'solapi' })).toThrow(/PF|템플릿/);
    expect(() =>
      smsProviderConfigFromEnv({ ...SOLAPI, PEAKET_NOTIFY_ALIMTALK_PROVIDER: 'solapi', PEAKET_SOLAPI_ALIMTALK_PF_ID: 'pf-test' }),
    ).toThrow(/템플릿/);
    expect(smsProviderConfigFromEnv({ ...SOLAPI, PEAKET_SOLAPI_SENDER_NUMBER: '02-123-4567' })).toMatchObject({ senderNumber: '021234567' });
    const configured = smsProviderConfigFromEnv({
      ...SOLAPI,
      PEAKET_NOTIFY_ALIMTALK_PROVIDER: 'solapi',
      PEAKET_SOLAPI_ALIMTALK_PF_ID: 'pf-test',
      PEAKET_NOTIFY_ALIMTALK_TEMPLATES: 'REFUNDED=tpl-refund, EVENT_CANCELLATION_CONFIRMED=tpl-cancel',
    });
    expect(configured).toMatchObject({ kind: 'solapi', senderNumber: '01012345678', ratePerSec: 5, alimtalk: { pfId: 'pf-test' } });
    if (configured.kind === 'solapi') {
      expect(configured.alimtalk?.templates).toMatchObject({ REFUNDED: 'tpl-refund', EVENT_CANCELLATION_CONFIRMED: 'tpl-cancel' });
    }
  });

  test('GAT-250 A5 VAPID 키쌍·sub는 운영 필수이고 모양과 일치를 검사한다', () => {
    expect(() => vapidFromEnv({ PEAKET_ENV: 'prod' })).toThrow(/PEAKET_VAPID_PRIVATE_KEY/);
    expect(() => vapidFromEnv({ NODE_ENV: 'production', PEAKET_ENV: 'local' })).toThrow(/PEAKET_VAPID_PRIVATE_KEY/);
    const keys = vapidKeys();
    expect(() => vapidFromEnv(without(VAPID, 'PEAKET_VAPID_SUBJECT'))).toThrow(/PEAKET_VAPID_SUBJECT/);
    expect(() => vapidFromEnv({ ...VAPID, PEAKET_VAPID_SUBJECT: 'http://peaket.example' })).toThrow(/PEAKET_VAPID_SUBJECT/);
    expect(() => vapidFromEnv({ ...VAPID, PEAKET_VAPID_SUBJECT: 'mailto:a@b@c' })).toThrow(/PEAKET_VAPID_SUBJECT/);
    expect(vapidFromEnv({ ...VAPID, PEAKET_VAPID_SUBJECT: 'https://peaket.example/notify' })).toMatchObject({ subject: 'https://peaket.example/notify' });
    expect(() => vapidFromEnv({ ...VAPID, PEAKET_VAPID_PUBLIC_KEY: keys.publicKey })).toThrow(/PEAKET_VAPID_PUBLIC_KEY/);
    expect(vapidFromEnv(VAPID)).toMatchObject({ publicKey: VAPID.publicKey, subject: 'mailto:notify@peaket.example' });
  });

  test('GAT-250 A6 설정 요약과 로그·오류 문구에 비밀이 없다', () => {
    const secrets = ['test-api-key', 'test-api-secret', WEBHOOK_SECRET, '01012345678', VAPID.PEAKET_VAPID_PRIVATE_KEY!];
    const summary = JSON.stringify([
      providerConfigSummary(smsProviderConfigFromEnv(SOLAPI)),
      providerConfigSummary(mailProviderConfigFromEnv(SES)),
      providerConfigSummary(vapidFromEnv(VAPID)),
    ]);
    for (const s of secrets) expect(summary, s).not.toContain(s);
    expect(summary).toContain('solapi');
    expect(summary).toContain('ses');
    expect(summary).toContain('vapid');

    const text = `Authorization: HMAC-SHA256 apiKey=test-api-key, signature=test-api-secret\nwebhook=${WEBHOOK_SECRET}\nto=01012345678`;
    const redacted = redactProviderText(text, secrets);
    for (const s of secrets) expect(redacted, s).not.toContain(s);
    expect(redacted).not.toContain('signature=');
    expect(redacted).toContain('[redacted]');
  });

  test('GAT-250 A7 운영 설정이 없으면 조립이 던지고, 있으면 SES·Solapi·VAPID를 설정대로 조립한다', () => {
    expect(() => fanNotifyProviders({ storage: 'memory', env: { PEAKET_ENV: 'prod', PEAKET_NOTIFY_OPTOUT_KEY: OPTOUT } })).toThrow();
    const { providers } = fanNotifyProviders({ storage: 'memory', env: fullProd() });
    const valueOf = (token: symbol): unknown => {
      for (const p of providers) {
        if (typeof p === 'object' && p !== null && 'provide' in p && p.provide === token && 'useValue' in p) return p.useValue;
      }
      return undefined;
    };
    const mail = valueOf(FAN_NOTIFY_MAIL) as { describe?: () => Record<string, unknown> } | undefined;
    const sms = valueOf(FAN_NOTIFY_SMS) as { describe?: () => Record<string, unknown> } | undefined;
    const vapid = valueOf(FAN_NOTIFY_VAPID) as { publicKey?: string; subject?: string } | undefined;
    expect(mail?.describe?.()).toMatchObject({
      provider: 'ses',
      region: 'ap-northeast-2',
      from: 'no-reply@notify.peaket.example',
      fromDomain: 'notify.peaket.example',
      configurationSet: 'peaket-notify-events',
      snsTopicArn: 'arn:aws:sns:ap-northeast-2:123456789012:peaket-notify-events',
      ratePerSec: 10,
    });
    expect(sms?.describe?.()).toMatchObject({ provider: 'solapi', senderNumber: '01012345678', ratePerSec: 5, alimtalk: null });
    expect(vapid).toMatchObject({ publicKey: VAPID.publicKey, subject: 'mailto:notify@peaket.example' });
  });

  test('GAT-250 A8 운영에서 파일·가짜 대역을 거부한다', () => {
    expect(() => mailProviderConfigFromEnv({ ...SES, PEAKET_NOTIFY_MAIL_PROVIDER: 'file' })).toThrow(/local/);
    expect(() => mailProviderConfigFromEnv({ ...SES, PEAKET_NOTIFY_MAIL_PROVIDER: 'fake' })).toThrow(/local/);
    expect(() => mailTransportFromEnv({ ...SES, PEAKET_NOTIFY_MAIL_PROVIDER: 'file' })).toThrow(/local/);
    expect(() => smsTransportFromEnv({ ...SOLAPI, PEAKET_NOTIFY_SMS_PROVIDER: 'file' })).toThrow(/local/);
    expect(() => mailProviderConfigFromEnv({ NODE_ENV: 'production', PEAKET_ENV: 'local', PEAKET_NOTIFY_MAIL_PROVIDER: 'file' })).toThrow(/local/);
    expect(() => smsTransportFromEnv({ NODE_ENV: 'production', PEAKET_ENV: 'local', PEAKET_NOTIFY_SMS_PROVIDER: 'fake' })).toThrow(/local/);
  });

  test('GAT-250 A9 local·ci는 VAPID 키가 없어도 같은 고정 시험 키를 쓴다(회귀)', () => {
    const local = vapidFromEnv({ PEAKET_ENV: 'local' });
    const ci = vapidFromEnv({ PEAKET_ENV: 'ci' });
    expect(local.publicKey).toBe(ci.publicKey);
    expect(local.subject).toBe('mailto:notify@peaket.example');
  });
});
