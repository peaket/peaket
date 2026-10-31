// 사후 포렌식 자체 법률 검토(ADR-0173)를 화면에 옮긴 규칙과 문구 시험(OpenSpec apply-legal-review-to-screens tasks 3.1·3.2, design.md 결정 5).
// 시험을 먼저 쓰고 실패를 본 뒤 rules.ts·fixtures.ts를 만들었다. 실행: `pnpm --filter @peaket/console-host test`(Node 내장 시험 실행기, 타입 지우기).
// 기준: d5 §7.7 SCR-046 '부정 예매 조치'·§7.18 SCR-070·§7.19 SCR-071·§9.2, openapi ApprovalDecisionBody·FraudCaseSummary.targets·
// ExternalPostCreate·EvidenceExport·FraudClusterRun, POL-038 ⑪, POL-046, FR-072·073·074, ADR-0173 결정 2·3·4·5·6·7·9.
// 이 규칙은 화면 안내용이다. 서버 규칙(409·422)의 정본은 openapi와 기능 설계서다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rules from './rules.ts';
import { APPROVAL_SUMMARY_VIEWED_AT, APPROVAL_TARGETS, CASES, holdersFor } from './fixtures.ts';
import { formatKst } from './model.ts';

const {
  APPEAL_LOCK_NOTICE,
  APPROVAL_REASON_HINT,
  APPROVAL_REASON_MAX,
  APPROVAL_SCOPE_NOTE,
  COMPLAINT_NOTE,
  ERR_APPROVAL_SCOPE_INVALID,
  ERR_FRAUD_SUMMARY_NOT_VIEWED,
  ERR_REPORT_SOURCE,
  EXPORT_KINDS,
  EXPORT_KIND_LABEL,
  HOLDER_NOTICE,
  MASK_NONE_HINT,
  OPINION_HINT,
  POST_CHECKS,
  RESTRICTION_TOO_LONG,
  SUMMARY_VIEWED_NOTE,
  approvalReasonError,
  approveBlockReason,
  approveButtonText,
  candidateRetryText,
  complaintFileName,
  lockReleasedNotice,
  postRegisterEnabled,
  remainingScope,
  reportSourceError,
  restrictionEndError,
  restrictionEndMax,
  targetLabel,
  transferLockExpiresAt,
} = rules;

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const OPENAPI = readFileSync(join(ROOT, 'docs/api/openapi.yaml'), 'utf8');

// ── SCR-046 부정 예매 조치: 승인자가 실질적으로 결정한다(POL-038 ⑪, ADR-0173 결정 2·6) ──

test('POL038_11_ADR0173_2 요약을 열기 전에는 승인 단추가 비활성이고 이유를 보인다', () => {
  assert.equal(approveBlockReason({ summaryViewed: false, remainingTickets: 18 }), '사건 요약을 연 뒤에 승인할 수 있습니다');
});

test('POL038_11_ADR0173_2 대상을 모두 빼면 승인 단추가 비활성이고 반려를 안내한다', () => {
  assert.equal(approveBlockReason({ summaryViewed: true, remainingTickets: 0 }), '모두 빼려면 반려해 주세요');
  // 요약을 열지 않았으면 그 이유가 먼저다
  assert.equal(approveBlockReason({ summaryViewed: false, remainingTickets: 0 }), '사건 요약을 연 뒤에 승인할 수 있습니다');
  assert.equal(approveBlockReason({ summaryViewed: true, remainingTickets: 15 }), null);
});

test('POL038_11_ADR0173_2 판단 이유는 필수이고 1~1000자다(openapi ApprovalDecisionBody.reason)', () => {
  assert.equal(APPROVAL_REASON_MAX, 1000);
  assert.equal(approvalReasonError(''), '판단 이유를 적어 주세요');
  assert.equal(approvalReasonError('   \n '), '판단 이유를 적어 주세요');
  assert.equal(approvalReasonError('가'), null);
  assert.equal(approvalReasonError('가'.repeat(1000)), null);
  assert.equal(approvalReasonError('가'.repeat(1001)), '판단 이유는 1000자까지 적을 수 있습니다');
  // 글자 수는 코드 포인트로 센다(이모지 하나는 한 글자)
  assert.equal(approvalReasonError('😀'.repeat(1000)), null);
});

