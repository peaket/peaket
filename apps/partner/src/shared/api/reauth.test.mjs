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

// ---- F-07-7 J-T42 ① 정산 계좌 변경 재인증(계획 §5.1(자): requestReauth(act, input), 패스키 등록 변환은 만들지 않음·내 계정 동결) ----
test('J-T42 ① requestReauth는 PAYOUT_ACCOUNT·BOOKER_EXPORT 작업 묶음만 받고 받은 act를 그대로 보낸다', () => {
  assert.match(src, /export async function requestReauth\(\s*act: 'PAYOUT_ACCOUNT' \| 'BOOKER_EXPORT'|export async function requestReauth\(\s*act: 'BOOKER_EXPORT' \| 'PAYOUT_ACCOUNT'/);
  const at = src.indexOf('export async function requestReauth(');
  const body = src.slice(at, src.indexOf('\nexport ', at + 1));
  assert.match(body, /post\(\{ act,|act: act/);
  assert.match(body, /withPasskey: true/);
  assert.match(body, /navigator\.credentials\.get/);
  assert.match(body, /hasPasskeyFactor/);
});

test('J-T42 ① 명단 내려받기 재인증은 같은 함수를 BOOKER_EXPORT로 부른다', () => {
  const at = src.indexOf('export async function requestBookerExportReauth(');
  assert.ok(at >= 0);
  assert.match(src.slice(at, at + 400), /requestReauth\('BOOKER_EXPORT', input\)/);
});

test('J-T42 ① 패스키 등록 변환(내 계정 줄, 동결)은 만들지 않는다', () => {
  assert.doesNotMatch(src, /toCreationOptions|serializeAttestation|navigator\.credentials\.create/);
});

// ---- F-07-13 SCR-020 내 계정 보안 재인증(계획 §4 'requestAccountSecurityReauth', §6 시험 23) ----
test('I-T53 ③ [ASVS v5.0.0-7.5.1] ACCOUNT_SECURITY 재인증은 패스키가 없으면 비밀번호·TOTP로, 있으면 패스키 단계까지 거친다', () => {
  const at = src.indexOf('export async function requestAccountSecurityReauth(');
  assert.ok(at >= 0, 'requestAccountSecurityReauth가 reauth.ts에 없다');
  const next = src.indexOf('\nexport ', at + 1);
  const body = src.slice(at, next < 0 ? undefined : next);
  assert.match(body, /act: 'ACCOUNT_SECURITY'/);
  assert.match(body, /withPasskey/);
  // 패스키 단계는 withPasskey가 참일 때만 연다
  const gate = body.indexOf('withPasskey');
  const nav = body.indexOf('navigator.credentials.get');
  assert.ok(gate >= 0 && nav > gate, 'withPasskey 분기 뒤에 패스키 창이 있어야 한다');
  assert.match(body, /hasPasskeyFactor/);
  assert.match(body, /reauthStep: first\.reauthStep/);
  assert.doesNotMatch(body, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(body, /console\./);
});
