// J-T42 ① SCR-020 '정산 계좌' 실제 판의 화면 모델(F-07-7 계획 §5.1(자), ADR-0370 결정 9, d5 §6.1 ⑥).
// 정본: docs/features/settlement.md §13 J-T42 ①, docs/design/d5-screen-blueprint.md §6.1 상태 표('계좌 변경 완료'·'예금주 불일치'), settlement §3 비교 규칙 끝 문단.
// 시험이 정한 모양(계획 §5.1(자)에 함수 이름만 있어 시험 담당이 정함, 시험 리뷰가 본다):
//   payoutAccountView(raw, bankNames) → { empty, bankName, last4, masked, holderVerified, holdUntilText, agencySyncPending, version }
//     raw = GET /v1/partner/payout-account 200 본문, bankNames = 은행 코드 → 은행 이름(Record). holdUntilText는 KST 'M/D'(d5 '10/20까지'), 보류 없으면 null.
//   payoutProblemMessage(problem) → 화면에 보일 글(string). problem은 shared/api/problem.ts의 ProblemShape({ status, type, … }).
//   완료 문구 "변경했습니다. {날짜}까지 지급이 보류됩니다"(d5 §6.1 '계좌 변경 완료')는 계획에 함수가 없어 ui/wiring.test.mjs가 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payoutAccountView, payoutProblemMessage } from './payout-live.ts';

// 은행 이름은 화면이 받은 목록에서 고른다. 시험 목록의 이름은 일부러 실제 목록과 다른 글을 섞는다(코드 상수를 옮겨 오지 않았는지 본다).
const BANKS = { '06': 'KB국민은행', '88': '신한은행', '90': '카카오뱅크' };
const FULL = '98765432101234';

const raw = (over = {}) => ({
  bankCode: '88',
  payoutAccountLast4: '1234',
  holderVerified: true,
  holdUntil: null,
  agencySyncPending: false,
  version: 10,
  ...over,
});

test('J-T42 ①_[ASVS v5.0.0-14.2.6] 은행 코드는 은행 이름으로, 계좌는 끝 4자리만 보인다', () => {
  const v = payoutAccountView(raw(), BANKS);
  assert.deepEqual(v, {
    empty: false,
    bankName: '신한은행',
    last4: '1234',
    masked: '****1234',
    holderVerified: true,
    holdUntilText: null,
    agencySyncPending: false,
    version: 10,
  });
  // 끝 4자리 말고 다른 숫자 칸이 없다
  assert.equal(JSON.stringify(v).includes(FULL), false);
  assert.equal(/\d{5,}/.test(JSON.stringify({ ...v, version: 0 })), false);
});

test('J-T42 ① 목록에 없는 은행 코드는 코드를 지어낸 이름으로 바꾸지 않는다', () => {
  const v = payoutAccountView(raw({ bankCode: '999' }), BANKS);
  assert.notEqual(v.bankName, '신한은행');
  assert.notEqual(v.bankName, 'KB국민은행');
  assert.equal(v.last4, '1234');
});

test('J-T42 ① 계좌가 아직 없으면(null 칸·version 0) 빈 판이고 판 0을 그대로 둔다', () => {
  const v = payoutAccountView({ bankCode: null, payoutAccountLast4: null, holderVerified: false, holdUntil: null, agencySyncPending: false, version: 0 }, BANKS);
  assert.deepEqual(v, { empty: true, bankName: null, last4: null, masked: null, holderVerified: false, holdUntilText: null, agencySyncPending: false, version: 0 });
});

test('J-T42 ① 보류 끝은 KST 날짜다(UTC 전날 15:00 = KST 그날 00:00, 경계 양쪽)', () => {
  // 2026-11-25 10:00 KST(정본 J-T40 ③ 금요일 10:00 → 다음 주 수요일 10:00)
  assert.equal(payoutAccountView(raw({ holdUntil: '2026-11-25T01:00:00.000Z' }), BANKS).holdUntilText, '11/25');
  // UTC로는 11/24지만 KST로는 11/25 00:00
  assert.equal(payoutAccountView(raw({ holdUntil: '2026-11-24T15:00:00.000Z' }), BANKS).holdUntilText, '11/25');
  // 1ms 전은 KST 11/24 23:59:59.999
  assert.equal(payoutAccountView(raw({ holdUntil: '2026-11-24T14:59:59.999Z' }), BANKS).holdUntilText, '11/24');
});

test('J-T42 ① 결제사 수정 대기(agencySyncPending)를 그대로 싣는다', () => {
  assert.equal(payoutAccountView(raw({ agencySyncPending: true }), BANKS).agencySyncPending, true);
  assert.equal(payoutAccountView(raw({ agencySyncPending: false }), BANKS).agencySyncPending, false);
});

test('J-T42 ① 판 번호 두 자리(9 → 10)를 숫자로 둔다', () => {
  assert.equal(payoutAccountView(raw({ version: 9 }), BANKS).version, 9);
  assert.strictEqual(payoutAccountView(raw({ version: 10 }), BANKS).version, 10);
});

test('J-T42 ① 422 예금주 불일치는 정본 문구와 판매자 정보 확인 요청 안내를 함께 보인다', () => {
  const m = payoutProblemMessage({ status: 422, type: 'payout-account-holder-mismatch', title: '예금주가 판매자 상호나 대표자와 다릅니다' });
  assert.equal(typeof m, 'string');
  assert.ok(m.includes('예금주가 판매자 상호나 대표자와 같은 계좌만 받습니다'), m);
  assert.ok(m.includes('판매자 정보 확인'), m);
});

test('J-T42 ① 412는 다시 읽기, 403 reauth-required는 재인증부터 다시, 502는 결제사 수정 대기 안내다', () => {
  const stale = payoutProblemMessage({ status: 412, type: 'precondition-failed', title: '다른 사람이 먼저 고쳤습니다' });
  const reauth = payoutProblemMessage({ status: 403, type: 'reauth-required', title: '다시 인증해 주세요' });
  const agency = payoutProblemMessage({ status: 502, type: 'payout-agency-update-failed', title: '결제사에 정산 계좌를 반영하지 못했습니다', failedAgencies: ['TOSS_STANDARD'] });
  assert.ok(/다시 (읽|불러)/.test(stale), stale);
  assert.ok(/다시 인증/.test(reauth), reauth);
  assert.ok(agency.includes('결제사') && /수정 대기|반영/.test(agency), agency);
  // 서로 다른 안내다(한 문구로 뭉치지 않는다)
  assert.equal(new Set([stale, reauth, agency]).size, 3);
  // 422 문구가 다른 상태로 새지 않는다
  for (const m of [stale, reauth, agency]) assert.equal(m.includes('예금주가 판매자 상호나 대표자와 같은 계좌만 받습니다'), false);
});

test('J-T42 ① 오류 문구에 계좌번호가 섞이지 않는다(문제 본문에 들어 와도)', () => {
  const m = payoutProblemMessage({ status: 422, type: 'payout-account-holder-mismatch', title: '예금주가 판매자 상호나 대표자와 다릅니다', detail: FULL });
  assert.equal(m.includes(FULL), false);
});