test('POL038_11_ADR0173_2 승인 단추 글은 남은 표 수와 뺀 표 수를 말한다(d5 §7.7)', () => {
  assert.equal(approveButtonText(18, 0), '표 18장 취소와 환급을 승인합니다');
  assert.equal(approveButtonText(18, 3), '표 15장 취소와 환급을 승인합니다(3장 뺌)');
});

test('ADR0173_2 범위 줄이기: 뺀 계정 줄의 표를 빼고 남은 계정·표를 센다', () => {
  const targets = [{ ticketCount: 3 }, { ticketCount: 3 }, { ticketCount: 4 }];
  assert.deepEqual(remainingScope(targets, []), { accounts: 3, tickets: 10, excludedTickets: 0 });
  assert.deepEqual(remainingScope(targets, [0]), { accounts: 2, tickets: 7, excludedTickets: 3 });
  assert.deepEqual(remainingScope(targets, [0, 1, 2]), { accounts: 0, tickets: 0, excludedTickets: 10 });
  // 목록 밖 번호는 무시한다(요청 밖 값은 서버가 422 approval-scope-invalid로 거절한다)
  assert.deepEqual(remainingScope(targets, [7]), { accounts: 3, tickets: 10, excludedTickets: 0 });
});

test('ADR0173_2 대상 줄 이름은 목록 순서로 붙인 계정 1·2…다(내부 ID를 보이지 않는다)', () => {
  assert.equal(targetLabel(0), '계정 1');
  assert.equal(targetLabel(5), '계정 6');
});

test('POL038_11 승인 목업 대상은 사건 CASE-2610-0005의 6계정 18장이고 소명 결과의 수가 사건 요약과 같다', () => {
  const c = CASES.find((x) => x.caseId === 'CASE-2610-0005');
  assert.ok(c);
  assert.equal(APPROVAL_TARGETS.length, c.accountCount);
  assert.equal(APPROVAL_TARGETS.reduce((s, t) => s + t.ticketCount, 0), c.ticketCount);
  const count = (o) => APPROVAL_TARGETS.filter((t) => t.appealOutcome === o).length;
  assert.equal(count('REJECTED'), c.appealCounts.rejected);
  assert.equal(count('EXPIRED'), c.appealCounts.expired);
  // 계정 1은 d5 그림대로 표 3장 · 소명 불인정 · 받은 사람이 가진 표 1장
  assert.deepEqual(
    { n: APPROVAL_TARGETS[0].ticketCount, o: APPROVAL_TARGETS[0].appealOutcome, h: APPROVAL_TARGETS[0].holderTicketCount },
    { n: 3, o: 'REJECTED', h: 1 },
  );
  // 범위를 줄임 그림(계정 1 뺌)은 15장(3장 뺌)이다
  assert.equal(approveButtonText(c.ticketCount, remainingScope(APPROVAL_TARGETS, [0]).excludedTickets), '표 15장 취소와 환급을 승인합니다(3장 뺌)');
  assert.equal(formatKst(APPROVAL_SUMMARY_VIEWED_AT), '10/19(월) 09:12');
});

test('ADR0173_2 승인 화면 고정 문구는 d5 §7.7·§9.2 글 그대로다', () => {
  assert.equal(APPROVAL_REASON_HINT, '요청자의 사유를 옮기지 말고, 요약을 보고 내가 판단한 이유를 적어 주세요');
  assert.equal(SUMMARY_VIEWED_NOTE, '이 열람 시각이 승인 기록에 함께 남습니다');
  assert.equal(APPROVAL_SCOPE_NOTE, '뺀 계정·표는 이 요청에서 반려한 것으로 보고, 그 계정에 다른 열린 조치 요청이 없으면 양도 잠금이 풀립니다');
  assert.equal(ERR_FRAUD_SUMMARY_NOT_VIEWED, '사건 요약을 연 기록이 없어 승인하지 못했습니다. 요약을 다시 불러온 뒤 승인해 주세요');
  assert.equal(ERR_APPROVAL_SCOPE_INVALID, '뺄 수 있는 것은 이 요청에 든 계정·표뿐입니다. 모두 빼려면 반려해 주세요');
});

