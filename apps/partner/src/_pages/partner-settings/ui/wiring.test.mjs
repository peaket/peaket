// J-T42 ①③ SCR-020 '정산 계좌' 실제 판의 배선 시험(F-07-7 계획 §5.1(자)·I-09, ADR-0370 결정 9, d5 §6.1 ⑥).
// 정본: docs/features/settlement.md §13 J-T42 ①③, docs/design/d5-screen-blueprint.md §6.1 상태 표, docs/frontend.md §4.1(실행부 늦게 가져오기).
// 실제 판 파일 자리는 계획 I-09의 'ui/live/PayoutLive.tsx 같은 자리'라 ui/live/ 아래 이름에 Payout이 든 파일을 모두 읽는다(하나도 없으면 실패).
// 내 계정·SCR-048은 동결(감독 결정 2026-11-23)이라 보지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const liveDir = new URL('./live/', import.meta.url);
const liveFiles = existsSync(liveDir) ? readdirSync(liveDir).filter((f) => /Payout/.test(f) && /\.tsx?$/.test(f)) : [];
const live = liveFiles.map((f) => readFileSync(new URL(f, liveDir), 'utf8')).join('\n');
const page = read('./PayoutPage.tsx');

test('J-T42 ① 실제 판 파일이 있고 ?state= 없는 정산 계좌 화면이 그 판을 그린다', () => {
  assert.ok(liveFiles.length > 0, 'partner-settings/ui/live/ 아래 정산 계좌 실제 판(Payout*.tsx)이 없다');
  // 페이지가 실제 판을 가져와 그린다(보드는 ?state= 미리보기에만)
  assert.match(page, /from '\.\/live\/Payout[A-Za-z]*'/);
  assert.match(page, /readParam\([^)]*'state'\)|pv\.(?:hasState|preview|isPreview)|state === undefined|!state/);
});

test('J-T42 ① 실제 판은 공용 partner-live의 지금 계좌 읽기·바꾸기만 부르고 fetch를 직접 만들지 않는다', () => {
  assert.ok(liveFiles.length > 0, '실제 판 파일이 없어 이 검사가 빈 글을 본다');
  for (const name of ['getPayoutAccount', 'putPayoutAccount']) assert.match(live, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
  assert.doesNotMatch(live, /\bfetch\s*\(/);
});

test('J-T42 ①_[ASVS v5.0.0-3.3.4] 화면은 GET 응답의 ETag(판)를 If-Match로 넘기고 재인증 토큰을 쿠키·저장소에 두지 않는다', () => {
  assert.ok(liveFiles.length > 0, '실제 판 파일이 없어 이 검사가 빈 글을 본다');
  assert.match(live, /etag|ETag|version/);
  assert.match(live, /ifMatch/);
  assert.match(live, /reauthToken/);
  assert.doesNotMatch(live, /document\.cookie/);
});

test('J-T42 ① 실제 판의 재인증은 PAYOUT_ACCOUNT 작업 묶음으로 부른다', () => {
  assert.ok(liveFiles.length > 0, '실제 판 파일이 없어 이 검사가 빈 글을 본다');
  assert.match(live, /requestReauth\('PAYOUT_ACCOUNT'/);
});

test('J-T42 ① 입력한 계좌번호는 컴포넌트 상태에만 두고 저장소·주소·로그에 남기지 않으며 PUT 뒤·닫을 때 지운다', () => {
  assert.ok(liveFiles.length > 0, '실제 판 파일이 없어 이 검사가 빈 글을 본다');
  assert.doesNotMatch(live, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(live, /history\.(?:push|replace)State|router\.(?:push|replace)\([^)]*account/i);
  assert.doesNotMatch(live, /searchParams\.set\([^)]*account/i);
  assert.doesNotMatch(live, /console\.(?:log|info|warn|error|debug)/);
  // 계좌번호 상태를 빈 값으로 되돌리는 곳이 있다(성공·닫기)
  assert.match(live, /set[A-Z][A-Za-z]*(?:Account|Number)[A-Za-z]*\(''\)/);
});

test('J-T42 ① 오류는 화면 모델의 문구를 쓰고 완료는 "변경했습니다. {날짜}까지 지급이 보류됩니다"다', () => {
  assert.ok(liveFiles.length > 0, '실제 판 파일이 없어 이 검사가 빈 글을 본다');
  assert.match(live, /payoutProblemMessage\(/);
  assert.match(live, /payoutAccountView\(/);
  assert.match(live, /변경했습니다\. \{[^}]+\}까지 지급이 보류됩니다/);
  // 403 reauth-required면 재인증 대화상자부터 다시 연다
  assert.match(live, /reauth-required/);
});

test('J-T42 ① 실무자에게는 [계좌 바꾸기]가 비활성과 이유 글이다', () => {
  assert.ok(liveFiles.length > 0, '실제 판 파일이 없어 이 검사가 빈 글을 본다');
  assert.match(live, /계좌 바꾸기/);
  assert.match(live, /aria-disabled/);
  assert.match(live, /이 작업은 파트너 관리자만 할 수 있습니다/);
  assert.match(live, /partner_member|isMember/);
});

test('J-T42 ③_[ASVS v5.0.0-14.2.6] 실제 판에는 목업 값이 0건이고 계좌는 은행·끝 4자리만 보인다', () => {
  assert.ok(liveFiles.length > 0, '실제 판 파일이 없어 이 검사가 빈 글을 본다');
  // 목업 원천(entities/partner-org stellaOrg.payout, model/settings의 그림 예 날짜, 보드 state 목록)을 가져오지 않는다
  assert.doesNotMatch(live, /stellaOrg|payoutHoldUntil|PAYOUT_STATES|scr020-settings/);
  // 목업 글(그림 예의 은행·예금주·날짜·자리 표시)이 없다
  for (const mock of ['○○은행', '(주)스텔라엔터테인먼트', "'10/20'", '[은행 목록]', '[계좌번호 자리 표시]', '[예금주 자리 표시]']) {
    assert.equal(live.includes(mock), false, `실제 판에 목업 값 ${mock}이 있다`);
  }
  // 응답의 끝 4자리만 그리고 계좌번호 칸을 그리지 않는다
  assert.match(live, /last4|payoutAccountLast4/);
  assert.doesNotMatch(live, /\{[^}]*\.accountNumber\}/);
});
