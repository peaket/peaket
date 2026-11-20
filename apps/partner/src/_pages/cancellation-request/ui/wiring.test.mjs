// SCR-044 회차 취소·연기 실제 화면의 배선 시험(BAT-421, docs/review/plans/BAT-421.md §4·§6).
// 정본: docs/design/d5-screen-blueprint.md §6.12, docs/frontend.md §4.1,
// docs/security/asvs/transfer-refund.md v5.0.0-3.2.2·v5.0.0-3.5.3.
// POST/GET 구분·멱등 키·확인 대화상자 뒤 전송·실무자 403 뒤 버튼 끔·내부 값 미표시를 소스로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const live = read('./LiveCancellationRequest.tsx');
const page = read('./CancellationRequestPage.tsx');
const api = read('../../../shared/api/partner-live.ts');
const partner = read('../../../../../../packages/api-client/src/gen/endpoints/partner/partner.ts');

const count = (src, re) => (src.match(re) ?? []).length;
const methodOf = (src, name) => {
  const at = src.indexOf(`export const ${name} = async`);
  assert.ok(at >= 0, `${name} 생성 함수가 없다`);
  return /\bmethod: '([A-Z]+)'/.exec(src.slice(at, at + 2_000))?.[1];
};

test('[ASVS v5.0.0-3.5.3] transfer-refund:v5.0.0-3.5.3 SCR044_요청은_POST·상태는_GET이다', () => {
  assert.equal(methodOf(partner, 'createPartnerEventCancellation'), 'POST');
  assert.equal(methodOf(partner, 'getPartnerEventCancellation'), 'GET');
  assert.equal(methodOf(partner, 'getPartnerProduction'), 'GET');
  // 실제 호출은 공용 partner-live만 지난다
  for (const name of ['requestEventCancellation', 'getEventCancellation', 'getProductionDetail', 'newIdempotencyKey']) {
    assert.match(live, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(api, /OPERATIONS\.createPartnerEventCancellation/);
  assert.match(api, /idempotencyKey,/);
  assert.match(api, /OPERATIONS\.getPartnerEventCancellation/);
  // 화면이 직접 fetch를 만들지 않는다
  assert.doesNotMatch(live, /\bfetch\s*\(/);
  assert.match(api, /import\('@\/shared\/api'\)/);
});

test('SCR044_요청은_확인_대화상자_뒤에만_POST하고_같은_본문은_같은_키다', () => {
  const open = live.slice(live.indexOf('const openConfirm'), live.indexOf('const send'));
  assert.match(open, /validateRequest\(/);
  assert.match(open, /setConfirmOpen\(true\)/);
  assert.doesNotMatch(open, /requestEventCancellation/, '확인 대화상자 전에는 보내지 않는다');

  assert.match(live, /confirmOpen && current \?/);
  assert.equal(count(live, /void send\(\)/g), 1, '보내기는 확인 대화상자 한 곳뿐이다');
  assert.match(live, /attemptRef\.current\?\.body === bodyText \? attemptRef\.current\.key : newIdempotencyKey\(\)/);
  assert.match(live, /requestEventCancellation\(current\.eventId, r\.body, key\)/);
  assert.match(live, /await loadStatus\(current\.eventId\)/);
  // 목업 공연 자료를 live에서 쓰지 않는다
  assert.doesNotMatch(live, /requireProduction|prd-|CANCELLATION_STATES/);
  assert.match(page, /if \(!getProduction\(id\)\) return <LiveCancellationRequest productionId=\{id\} \/>;/);
  assert.match(page, /readPreview\(await searchParams, CANCELLATION_STATES, '요청 폼'\)/);
});

test('SCR044_실무자_403은_문구를_보이고_그_방문_동안_버튼을_끈다', () => {
  assert.match(live, /const \[memberDenied, setMemberDenied\] = useState\(false\)/);
  assert.match(live, /if \(mapped\.kind === 'member'\) setMemberDenied\(true\)/);
  assert.match(live, /const REQUEST_ADMIN_REASON = '회차 취소·연기 요청은 파트너 관리자만 할 수 있습니다'/);
  assert.match(live, /disabled=\{busy \|\| memberDenied \|\| !current\}/);
  assert.match(live, /disabledReason=\{memberDenied \? REQUEST_ADMIN_REASON : undefined\}/);
  assert.match(live, /\{memberDenied \? \(/);
  assert.match(live, /<span className="banner-title">요청 권한 없음<\/span>/);
  // 역할을 미리 아는 계약이 없어 첫 방문에는 버튼이 활성이다(서버가 403으로 막는다)
  assert.doesNotMatch(live, /role ===|useChosenRole|searchParams[^\n]*role/);
});

test('SCR044_내부_값은_live에서_그리지_않는다', () => {
  for (const name of ['dryRun', 'perPg', 'judgedBy', 'compensationTargets', 'compensationTotal']) {
    assert.equal(live.includes(name), false, `${name}을 화면에 그리지 않는다`);
  }
  // 파트너 상태의 진행률은 refundProgress 합계만 본다
  assert.match(live, /status\.refundProgress/);
  assert.match(live, /status\.refundProgress\.done/);
  assert.match(live, /status\.refundProgress\.total/);
  assert.match(live, /status\.refundProgress\.failed/);
  // 반려 사유·사유·증빙 참조는 서버 글을 텍스트로 그린다
  assert.match(live, /\{status\.rejectionReason\}/);
  assert.match(live, /\{status\.reason \?\? '—'\}/);
  assert.match(live, /\{status\.evidenceRef \?\? '—'\}/);
  assert.doesNotMatch(live, /dangerouslySetInnerHTML|\.innerHTML\b/);
  assert.doesNotMatch(live, /\b(?:e|err|problem)\.(?:title|detail)\b/);
});