// ── SCR-071 사건 작업대 ──

test('FR073_ADR0173_3 소명 요청 잠금 문구는 최대 기한을 말한다', () => {
  assert.equal(APPEAL_LOCK_NOTICE, '소명을 요청하면 이 표들의 양도가 잠깁니다. 늦어도 14일 뒤 풀립니다');
});

test('FR073_ADR0173_3 양도 잠금 최대 기한은 그 계정의 첫 소명 요청 + 14일이다', () => {
  assert.equal(Date.parse(transferLockExpiresAt('2026-10-19T14:20:00+09:00')), Date.parse('2026-11-02T14:20:00+09:00'));
  assert.equal(formatKst(transferLockExpiresAt('2026-10-18T16:00:00+09:00')), '11/1(일) 16:00');
});

test('FR073_ADR0173_3 잠금 최대 기한이 지난 안내는 모두·일부를 가른다(d5 §7.19)', () => {
  assert.equal(lockReleasedNotice(9, 9), '소명 요청 14일이 지나 양도 잠금이 풀렸습니다. 조사와 조치 요청은 계속할 수 있습니다');
  assert.equal(lockReleasedNotice(3, 9), '계정 3개의 양도 잠금이 최대 기한이 지나 풀렸습니다');
  assert.equal(lockReleasedNotice(0, 9), null);
});

test('FR073_ADR0173_4 받은 사람 안내와 조사관 의견 칸 안내는 d5 §7.19 글 그대로다', () => {
  assert.equal(HOLDER_NOTICE, '이 계정들이 결제해 다른 분에게 양도한 표가 있으면, 그 표를 가진 분에게도 같은 기한으로 사정을 알릴 기회를 드립니다(사유 범주는 알리지 않음)');
  assert.equal(OPINION_HINT, '행동 요약은 세션 하나가 자동화인지 보는 근거로만 적습니다. 계정끼리 행동이 비슷하다는 것을 같은 사람·명의 대여의 근거로 적지 않습니다');
});

test('FR073_ADR0173_4 사건 CASE-2610-0007의 받은 사람은 둘이고 하나는 진술을 냈다', () => {
  const holders = holdersFor('CASE-2610-0007');
  assert.equal(holders.length, 2);
  assert.deepEqual(holders[0], { seatLabel: 'A구역 3열 16번', statement: 'SUBMITTED' });
  assert.equal(holders[1].statement, 'PENDING');
  assert.deepEqual(holdersFor('CASE-2610-0002'), []);
});

test('FR073_ADR0173_7 이용 제한 끝은 요청한 날부터 1년까지다', () => {
  const req = '2026-10-24T16:30:00+09:00';
  assert.equal(Date.parse(restrictionEndMax(req)), Date.parse('2027-10-24T16:30:00+09:00'));
  assert.equal(restrictionEndError(req, '2027-10-24T16:30:00+09:00'), null);
  assert.equal(restrictionEndError(req, '2027-01-01T00:00:00+09:00'), null);
  assert.equal(restrictionEndError(req, '2027-10-24T16:31:00+09:00'), RESTRICTION_TOO_LONG);
  assert.equal(RESTRICTION_TOO_LONG, '부정 예매 이용 제한은 요청한 날부터 1년까지만 정할 수 있습니다. 더 늘리려면 끝나기 전에 새로 요청해 주세요');
  assert.equal(restrictionEndError(req, '2026-10-24T16:00:00+09:00'), '이용 제한 끝은 요청한 때보다 뒤여야 합니다');
  // 윤일에 요청하면 다음 해 2월 28일까지다(1년을 넘지 않는다)
  assert.equal(Date.parse(restrictionEndMax('2028-02-29T10:00:00+09:00')), Date.parse('2029-02-28T10:00:00+09:00'));
});

