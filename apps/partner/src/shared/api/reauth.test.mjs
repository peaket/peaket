// I-T53 재인증 패스키 단계의 base64url 변환과 요청 옵션(identity §6, ADR-0206).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { base64urlToBytes, bytesToBase64url, hasPasskeyFactor, toRequestOptions } from './reauth.ts';

const src = readFileSync(new URL('./reauth.ts', import.meta.url), 'utf8');

test('I-T53 base64url은 채움 없이 바이트와 왕복한다', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const text = bytesToBase64url(bytes);
  assert.equal(text.includes('='), false);
  assert.deepEqual([...base64urlToBytes(text)], [...bytes]);
});

test('I-T53 base64url이 아니면 거절한다', () => {
  assert.throws(() => base64urlToBytes('a+b/'), /base64url/);
});

test('I-T53 서버 challenge·allowCredentials를 ArrayBuffer로 바꾼다', () => {
  const opts = toRequestOptions({
    challenge: bytesToBase64url(Uint8Array.from([1, 2, 3, 4])),
    rpId: 'partner.peaket.example',
    timeout: 300_000,
    userVerification: 'required',
    allowCredentials: [{ id: bytesToBase64url(Uint8Array.from([9, 8, 7])), type: 'public-key', transports: ['internal'] }],
  });
  assert.equal(opts.rpId, 'partner.peaket.example');
  assert.equal(opts.userVerification, 'required');
  assert.equal(opts.allowCredentials?.length, 1);
  assert.equal(new Uint8Array(opts.allowCredentials[0].id).join(','), '9,8,7');
});

test('I-T53 challenge가 없으면 옵션을 만들지 않는다', () => {
  assert.throws(() => toRequestOptions({ rpId: 'partner.peaket.example' }), /challenge/);
});

test('I-T53 재인증 토큰 factors에 passkey가 있어야 한다', () => {
  assert.equal(hasPasskeyFactor(['password', 'totp', 'passkey']), true);
  assert.equal(hasPasskeyFactor(['password', 'totp']), false);
});

test('I-T53 BOOKER_EXPORT 재인증은 withPasskey와 패스키 단계를 거친다', () => {
  assert.match(src, /act: 'BOOKER_EXPORT'/);
  assert.match(src, /withPasskey: true/);
  assert.match(src, /navigator\.credentials\.get/);
  assert.match(src, /reauthStep: first\.reauthStep/);
});
