// 관제 admin 재인증 부품의 시험(BAT-421, docs/review/plans/BAT-421.md §4·§6).
// 정본: docs/security/authz-matrix.md §6, openapi POST /v1/ops/auth/reauthentications,
// docs/design/d5-screen-blueprint.md §7.8 ④.
// 두 단계(비밀번호·TOTP → 패스키)·act APPROVAL·withPasskey·factors 확인·403/409/503 문구를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  base64urlToBytes,
  bytesToBase64url,
  hasPasskeyFactor,
  reauthErrorMessage,
  toRequestOptions,
} from './api.ts';

const src = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const ops = readFileSync(new URL('../../../../../packages/api-client/src/gen/endpoints/ops/ops.ts', import.meta.url), 'utf8');

test('OPS_재인증은_비밀번호·TOTP_뒤_패스키까지_확인한다', () => {
  // 승인 토큰은 act APPROVAL, 패스키 단계 필수다
  assert.match(src, /act: 'APPROVAL'/);
  assert.match(src, /withPasskey: true/);
  assert.match(src, /next: 'PASSKEY'/);
  assert.match(src, /if \(first\.next === 'DONE'\)/);
  assert.match(src, /navigator\.credentials\?\.get/);
  assert.match(src, /navigator\.credentials\.get\(\{ publicKey: toRequestOptions\(first\.publicKey\) \}\)/);
  assert.match(src, /reauthStep: first\.reauthStep/);
  assert.match(src, /credential: serializeAssertion\(credential\)/);
  // 서버가 200으로 줘도 factors에 passkey가 없으면 토큰을 쓰지 않는다(1·2단계 모두)
  assert.match(src, /if \(!hasPasskeyFactor\(first\.factors\)\) throw new Error\('패스키 확인 없이 발급된 재인증 토큰은 쓸 수 없습니다'\)/);
  assert.match(src, /if \(second\.next !== 'DONE' \|\| !hasPasskeyFactor\(second\.factors\)\) throw new Error\('패스키 확인 없이 발급된 재인증 토큰은 쓸 수 없습니다'\)/);
  assert.equal(hasPasskeyFactor(['password', 'totp', 'passkey']), true);
  assert.equal(hasPasskeyFactor(['password', 'totp']), false);
  assert.equal(hasPasskeyFactor([]), false);
  // 생성 호출은 POST다
  const at = ops.indexOf('export const createOpsAuthReauthentication = async');
  assert.ok(at >= 0);
  assert.match(ops.slice(at, at + 2_000), /\bmethod: 'POST'/);
});

test('OPS_패스키_값은_base64url로_왕복한다', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const text = bytesToBase64url(bytes);
  assert.equal(text.includes('='), false);
  assert.deepEqual([...base64urlToBytes(text)], [...bytes]);
  assert.throws(() => base64urlToBytes('a+b/'), /base64url/);
  const opts = toRequestOptions({
    challenge: bytesToBase64url(Uint8Array.from([1, 2, 3, 4])),
    rpId: 'console.peaket.example',
    timeout: 300_000,
    allowCredentials: [{ id: bytesToBase64url(Uint8Array.from([9, 8, 7])), type: 'public-key', transports: ['internal'] }],
  });
  assert.equal(opts.rpId, 'console.peaket.example');
  assert.equal(opts.userVerification, 'required');
  assert.equal(new Uint8Array(opts.allowCredentials[0].id).join(','), '9,8,7');
  assert.throws(() => toRequestOptions({ rpId: 'console.peaket.example' }), /challenge/);
});

test('OPS_재인증_오류는_403·409·503을_정본_문구로_가른다', () => {
  assert.equal(
    reauthErrorMessage({ status: 409, type: 'passkey-not-registered' }),
    '이 계정에는 등록한 패스키가 없습니다. 내 계정에서 패스키를 등록한 뒤 다시 시도해 주세요',
  );
  assert.equal(reauthErrorMessage({ status: 503, type: 'reauth-unavailable' }), '지금은 다시 로그인한 확인을 하지 못했습니다. 잠시 뒤 다시 로그인해 주세요');
  assert.equal(reauthErrorMessage({ status: 410 }), '패스키 확인 시간이 지났습니다. 처음부터 다시 해 주세요');
  assert.equal(reauthErrorMessage({ status: 403, type: 'password-change-required' }), '비밀번호를 바꾼 뒤 다시 시도해 주세요');
  assert.equal(reauthErrorMessage({ status: 423 }), '계정이 잠겨 있습니다. 운영자에게 잠금 해제를 요청해 주세요');
  assert.equal(reauthErrorMessage({ status: 422 }), '비밀번호나 인증 앱 코드가 맞지 않습니다. 다시 확인해 주세요');
  assert.equal(reauthErrorMessage({ status: 401 }), '로그인이 만료되었습니다. 다시 로그인해 주세요');
  assert.equal(reauthErrorMessage(new DOMException('cancel', 'NotAllowedError')), '패스키 확인을 마치지 못했습니다. 다시 시도해 주세요');
  assert.equal(reauthErrorMessage({ message: '이 브라우저에서는 패스키를 쓸 수 없습니다' }), '이 브라우저에서는 패스키를 쓸 수 없습니다');
  assert.equal(reauthErrorMessage({ status: 500, title: '<b>서버</b>', detail: '내부' }), '다시 인증하지 못했습니다. 잠시 뒤 다시 시도해 주세요');
  // 서버 type이 주소 전체여도 끝 이름으로 가른다
  assert.match(reauthErrorMessage({ status: 409, type: 'https://problems.peaket.example/passkey-not-registered' }), /패스키/);
});

test('OPS_토큰과_비밀번호는_저장소·주소·로그에_남기지_않는다', () => {
  assert.doesNotMatch(src, /localStorage|sessionStorage|document\.cookie|indexedDB/i);
  assert.doesNotMatch(src, /\bconsole\.(?:log|info|warn|error)\s*\(/);
  assert.doesNotMatch(src, /location\.(?:search|hash)/);
  assert.doesNotMatch(src, /history\.(?:pushState|replaceState)/);
  // 토큰은 부르는 쪽에 돌려주기만 한다(저장하지 않는다)
  assert.match(src, /return first\.reauthToken;/);
  assert.match(src, /return second\.reauthToken;/);
});