test('FR074_ADR0173_6 내보내기 종류는 openapi EvidenceExport 열거값 셋과 같고 고소·고발용 요약이 있다', () => {
  const m = OPENAPI.match(/\bEvidenceExport: \{[^\n]*?\bkind: \{ type: string, enum: \[([^\]]+)\]/);
  assert.ok(m, 'openapi에 EvidenceExport kind 열거값이 없다');
  const kinds = m[1].split(',').map((x) => x.trim());
  assert.deepEqual([...EXPORT_KINDS].sort(), [...kinds].sort());
  assert.deepEqual(Object.keys(EXPORT_KIND_LABEL).sort(), [...kinds].sort());
  assert.equal(EXPORT_KIND_LABEL.COMPLAINT, '고소·고발용 요약(개인정보 없음)');
  assert.equal(complaintFileName('CASE-2610-0007'), 'complaint-CASE-2610-0007.json');
  assert.equal(COMPLAINT_NOTE, '계정·연락처·IP 같은 개인정보는 들어 있지 않습니다. 수사기관 제출은 영장이나 공연법 요청을 받은 뒤 기관 제출로만 합니다');
});

// ── SCR-070 사건 목록 ──

test('FR072_ADR0173_9 외부 게시물 등록 확인 칸은 셋이고 모두 체크해야 등록 단추가 켜진다', () => {
  assert.deepEqual(POST_CHECKS, [
    '로그인 없이 누구나 볼 수 있는 공개 게시물입니다(비공개 모임·받은 메시지가 아닙니다)',
    '게시물 한 건의 화면만 캡처했습니다',
    '작성자 프로필·다른 글을 찾거나 닉네임·연락처를 검색하지 않았습니다',
  ]);
  assert.equal(postRegisterEnabled([true, true, true]), true);
  assert.equal(postRegisterEnabled([true, true, false]), false);
  assert.equal(postRegisterEnabled([false, false, false]), false);
  assert.equal(postRegisterEnabled([true, true]), false);
  assert.equal(MASK_NONE_HINT, '가릴 자리가 없으면 그대로 등록합니다');
});

test('FR072_ADR0173_9 신고 출처는 문의 유형 외부 되팔이 게시물 신고(RESALE_POST_REPORT) 건만 받는다', () => {
  assert.equal(reportSourceError('REPORT', 'RESALE_POST_REPORT'), null);
  assert.equal(reportSourceError('REPORT', 'TRANSFER'), ERR_REPORT_SOURCE);
  assert.equal(reportSourceError('REPORT', null), ERR_REPORT_SOURCE);
  assert.equal(reportSourceError('MANUAL', null), null);
  assert.equal(ERR_REPORT_SOURCE, "신고 출처에는 문의 유형이 '외부 되팔이 게시물 신고'인 건 번호만 넣을 수 있습니다");
  // 문의 유형 값은 openapi InquiryCategory에 있다
  assert.match(OPENAPI, /\bInquiryCategory: \{ type: string, enum: \[[^\]]*\bRESALE_POST_REPORT\b/);
});

test('FR072 후보 만들기 다시 시도 글은 자동 다시 시도 n/3이다(autoRetriesLeft가 남았을 때만)', () => {
  assert.equal(candidateRetryText(3), '후보 묶음을 만들지 못해 자동으로 다시 하고 있습니다(1/3)');
  assert.equal(candidateRetryText(2), '후보 묶음을 만들지 못해 자동으로 다시 하고 있습니다(2/3)');
  assert.equal(candidateRetryText(1), '후보 묶음을 만들지 못해 자동으로 다시 하고 있습니다(3/3)');
  assert.equal(candidateRetryText(0), null);
});

// ── 행동 값 나란히 보기 없음(ADR-0173 결정 5) ──

function sources(dirs) {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f)) out.push([p, readFileSync(p, 'utf8')]);
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return out;
}

test('ADR0173_5 사건 작업대·승인 화면에 묶음 계정의 행동 값을 나란히 견주는 보기가 없다', () => {
  const files = sources(['apps/console-host/src/pages/investigation-case', 'apps/console-host/src/pages/cs-approvals', 'apps/console-host/src/pages/investigations']);
  assert.ok(files.length > 0);
  const forbidden = /행동 값 (표|비교)|행동 비교|유사도|비슷한 순|겹친 그래프|similarity/i;
  for (const [p, text] of files) assert.doesNotMatch(text, forbidden, p);
});
