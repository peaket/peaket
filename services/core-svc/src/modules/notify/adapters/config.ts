// F-06-6 GAT-250 운영 대행 설정: SES·Solapi·알림톡·VAPID·웹훅 비밀. 운영 값은 Secrets Manager가 환경으로 넣는다.
// staging·prod는 필수 값이 없거나 틀리면 시작 전에 던진다(fail-closed). 파일·가짜 대역은 local·ci·demo만.
import { createECDH, createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { createExternalHttpClient, isProductionLikeEnv } from '@peaket/platform';
import type { MailTransport, SmsTransport, VapidConfig } from '../domain/fan-notify-ports.js';
import { FakeMailTransport, FakeSmsTransport } from './fake-transports.js';
import { FileMailTransport, NOTIFY_MAIL_DIR_ENV } from './file-mail-transport.js';
import { FileSmsTransport, NOTIFY_SMS_DIR_ENV } from './file-sms-transport.js';
import { SesMailTransport } from './ses-mail-transport.js';
import { SolapiSmsTransport } from './solapi-sms-transport.js';

export { redactProviderText } from './redact.js';

export const OPTOUT_KEY_ENV = 'PEAKET_NOTIFY_OPTOUT_KEY';
export const TOPIC_KEY_ENV = 'PEAKET_NOTIFY_TOPIC_KEY';
export const VAPID_PRIVATE_ENV = 'PEAKET_VAPID_PRIVATE_KEY';
export const VAPID_PUBLIC_ENV = 'PEAKET_VAPID_PUBLIC_KEY';
export const VAPID_SUBJECT_ENV = 'PEAKET_VAPID_SUBJECT';
export const PUBLIC_ORIGIN_ENV = 'PEAKET_PUBLIC_ORIGIN';

export const MAIL_PROVIDER_ENV = 'PEAKET_NOTIFY_MAIL_PROVIDER';
export const SES_REGION_ENV = 'PEAKET_SES_REGION';
export const MAIL_FROM_ENV = 'PEAKET_NOTIFY_MAIL_FROM';
export const MAIL_FROM_DOMAIN_ENV = 'PEAKET_NOTIFY_MAIL_FROM_DOMAIN';
export const SES_CONFIGURATION_SET_ENV = 'PEAKET_SES_CONFIGURATION_SET';
export const SES_SNS_TOPIC_ENV = 'PEAKET_SES_SNS_TOPIC_ARN';
export const MAIL_RATE_ENV = 'PEAKET_NOTIFY_MAIL_RATE_PER_SEC';
export const SMS_PROVIDER_ENV = 'PEAKET_NOTIFY_SMS_PROVIDER';
export const SOLAPI_KEY_ENV = 'PEAKET_SOLAPI_API_KEY';
export const SOLAPI_SECRET_ENV = 'PEAKET_SOLAPI_API_SECRET';
export const SOLAPI_SENDER_ENV = 'PEAKET_SOLAPI_SENDER_NUMBER';
export const SMS_RATE_ENV = 'PEAKET_NOTIFY_SMS_RATE_PER_SEC';
export const SMS_WEBHOOK_SECRET_ENV = 'PEAKET_NOTIFY_SMS_WEBHOOK_SECRET';
export const ALIMTALK_PROVIDER_ENV = 'PEAKET_NOTIFY_ALIMTALK_PROVIDER';
export const ALIMTALK_PF_ENV = 'PEAKET_SOLAPI_ALIMTALK_PF_ID';
export const ALIMTALK_TEMPLATES_ENV = 'PEAKET_NOTIFY_ALIMTALK_TEMPLATES';

const LOCAL_ENVS = new Set(['local', 'ci', 'demo', 'test']);
const isLocal = (env: Record<string, string | undefined>): boolean => !isProductionLikeEnv(env) && (env.PEAKET_ENV === undefined || LOCAL_ENVS.has(env.PEAKET_ENV));
const text = (env: Record<string, string | undefined>, key: string): string => env[key]?.trim() ?? '';
const required = (env: Record<string, string | undefined>, key: string, purpose: string): string => {
  const v = text(env, key);
  if (!v) throw new Error(`${key}가 없다(${purpose}, Secrets Manager)`);
  return v;
};
const rateOf = (env: Record<string, string | undefined>, key: string): number => {
  const raw = required(env, key, '초당 발송 한도');
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key}는 1 이상 정수여야 합니다`);
  return n;
};

export interface SesMailConfig {
  kind: 'ses';
  region: string;
  from: string;
  fromDomain: string;
  configurationSet: string;
  snsTopicArn: string;
  ratePerSec: number;
  replyTo?: string;
}
export interface SolapiAlimtalkConfig {
  pfId: string;
  templates: Readonly<Record<string, string>>;
}
export interface SolapiSmsConfig {
  kind: 'solapi';
  apiKey: string;
  apiSecret: string;
  senderNumber: string;
  ratePerSec: number;
  webhookSecret: string;
  alimtalk: SolapiAlimtalkConfig | null;
}
export type MailProviderConfig = SesMailConfig | { kind: 'file'; dir: string } | { kind: 'fake' } | { kind: 'unset' };
export type SmsProviderConfig = SolapiSmsConfig | { kind: 'off' } | { kind: 'file'; dir: string } | { kind: 'fake' } | { kind: 'unset' };

/** 운영은 `ses`만. local·ci·demo는 `file`·`fake`·미설정(unset)을 허용한다 */
export function mailProviderConfigFromEnv(env: Record<string, string | undefined>): MailProviderConfig {
  const provider = text(env, MAIL_PROVIDER_ENV);
  const prod = isProductionLikeEnv(env);
  if (prod) {
    if (provider !== 'ses') {
      if (provider === 'file' || provider === 'fake') throw new Error(`${MAIL_PROVIDER_ENV}=${provider}는 local·ci·demo에서만 쓴다`);
      throw new Error(`${MAIL_PROVIDER_ENV}가 없다(운영은 ses만, Secrets Manager)`);
    }
  }
  if (provider === '') return { kind: 'unset' };
  if (provider === 'file') {
    if (!isLocal(env)) throw new Error(`${MAIL_PROVIDER_ENV}=file은 local·ci·demo에서만 쓴다`);
    const dir = required(env, NOTIFY_MAIL_DIR_ENV, '메일 파일 대역 폴더');
    return { kind: 'file', dir };
  }
  if (provider === 'fake') {
    if (!isLocal(env)) throw new Error(`${MAIL_PROVIDER_ENV}=fake는 local·ci·demo에서만 쓴다`);
    return { kind: 'fake' };
  }
  if (provider !== 'ses') throw new Error(`${MAIL_PROVIDER_ENV} 값이 올바르지 않다: ${provider}`);

  const region = required(env, SES_REGION_ENV, 'SES 리전');
  if (region !== 'ap-northeast-2') throw new Error(`${SES_REGION_ENV}는 ap-northeast-2(서울)만 쓴다: ${region}`);
  const from = required(env, MAIL_FROM_ENV, '발신 주소');
  const fromDomain = required(env, MAIL_FROM_DOMAIN_ENV, '발신 도메인');
  const at = from.lastIndexOf('@');
  if (at <= 0 || from.slice(at + 1).toLowerCase() !== fromDomain.toLowerCase()) {
    throw new Error(`${MAIL_FROM_ENV}가 발신 도메인(${MAIL_FROM_DOMAIN_ENV})과 다릅니다: ${from}`);
  }
  const configurationSet = required(env, SES_CONFIGURATION_SET_ENV, 'SES 구성 묶음');
  const snsTopicArn = required(env, SES_SNS_TOPIC_ENV, 'SES 결과 SNS 토픽');
  const ratePerSec = rateOf(env, MAIL_RATE_ENV);
  const replyTo = text(env, 'PEAKET_NOTIFY_MAIL_REPLY_TO');
  return { kind: 'ses', region, from, fromDomain, configurationSet, snsTopicArn, ratePerSec, ...(replyTo ? { replyTo } : {}) };
}

/** 운영은 `solapi`·`off`와 `PEAKET_NOTIFY_ALIMTALK_PROVIDER`를 명시해야 한다. 알림톡이 solapi면 PF·템플릿도 필수다 */
export function smsProviderConfigFromEnv(env: Record<string, string | undefined>): SmsProviderConfig {
  const prod = isProductionLikeEnv(env);
  const provider = text(env, SMS_PROVIDER_ENV);
  const alimtalkProvider = text(env, ALIMTALK_PROVIDER_ENV);
  if (prod) {
    if (provider !== 'solapi' && provider !== 'off') {
      if (provider === 'file' || provider === 'fake') throw new Error(`${SMS_PROVIDER_ENV}=${provider}는 local·ci·demo에서만 쓴다`);
      throw new Error(`${SMS_PROVIDER_ENV}가 없다(운영은 solapi 또는 off, Secrets Manager)`);
    }
    if (alimtalkProvider !== 'solapi' && alimtalkProvider !== 'off') {
      throw new Error(`${ALIMTALK_PROVIDER_ENV}가 없다(운영은 solapi 또는 off)`);
    }
  }
  if (provider === '') return { kind: 'unset' };
  if (provider === 'file') {
    if (!isLocal(env)) throw new Error(`${SMS_PROVIDER_ENV}=file은 local·ci·demo에서만 쓴다`);
    return { kind: 'file', dir: required(env, NOTIFY_SMS_DIR_ENV, '문자 파일 대역 폴더') };
  }
  if (provider === 'fake') {
    if (!isLocal(env)) throw new Error(`${SMS_PROVIDER_ENV}=fake는 local·ci·demo에서만 쓴다`);
    return { kind: 'fake' };
  }
  if (provider === 'off') {
    if (alimtalkProvider === 'solapi') throw new Error(`${SMS_PROVIDER_ENV}가 solapi여야 알림톡을 켤 수 있다`);
    return { kind: 'off' };
  }
  if (provider !== 'solapi') throw new Error(`${SMS_PROVIDER_ENV} 값이 올바르지 않다: ${provider}`);

  const apiKey = required(env, SOLAPI_KEY_ENV, 'Solapi API 키');
  const apiSecret = required(env, SOLAPI_SECRET_ENV, 'Solapi API 비밀');
  const senderRaw = required(env, SOLAPI_SENDER_ENV, '등록한 발신번호');
  const senderNumber = senderRaw.replace(/[^0-9]/g, '');
  if (!/^0\d{8,10}$/.test(senderNumber)) throw new Error(`${SOLAPI_SENDER_ENV}는 숫자만 남긴 국내 발신번호여야 합니다: ${senderRaw}`);
  const ratePerSec = rateOf(env, SMS_RATE_ENV);
  const webhookSecret = required(env, SMS_WEBHOOK_SECRET_ENV, 'Solapi 결과 웹훅 비밀');
  if (Buffer.from(webhookSecret, 'base64url').length < 32) throw new Error(`${SMS_WEBHOOK_SECRET_ENV}는 base64url 32바이트 이상이어야 합니다`);

  let alimtalk: SolapiAlimtalkConfig | null = null;
  if (alimtalkProvider === 'solapi') {
    const pfId = required(env, ALIMTALK_PF_ENV, '카카오 채널(PF) ID');
    const templates = parseTemplates(required(env, ALIMTALK_TEMPLATES_ENV, '알림톡 템플릿 목록'));
    alimtalk = { pfId, templates };
  } else if (alimtalkProvider !== '' && alimtalkProvider !== 'off') {
    throw new Error(`${ALIMTALK_PROVIDER_ENV} 값이 올바르지 않다: ${alimtalkProvider}`);
  }
  return { kind: 'solapi', apiKey, apiSecret, senderNumber, ratePerSec, webhookSecret, alimtalk };
}

function parseTemplates(raw: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq <= 0 || eq === piece.length - 1) throw new Error(`${ALIMTALK_TEMPLATES_ENV}는 종류=템플릿ID 꼴이어야 합니다: ${piece}`);
    const kind = piece.slice(0, eq).trim();
    const id = piece.slice(eq + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(kind) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`${ALIMTALK_TEMPLATES_ENV} 값이 올바르지 않다: ${piece}`);
    out[kind] = id;
  }
  if (Object.keys(out).length === 0) throw new Error(`${ALIMTALK_TEMPLATES_ENV}(알림톡 템플릿)가 없다`);
  return out;
}

export function mailTransportFromEnv(
  env: Record<string, string | undefined>,
  deps: { clock?: () => number } = {},
): MailTransport | null {
  const c = mailProviderConfigFromEnv(env);
  if (c.kind === 'unset') return null;
  if (c.kind === 'file') return new FileMailTransport(c.dir);
  if (c.kind === 'fake') return new FakeMailTransport();
  return new SesMailTransport({
    region: c.region,
    snsTopicArn: c.snsTopicArn,
    from: c.from,
    fromDomain: c.fromDomain,
    configurationSet: c.configurationSet,
    ratePerSec: c.ratePerSec,
    ...(c.replyTo ? { replyTo: c.replyTo } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
}

const solapiFetch = async (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => {
  const base = new URL(url);
  const client = createExternalHttpClient({ provider: 'solapi', baseUrl: base.origin, timeoutCapMs: 10_000 });
  const res = await client.request({ method: 'POST', path: base.pathname, headers: init.headers, body: init.body });
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: () => res.text() };
};

export function smsTransportFromEnv(
  env: Record<string, string | undefined>,
  deps: { clock?: () => number } = {},
): SmsTransport | null {
  const c = smsProviderConfigFromEnv(env);
  if (c.kind === 'unset' || c.kind === 'off') return null;
  if (c.kind === 'file') return new FileSmsTransport(c.dir);
  if (c.kind === 'fake') return new FakeSmsTransport();
  return new SolapiSmsTransport({
    apiKey: c.apiKey,
    apiSecret: c.apiSecret,
    senderNumber: c.senderNumber,
    ratePerSec: c.ratePerSec,
    fetch: solapiFetch,
    ...(c.alimtalk ? { alimtalk: c.alimtalk } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
}

/** 로그·기동 보고용 요약. 비밀 값은 절대 넣지 않는다 */
export function providerConfigSummary(config: MailProviderConfig | SmsProviderConfig | VapidConfig): Record<string, unknown> {
  if ('privateKey' in config) return { vapid: true, subject: config.subject };
  if (config.kind === 'ses') return { mail: 'ses', mailRegion: config.region, mailFromDomain: config.fromDomain, mailRatePerSec: config.ratePerSec };
  if (config.kind === 'solapi') return { sms: 'solapi', smsRatePerSec: config.ratePerSec, alimtalk: Boolean(config.alimtalk) };
  if (config.kind === 'off') return { sms: 'off', alimtalk: false };
  return { provider: config.kind };
}

/** 키는 base64url 32바이트 이상. local·ci는 값이 없으면 고정 시험 키를 쓴다(운영은 시작 실패) */
export function optOutKeyFromEnv(env: Record<string, string | undefined>): string {
  const raw = env[OPTOUT_KEY_ENV]?.trim();
  if (raw) {
    const b = Buffer.from(raw, 'base64url');
    if (b.length < 32) throw new Error(`${OPTOUT_KEY_ENV}는 base64url 32바이트 이상이어야 합니다`);
    return raw;
  }
  if (isProductionLikeEnv(env)) throw new Error(`${OPTOUT_KEY_ENV}가 없다(수신 거부 토큰 키, Secrets Manager)`);
  return Buffer.alloc(32, 7).toString('base64url');
}

export function topicKeyFromEnv(env: Record<string, string | undefined>, fallback: string): string {
  const raw = env[TOPIC_KEY_ENV]?.trim();
  if (!raw) return fallback;
  const b = Buffer.from(raw, 'base64url');
  if (b.length < 32) throw new Error(`${TOPIC_KEY_ENV}는 base64url 32바이트 이상이어야 합니다`);
  return raw;
}

/**
 * local·ci 고정 VAPID 시험 키(ADR-0363 결정 7). 화면의 공개 빌드 값 NEXT_PUBLIC_PEAKET_VAPID_PUBLIC_KEY와 같아야 구독이 이 서버의 키로 묶인다.
 * 개인키는 고정 글의 SHA-256에서 만든다(운영 키가 아니다. 운영은 Secrets Manager의 PEAKET_VAPID_PRIVATE_KEY·PUBLIC_KEY). 공개키 값은 apps/README.md에 적었다
 */
const LOCAL_VAPID_SEED = 'peaket-local-ci-vapid-test-key-v1';

export function localVapidKey(subject = 'mailto:notify@peaket.example'): VapidConfig {
  const d = createHash('sha256').update(LOCAL_VAPID_SEED, 'utf8').digest();
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', d: d.toString('base64url'), x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') };
  return {
    privateKey: createPrivateKey({ key: jwk, format: 'jwk' }).export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: point.toString('base64url'),
    subject,
  };
}

const vapidSubjectOk = (subject: string): boolean => {
  if (subject.startsWith('mailto:')) {
    const addr = subject.slice('mailto:'.length);
    return addr.length > 3 && addr.split('@').length === 2 && !addr.startsWith('@') && !addr.endsWith('@');
  }
  if (subject.startsWith('https://')) {
    try {
      const u = new URL(subject);
      return u.protocol === 'https:' && Boolean(u.hostname);
    } catch {
      return false;
    }
  }
  return false;
};

/** VAPID 개인키(JWK JSON 또는 PEM)와 공개키(base64url 비압축 점). 운영은 키쌍·sub가 없거나 틀리면 던진다. local·ci는 없으면 고정 시험 키 */
export function vapidFromEnv(env: Record<string, string | undefined>): VapidConfig {
  const priv = env[VAPID_PRIVATE_ENV]?.trim();
  const pub = env[VAPID_PUBLIC_ENV]?.trim();
  const subjectRaw = env[VAPID_SUBJECT_ENV]?.trim();
  const prod = isProductionLikeEnv(env);
  if (!priv || !pub) {
    if (prod) throw new Error(`${VAPID_PRIVATE_ENV}·${VAPID_PUBLIC_ENV}가 없다(운영 VAPID 키쌍, Secrets Manager)`);
    const subject = subjectRaw || 'mailto:notify@peaket.example';
    if (!vapidSubjectOk(subject)) throw new Error(`${VAPID_SUBJECT_ENV}가 올바르지 않습니다`);
    return localVapidKey(subject);
  }
  if (!subjectRaw) throw new Error(`${VAPID_SUBJECT_ENV}가 없다(키를 넣으면 VAPID sub도 필요하다)`);
  const subject = subjectRaw;
  if (!vapidSubjectOk(subject)) throw new Error(`${VAPID_SUBJECT_ENV}는 mailto: 또는 https: 주소여야 합니다`);
  // 시작할 때 키가 맞는지 본다(개인키에서 공개키를 꺼내 견준다)
  const key = priv.startsWith('{') ? createPrivateKey({ key: JSON.parse(priv) as { kty: string; crv: string; x: string; y: string; d: string }, format: 'jwk' }) : createPrivateKey(priv);
  const derived = createPublicKey(key).export({ format: 'jwk' });
  if (typeof derived.x !== 'string' || typeof derived.y !== 'string') throw new Error('VAPID 개인키 모양이 올바르지 않습니다');
  const expected = Buffer.concat([Buffer.from([4]), Buffer.from(derived.x, 'base64url'), Buffer.from(derived.y, 'base64url')]).toString('base64url');
  if (expected !== pub) throw new Error(`${VAPID_PUBLIC_ENV}가 개인키에서 나온 공개키와 다릅니다`);
  return { privateKey: priv, publicKey: pub, subject };
}

export const publicOriginFromEnv = (env: Record<string, string | undefined>): string => env[PUBLIC_ORIGIN_ENV]?.trim() || 'https://peaket.example';
