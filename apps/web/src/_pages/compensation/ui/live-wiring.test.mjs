// SCR-043 실제 배선(F-07-15 I-04·I-07). 생성 호출·재인증·멱등 키·계좌 비저장·문구를 소스로 본다.
// 기준 트리에는 실제 화면·로더 파일이 없어 readFileSync부터 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const page = read('./CompensationPage.tsx');
const live = read('./CompensationLive.tsx');
const loader = read('./CompensationLiveLoader.tsx');
const copy = read('../model/copy.mjs');
const tickets = read('../../../../../../packages/api-client/src/gen/endpoints/tickets/tickets.ts');
const count = (src, re) => (src.match(re) ?? []).length;

test('SCR043_실제_경로는_배상_조회와_계좌_입력을_생성_호출로_부른다', () => {
  for (const name of ['getCompensation', 'createCompensationAccount', 'getIdentityProviders']) {
    assert.match(live, new RegExp(`\\b${name}\\b|OPERATIONS\\.${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(live, /client\.send\(OPERATIONS\.createCompensationAccount/);
  assert.match(live, /headers: \{ 'X-Reauth-Token': reauthToken \}/);
  assert.match(live, /idempotencyKey: /);
  assert.match(live, /withFanRefresh\(/);
  assert.match(tickets, /export const createCompensationAccount/);
  assert.match(tickets, /method: 'POST'/);
});

test('SCR043_재인증은_compensation-account로_왕복하고_돌아온_뒤_계좌를_다시_받는다', () => {
  assert.match(live, /submitReauthForm\(provider, .*'compensation-account'\)/);
  assert.match(live, /pickupReauthToken\(\)/);
  assert.match(live, /awaitingConfirm/);
  assert.match(live, /계좌를 다시 입력/);
});

test('SCR043_계좌는_상태_저장소_주소_로그에_남기지_않는다', () => {
  assert.doesNotMatch(live, /(?:localStorage|sessionStorage)\.setItem\([^)]*(?:account|bank|holder)/i);
  assert.doesNotMatch(live, /\bconsole\.(?:log|info|warn|error)\s*\(/);
  assert.doesNotMatch(live, /location\.(?:search|hash)[^\n]*(?:account|bank)/i);
  assert.doesNotMatch(live, /SAMPLE_BANK_INPUT/);
});

test('SCR043_403_문구는_d5_넓힌_문구와_아직_보내지_않음이다', () => {
  assert.match(copy, /다시 로그인한 확인이 만료되었거나 이미 쓰였습니다\. 다시 로그인해 주세요/);
  assert.match(copy, /송금 요청은 아직 보내지 않았습니다\. 다시 로그인하면 이어서 보낼 수 있습니다/);
  assert.match(live, /COMPENSATION_REAUTH_EXPIRED/);
  assert.match(live, /COMPENSATION_REAUTH_NOT_SENT/);
});

test('SCR043_목업은_state로_남고_UUID만_실제_화면이다', () => {
  assert.match(page, /COMPENSATION_ID/);
  assert.match(page, /getCompensation\(compensationId\)/);
  assert.match(page, /<CompensationLiveLoader compensationId=\{compensationId\} \/>/);
  assert.match(page, /resolvePreviewState\(sp, SCR043_STATES/);
  assert.match(loader, /dynamic\(\(\) => import\('\.\/CompensationLive'\)/);
  assert.match(loader, /ssr: false/);
});

test('SCR043_계좌_오류와_이미_지급_409를_화면이_가른다', () => {
  assert.match(live, /compensation-not-account-pending/);
  assert.match(live, /이미 지급된 배상금입니다/);
  assert.match(live, /compensation-transfer-failed/);
  assert.match(live, /3회|고객센터/);
  assert.equal(count(live, /OPERATIONS\.createCompensationAccount/g), 1);
});
