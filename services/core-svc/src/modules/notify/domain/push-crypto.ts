// BAT-455 웹 푸시 암호화(RFC 8291 aes128gcm)와 VAPID JWT(RFC 8292 ES256). 순수 함수라 시험이 구독 개인키로 풀어 본다.
// 정본: docs/features/notify.md §4.4. VAPID 개인키는 운영에서 Secrets Manager가 환경으로 넣는다.
import { createCipheriv, createECDH, createHmac, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';
import type { VapidConfig } from './fan-notify-ports.js';

const b64url = (b: Buffer): string => b.toString('base64url');

/** 본문: salt(16) ‖ rs(4) ‖ idlen(1) ‖ as_public(65) ‖ aes128gcm 암호문 */
export function encryptWebPush(plaintext: string, p256dh: string, auth: string): Buffer {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, authInfo, 32));
  const salt = randomBytes(16);
  const prk = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.alloc(0), 32));
  const cek = Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0), Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0), Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));
  const plain = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

function privateKeyOf(raw: string) {
  if (raw.trim().startsWith('{')) return createPrivateKey({ key: JSON.parse(raw) as { kty: string; crv: string; x: string; y: string; d: string }, format: 'jwk' });
  return createPrivateKey(raw);
}

/** `vapid t=<JWT>, k=<공개키>`. exp는 12시간 [가정], aud는 구독 주소의 출처 */
export function vapidAuthorization(vapid: VapidConfig, audience: string, nowMs: number): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 60 * 60, sub: vapid.subject })));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`, 'utf8'), { key: privateKeyOf(vapid.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64url(signature)}, k=${vapid.publicKey}`;
}

/** 같은 대상의 알림을 화면에서 바꾸는 Topic·tag. 대상 ID 원문을 싣지 않는다(ADR-0139 결정 6) */
export function pushTopic(key: string, kind: string, targetId: string): string {
  return createHmac('sha256', Buffer.from(key, 'base64url')).update(`${kind}\u0000${targetId}`, 'utf8').digest().subarray(0, 16).toString('hex');
}

/** TTL·Urgency(notify §4.4). 신청 알림은 30분 [가정], 거래·안전은 24시간 [가정] */
export function pushTtlUrgency(kind: string): { ttl: string; urgency: 'high' | 'normal' | 'very-low' } {
  if (kind === 'OPEN_LOBBY' || kind === 'CANCELLATION_ALERT') return { ttl: '600', urgency: 'high' };
  if (kind === 'OPEN_VERIFY') return { ttl: '900', urgency: 'normal' };
  if (kind === 'AD') return { ttl: '86400', urgency: 'very-low' };
  return { ttl: '86400', urgency: 'normal' };
}
