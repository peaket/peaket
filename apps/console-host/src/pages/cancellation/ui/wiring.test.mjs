// SCR-047 실제 화면의 배선 시험(BAT-421, docs/review/plans/BAT-421.md §4·§6).
// 정본: docs/design/d5-screen-blueprint.md §7.8, docs/security/asvs/transfer-refund.md v5.0.0-3.2.2·v5.0.0-3.5.3,
// docs/features/transfer-refund.md §5 '판정·미리보기·확정의 차례'.
// 상세·판정·미리보기·2인 확정(재인증)·진행률(accountPending)·요청 고르기·보드 분기를 소스로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const connected = read('./ConnectedPage.tsx');
const page = read('./Page.tsx');
const dialog = read('../../../features/admin-reauth/ReauthDialog.tsx');
const ops = read('../../../../../../packages/api-client/src/gen/endpoints/ops/ops.ts');

const count = (src, re) => (src.match(re) ?? []).length;
const methodOf = (src, name) => {
  const at = src.indexOf(`export const ${name} = async`);
  assert.ok(at >= 0, `${name} 생성 함수가 없다`);
  return /\bmethod: '([A-Z]+)'/.exec(src.slice(at, at + 2_000))?.[1];
};

test('[ASVS v5.0.0-3.5.3] transfer-refund:v5.0.0-3.5.3 SCR047_판정·확정은_POST·조회는_GET이다', () => {
  assert.equal(methodOf(ops, 'getOpsEventCancellation'), 'GET');
  assert.equal(methodOf(ops, 'listOpsEventCancellations'), 'GET');
  assert.equal(methodOf(ops, 'createOpsEventCancellationJudgement'), 'POST');
  assert.equal(methodOf(ops, 'createOpsEventCancellationApproval'), 'POST');
  assert.equal(methodOf(ops, 'createOpsEventCancellationRejection'), 'POST');
  // 실행부는 공용 ops 생성 호출로만 지나고 화면이 fetch를 만들지 않는다
  assert.equal(count(connected, /import\('@peaket\/api-client\/endpoints\/ops'\)/g), 5, 'ops 실행부 늦은 import');
  assert.doesNotMatch(connected, /\bfetch\s*\(/);
  assert.match(connected, /ensureConsoleApi\(\)/);
  assert.match(connected, /opsApiAvailable\(\)/);
});

test('SCR047_판정은_세_귀책과_팬_통지_사유를_보내고_확정은_재인증_뒤에만_한다', () => {
  assert.match(connected, /const FAULTS: readonly \{ value: 'ORGANIZER' \| 'FORCE_MAJEURE' \| 'CONTENT_CHANGE'; label: string \}\[\]/);
  assert.match(connected, /createOpsEventCancellationJudgement\(detail\.requestId, \{ fault, reason: reason\.trim\(\), fanNoticeReason: fanNotice\.trim\(\) \}\)/);
  assert.match(connected, /createOpsEventCancellationRejection\(detail\.requestId, \{ reason: rejectReason\.trim\(\) \}\)/);
  // 확정은 토큰을 인자로 받는 함수 하나에서만 부르고, 재인증 대화상자가 토큰을 넘긴다
  assert.match(connected, /const approve = async \(token: string\) =>/);
  assert.match(connected, /createOpsEventCancellationApproval\(detail\.requestId, \{ headers: \{ 'X-Reauth-Token': token \} \}\)/);
  assert.equal(count(connected, /createOpsEventCancellationApproval\(/g), 1);
  assert.match(connected, /onDone=\{\(token\) => void approve\(token\)\}/);
  assert.match(connected, /onClick=\{\(\) => setReauthOpen\(true\)\}/);
  assert.doesNotMatch(connected, /approve\(''/);
  assert.match(dialog, /requestApprovalReauth\(\{ password, code: code\.trim\(\) \}\)/);
  // 확정 버튼은 PENDING_APPROVAL에서만 살아 있고, 판정자를 보인다
  assert.match(connected, /const canApprove = canWrite && status === 'PENDING_APPROVAL'/);
  assert.match(connected, /disabled=\{!canApprove \|\| busy !== null\}/);
  assert.match(connected, /detail\.judgedBy \? `판정자: \$\{detail\.judgedBy\}` : '아직 판정자가 없습니다\.'/);
  assert.match(connected, /\{detail\.judgedBy \?\? '아직 판정 전'\}/);
});

test('SCR047_요청_고르기와_상세를_실제_API로_읽고_dryRun을_디코더로_푼다', () => {
  assert.match(connected, /const ACTIVE = \['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'RUNNING', 'PAUSED'\] as const/);
  assert.match(connected, /listOpsEventCancellations\(\{ status: \[\.\.\.ACTIVE\], limit: 50 \}\)/);
  assert.match(connected, /getOpsEventCancellation\(id\)/);
  assert.match(connected, /const d = detailView\(r\.data\)/);
  assert.match(connected, /const preview = detail\?\.dryRun \?\? null/);
  // 미리보기는 해석한 다섯 값과 결제사별 몫만 그린다(원본 JSON을 찍지 않는다)
  for (const label of ['대상 주문', '환급 총액', '배상 대상', '배상 총액', '결제사', '예상 소요']) {
    assert.ok(connected.includes(label), `미리보기에 '${label}'가 없다`);
  }
  assert.match(connected, /preview\.targetOrders\.toLocaleString\('ko-KR'\)/);
  assert.match(connected, /preview\.refundTotal/);
  assert.match(connected, /preview\.compensationTargets/);
  assert.match(connected, /preview\.compensationTotal/);
  assert.match(connected, /Math\.ceil\(p\.estimatedSeconds \/ 60\)/);
  assert.doesNotMatch(connected, /JSON\.stringify/);
  // 요청 ID가 없거나 404면 목록에서 고른다
  assert.match(connected, /if \(requestId\) void refresh\(requestId\);\s*else void list\(\);/);
  assert.match(connected, /if \(mapped\.kind === 'not-found'\) await list\('요청을 찾을 수 없습니다\. 목록에서 골라 주세요'\)/);
});

test('SCR047_진행률은_done나누기_total이고_accountPending을_따로_센다', () => {
  assert.match(connected, /const percent = percentOf\(progress\)/);
  assert.match(connected, /const complete = progress \? progress\.total === progress\.done \+ progress\.failed \+ progress\.accountPending : false/);
  assert.match(connected, /계좌 대기 \{progress\.accountPending\.toLocaleString\('ko-KR'\)\}건/);
  assert.match(connected, /완료 \{progress\.done\.toLocaleString\('ko-KR'\)\} \/ \{progress\.total\.toLocaleString\('ko-KR'\)\}건 · 실패 \{progress\.failed\.toLocaleString\('ko-KR'\)\}건/);
  assert.match(connected, /role="progressbar" aria-valuenow=\{percent\}/);
  assert.match(connected, /pauseReasonText\(p\.pauseReason\)/);
  assert.match(connected, /모든 항목이 끝났습니다/);
});

test('SCR047_일시정지·재개는_이유_글과_함께_비활성이고_viewer·CS는_읽기다', () => {
  assert.equal(count(connected, /title="재개 조건\(최근 5분 실패율·서킷\)을 읽는 계약이 없어 이 묶음에서는 열지 않습니다"/g), 2);
  assert.match(connected, /일시정지·재개는 재개 조건\(최근 5분 실패율·서킷\)을 읽는 계약이 없어 이 묶음에서는 부르지 않습니다\./);
  assert.match(connected, /const canWrite = role === 'operator' \|\| role === 'commander'/);
  assert.match(connected, /const canJudge = role === 'commander'/);
  assert.match(connected, /\{!canWrite \? \(/);
  assert.match(connected, /\{role === 'viewer' \? 'viewer' : 'CS 담당'\}는 이 화면을 읽기만 합니다/);
  assert.match(connected, /disabled=\{!canJudgeNow \|\| busy !== null\}/);
  assert.match(connected, /disabled=\{!canReject \|\| busy !== null\}/);
  assert.match(connected, /확정은 PENDING_APPROVAL에서만 하고, viewer·CS는 할 수 없습니다\./);
});

test('SCR047_보드는_미리보기에서만_남고_실제_경로는_ConnectedPage다', () => {
  assert.match(page, /return __PREVIEW__ && sp\.get\('state'\) \? <BoardPage \/> : <ConnectedPage \/>;/);
  assert.match(page, /import \{ ConnectedPage \} from '\.\/ConnectedPage';/);
  assert.match(page, /<PreviewSwitcher states=\{STATES\} current=\{state\} \/>/);
});

test('[ASVS v5.0.0-3.2.2] SCR047_서버_글은_텍스트로만_그리고_모르는_값은_알_수_없음으로_둔다', () => {
  assert.doesNotMatch(connected, /dangerouslySetInnerHTML|\.innerHTML\b/);
  assert.doesNotMatch(connected, /\b(?:e|err|problem)\.(?:title|detail)\b/);
  assert.match(connected, /\{detail\.partnerReason \?\? '—'\}/);
  assert.match(connected, /\{detail\.evidenceRef \?\? '—'\}/);
  assert.match(connected, /stateLabel\(detail\.status\)/);
  assert.match(connected, /stateLabel\(r\.status\)/);
});
