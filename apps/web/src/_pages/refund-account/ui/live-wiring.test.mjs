// SCR-060 실제 배선(F-07-15 I-05·I-07). 취소 상세 조회·계좌 입력·재인증·멱등 키·비저장을 본다.
// 기준 트리에는 실제 화면·로더 파일이 없어 각 시험이 실행 중 readFileSync에서 실패한다(파일째 실패 아님).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('SCR060_실제_경로는_취소_상세와_계좌_입력을_생성_호출로_부른다', () => {
  const live = read('./RefundAccountLive.tsx');
  const tickets = read('../../../../../../packages/api-client/src/gen/endpoints/tickets/tickets.ts');
  for (const name of ['getCancellation', 'createCancellationAccount', 'getIdentityProviders', 'getEvent']) {
    assert.match(live, new RegExp(`\\b${name}\\b|OPERATIONS\\.${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(live, /client\.send\(OPERATIONS\.createCancellationAccount/);
  assert.match(live, /headers: \{ 'X-Reauth-Token': reauthToken \}/);
  assert.match(live, /idempotencyKey: /);
  assert.match(tickets, /export const createCancellationAccount/);
  assert.match(tickets, /export const getCancellation/);
});

test('SCR060_재인증은_refund-account로_왕복하고_돌아온_뒤_계좌를_다시_받는다', () => {
  const live = read('./RefundAccountLive.tsx');
  assert.match(live, /submitReauthForm\(provider, .*'refund-account'\)/);
  assert.match(live, /pickupReauthToken\(\)/);
  assert.match(live, /awaitingConfirm/);
  assert.match(live, /계좌를 다시 입력/);
});

test('SCR060_계좌는_상태_저장소_주소_로그에_남기지_않는다', () => {
  const live = read('./RefundAccountLive.tsx');
  assert.doesNotMatch(live, /(?:localStorage|sessionStorage)\.setItem\([^)]*(?:account|bank|holder)/i);
  assert.doesNotMatch(live, /\bconsole\.(?:log|info|warn|error)\s*\(/);
  assert.doesNotMatch(live, /location\.(?:search|hash)[^\n]*(?:account|bank)/i);
  assert.doesNotMatch(live, /SAMPLE_BANK_INPUT/);
});

test('SCR060_403_문구는_d5_넓힌_문구와_아직_보내지_않음이다', () => {
  const live = read('./RefundAccountLive.tsx');
  const copy = read('../model/copy.ts');
  assert.match(copy, /다시 로그인한 확인이 만료되었거나 이미 쓰였습니다\. 다시 로그인해 주세요/);
  assert.match(copy, /환급 요청은 아직 보내지 않았습니다\. 다시 로그인하면 이어서 보낼 수 있습니다\./);
  assert.match(live, /REFUND_REAUTH_EXPIRED/);
  assert.match(live, /REFUND_REAUTH_NOT_SENT/);
});

test('SCR060_목업은_state로_남고_UUID만_실제_화면이다', () => {
  const page = read('./RefundAccountPage.tsx');
  const loader = read('./RefundAccountLiveLoader.tsx');
  assert.match(page, /CANCELLATION_ID/);
  assert.match(page, /getDelayedRefund\(refundId\)/);
  assert.match(page, /<RefundAccountLiveLoader refundId=\{refundId\} \/>/);
  assert.match(page, /resolvePreviewState\(sp, SCR060_STATES/);
  assert.match(loader, /dynamic\(\(\) => import\('\.\/RefundAccountLive'\)/);
  assert.match(loader, /ssr: false/);
});

test('SCR060_409와_422를_화면이_가른다', () => {
  const live = read('./RefundAccountLive.tsx');
  assert.match(live, /cancellation-not-account-pending/);
  assert.match(live, /refund-account-required/);
  assert.match(live, /refund-rejected/);
  assert.match(live, /3영업일/);
});
