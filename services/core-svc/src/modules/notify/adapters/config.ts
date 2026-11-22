// BAT-455 알림 발송의 환경 값: 수신 거부 토큰 키·VAPID 키·공개 출처.
// 운영은 Secrets Manager가 환경으로 넣는다(docs/security/secrets-and-keys.md '수신 거부 토큰 키').
import { createECDH, createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import type { VapidConfig } from '../domain/fan-notify-ports.js';

export const OPTOUT_KEY_ENV = 'PEAKET_NOTIFY_OPTOUT_KEY';
export const TOPIC_KEY_ENV = 'PEAKET_NOTIFY_TOPIC_KEY';
export const VAPID_PRIVATE_ENV = 'PEAKET_VAPID_PRIVATE_KEY';
export const VAPID_PUBLIC_ENV = 'PEAKET_VAPID_PUBLIC_KEY';
export const VAPID_SUBJECT_ENV = 'PEAKET_VAPID_SUBJECT';
export const PUBLIC_ORIGIN_ENV = 'PEAKET_PUBLIC_ORIGIN';

const LOCAL_ENVS = new Set(['local', 'ci', 'test', 'demo']);
const isLocal = (env: Record<string, string | undefined>): boolean => LOCAL_ENVS.has(env.PEAKET_ENV ?? 'local');

/** 키는 base64url 32바이트 이상. local·ci는 값이 없으면 고정 시험 키를 쓴다(운영은 시작 실패) */
export function optOutKeyFromEnv(env: Record<string, string | undefined>): string {
  const raw = env[OPTOUT_KEY_ENV]?.trim();
  if (raw) {
    const b = Buffer.from(raw, 'base64url');
    if (b.length < 32) throw new Error(`${OPTOUT_KEY_ENV}는 base64url 32바이트 이상이어야 합니다`);
    return raw;
  }
  if (!isLocal(env)) throw new Error(`${OPTOUT_KEY_ENV}가 없다(수신 거부 토큰 키, Secrets Manager)`);
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

/** VAPID 개인키(JWK JSON 또는 PEM)와 공개키(base64url 비압축 점). local·ci는 없으면 고정 시험 키(localVapidKey)를 쓴다 */
export function vapidFromEnv(env: Record<string, string | undefined>): VapidConfig | undefined {
  const priv = env[VAPID_PRIVATE_ENV]?.trim();
  const pub = env[VAPID_PUBLIC_ENV]?.trim();
  if (!priv || !pub) {
    if (!isLocal(env)) return undefined;
    return localVapidKey(env[VAPID_SUBJECT_ENV]?.trim() || 'mailto:notify@peaket.example');
  }
  // 시작할 때 키가 맞는지 본다(개인키에서 공개키를 꺼내 견준다)
  const key = priv.startsWith('{') ? createPrivateKey({ key: JSON.parse(priv) as { kty: string; crv: string; x: string; y: string; d: string }, format: 'jwk' }) : createPrivateKey(priv);
  const derived = createPublicKey(key).export({ format: 'jwk' });
  if (typeof derived.x !== 'string' || typeof derived.y !== 'string') throw new Error('VAPID 개인키 모양이 올바르지 않습니다');
  const expected = Buffer.concat([Buffer.from([4]), Buffer.from(derived.x, 'base64url'), Buffer.from(derived.y, 'base64url')]).toString('base64url');
  if (expected !== pub) throw new Error(`${VAPID_PUBLIC_ENV}가 개인키에서 나온 공개키와 다릅니다`);
  return { privateKey: priv, publicKey: pub, subject: env[VAPID_SUBJECT_ENV]?.trim() || 'mailto:notify@peaket.example' };
}

export const publicOriginFromEnv = (env: Record<string, string | undefined>): string => env[PUBLIC_ORIGIN_ENV]?.trim() || 'https://peaket.example';
