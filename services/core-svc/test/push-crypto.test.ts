// BAT-455 N-T21 ③: RFC 8291 본문 암호화와 RFC 8292 VAPID JWT를 구독 개인키로 풀어 확인한다.
import { createDecipheriv, hkdfSync, verify } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { encryptWebPush, vapidAuthorization } from '../src/modules/notify/index.js';
import { b64url, pushKeyPair, vapidKeys } from './fan-notify-support.js';

function decrypt(body: Buffer, ua: ReturnType<typeof pushKeyPair>): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = ua.privateKey.computeSecret(asPublic);
  const uaPublic = Buffer.from(ua.p256dh, 'base64url');
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, Buffer.from(ua.auth, 'base64url'), authInfo, 32));
  const prk = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.alloc(0), 32));
  const cek = Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0), Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0), Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

describe('N-T21 ③ 웹 푸시 암호화·VAPID', () => {
  test('N-T21 ③ aes128gcm 본문을 구독 개인키로 풀면 평문이 나온다', () => {
    const ua = pushKeyPair();
    const text = JSON.stringify({ v: 1, title: '대기실이 열렸습니다', body: '20:00 전까지 들어오세요', url: '/events/1' });
    const body = encryptWebPush(text, ua.p256dh, ua.auth);
    expect(body.length).toBeGreaterThan(text.length + 21 + 16);
    expect(body.readUInt8(20)).toBe(65);
    expect(decrypt(body, ua)).toBe(text);
  });

  test('N-T21 ③ VAPID JWT는 ES256이고 aud·exp·sub가 맞다 [ASVS v5.0.0-13.2.1]', () => {
    const v = vapidKeys();
    const now = Date.parse('2026-11-05T00:00:00.000Z');
    const header = vapidAuthorization(v, 'https://fcm.googleapis.com', now);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(m).toBeTruthy();
    expect(m[2]).toBe(v.publicKey);
    const [h, p, s] = m[1]!.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toMatchObject({ alg: 'ES256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: v.subject, exp: Math.floor(now / 1000) + 12 * 60 * 60 });
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: v.privateKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'));
    expect(ok).toBe(true);
    expect(b64url(Buffer.from(s!, 'base64url'))).toBe(s);
  });
});
