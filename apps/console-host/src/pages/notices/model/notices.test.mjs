// 공지 화면의 역할·탭·템플릿·파트너 공지 검사와 오류 글(F-03-5 T3·T5·T10·T12, C-T29, ASVS v5.0.0-2.1.1·8.1.1·8.2.3, 시험 먼저 ADR 0372번).
// 정본: docs/design/d5-screen-blueprint.md §7.16(템플릿 네 언어 120자, 파트너 공지 말머리·제목 40·본문 500·채널, viewer 홈 구성 읽기만),
// docs/features/control-tower.md §12 휴대폰(보기·이미 요청된 승인만), docs/planning/03 §3 권한 표,
// docs/api/openapi.yaml NoticeTemplateCreate·NoticeTemplateTextsInput·PartnerNoticeCreate·HomeLayoutInput,
// 계획 docs/review/plans/F-03-5.md §4 공개 인터페이스.
// 구현 전 트리에는 notices.ts가 없어 시험마다 가져오기부터 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;

const UUID = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const TEXTS = {
  ko: '결제 대행사 점검으로 결제가 잠시 늦어질 수 있습니다. 대기 순서는 그대로입니다.',
  en: 'Payments may be briefly delayed due to maintenance by our payment provider. Your place in line is kept.',
  ja: '決済代行会社のメンテナンスにより、決済が一時的に遅れる場合があります。順番はそのままです。',
  zh: '由于支付服务商进行系统维护，付款可能会暂时延迟。您的排队顺序不变。',
};

async function model() {
  return import('./notices.ts');
}

test('F-03-5 T10 [ASVS v5.0.0-8.1.1] viewer는 홈 구성만 보고 operator는 저장, commander는 승인까지 한다', async () => {
  const { noticeTabs, noticeAvailability } = await model();
  assert.deepEqual(noticeTabs('viewer'), ['home']);
  assert.deepEqual(noticeTabs('operator'), ['templates', 'partner', 'home']);
  assert.deepEqual(noticeTabs('commander'), ['templates', 'partner', 'home']);

  const can = (role, layout, action) => noticeAvailability({ role, layout, action });
  assert.equal(can('viewer', 'desktop', 'publish-home').allowed, false);
  assert.match(can('viewer', 'desktop', 'publish-home').reason, /권한/);
  assert.equal(can('operator', 'desktop', 'create-template').allowed, true);
  assert.equal(can('operator', 'desktop', 'approve-template').allowed, false);
  assert.match(can('operator', 'desktop', 'approve-template').reason, /commander/);
  assert.equal(can('commander', 'desktop', 'approve-template').allowed, true);
  assert.equal(can('commander', 'tablet', 'publish-home').allowed, true);
  // 휴대폰은 commander도 작성·승인·게시를 하지 않는다(d5 §3.9 SCR-068 행)
  for (const action of ['create-template', 'approve-template', 'send-partner', 'publish-home', 'upload-banner']) {
    const got = can('commander', 'phone', action);
    assert.equal(got.allowed, false, `휴대폰 ${action}`);
    assert.equal(got.reason, '이 작업은 태블릿이나 데스크톱에서 합니다. 휴대폰에서는 볼 수만 있습니다');
  }
});

test('F-03-5 T5 [ASVS v5.0.0-2.1.1] 템플릿은 네 언어가 모두 있고 언어마다 120자 이하일 때만 저장한다', async () => {
  const { missingLanguages, templateIssue, templateCreateBody } = await model();
  assert.deepEqual(missingLanguages({ ...TEXTS, ja: '' }), ['ja']);
  assert.deepEqual(missingLanguages({ ko: '', en: '', ja: '', zh: '' }), ['ko', 'en', 'ja', 'zh']);

  const ok = { templateId: 'entry-delay', title: '입장 지연 안내', texts: TEXTS };
  assert.equal(templateIssue(ok), null);
  assert.deepEqual(templateCreateBody(ok), { templateId: 'entry-delay', title: '입장 지연 안내', texts: TEXTS });

  assert.match(templateIssue({ ...ok, templateId: 'Entry Delay' }), /id/);
  assert.match(templateIssue({ ...ok, title: 'ㄱ'.repeat(61) }), /제목/);
  assert.match(templateIssue({ ...ok, texts: { ...TEXTS, ko: 'ㄱ'.repeat(121) } }), /120/);
  assert.match(templateIssue({ ...ok, texts: { ...TEXTS, zh: '' } }), /zh/);
  assert.equal(templateCreateBody({ ...ok, texts: { ...TEXTS, en: '' } }), null);
});

test('F-03-5 T5 [ASVS v5.0.0-2.1.1] 템플릿 고치기 본문은 제목·문구만 싣고 id·version·status를 싣지 않는다', async () => {
  const { templateUpdateBody } = await model();
  const body = templateUpdateBody({ templateId: 'entry-delay', title: '입장 지연 안내', texts: TEXTS });
  assert.deepEqual(Object.keys(body).sort(), ['texts', 'title']);
  assert.deepEqual(body.texts, TEXTS);
});

test('F-03-5 T3 C-T29 파트너 긴급 공지는 대상·말머리·제목·본문·채널이 맞아야 보낸다', async () => {
  const { partnerIssue, partnerNoticeBody, partnerTitleWithPhase } = await model();
  const ok = {
    targetKind: 'EVENT',
    eventId: UUID,
    phase: 'ONGOING',
    title: '결제 확정 지연 안내',
    body: '10/14(수) 20:03 KST부터 결제 대행사 응답이 늦어 결제 확정이 늦어지고 있습니다. 파트너께서 하실 일은 없습니다.',
    channels: ['CONSOLE_POPUP', 'EMAIL'],
  };
  assert.equal(partnerIssue(ok), null);
  assert.deepEqual(partnerNoticeBody(ok), ok);
  assert.equal(partnerTitleWithPhase('ONGOING', '결제 확정 지연 안내'), '[진행] 결제 확정 지연 안내');
  assert.equal(partnerTitleWithPhase('OCCURRED', '결제 확정 지연 안내'), '[발생] 결제 확정 지연 안내');
  assert.equal(partnerTitleWithPhase('RESOLVED', '결제 확정 지연 안내'), '[해결] 결제 확정 지연 안내');

  assert.match(partnerIssue({ ...ok, targetKind: 'EVENT', eventId: '' }), /회차/);
  assert.match(partnerIssue({ ...ok, title: 'ㄱ'.repeat(41) }), /40/);
  assert.match(partnerIssue({ ...ok, body: 'ㄱ'.repeat(501) }), /500/);
  assert.match(partnerIssue({ ...ok, channels: [] }), /채널/);
  assert.equal(partnerNoticeBody({ ...ok, channels: [] }), null);
  // 전체 대상이면 eventId를 싣지 않는다(openapi PartnerNoticeCreate)
  const all = partnerNoticeBody({ ...ok, targetKind: 'ALL' });
  assert.equal('eventId' in all, false);
});

test('F-03-5 T3 C-T29 412는 다른 운영자가 먼저 저장, 403은 권한 없음, 422는 입력 확인 글로 바꾼다', async () => {
  const { noticeProblem } = await model();
  assert.match(noticeProblem({ status: 412, type: 'precondition-failed' }), /다른 운영자가 먼저 저장했습니다/);
  assert.match(noticeProblem({ status: 409, type: 'precondition-failed' }), /다른 운영자가 먼저 저장했습니다/);
  assert.match(noticeProblem({ status: 403, type: 'reauth-required' }), /다시 로그인한 확인/);
  assert.match(noticeProblem({ status: 403, type: 'command-role-forbidden' }), /^이 작업을 할 권한이 없습니다/);
  assert.match(noticeProblem({ status: 422, type: 'validation-failed' }), /판매 승인·기간·이미지·문구/);
  assert.match(noticeProblem({ status: 428, type: 'precondition-required' }), /먼저 구성을 읽어야/);
  assert.match(noticeProblem({ status: 413 }), /용량/);
  assert.match(noticeProblem({ status: 415 }), /형식/);
  assert.match(noticeProblem({ status: 503 }), /^일시적인 오류입니다/);
  // 서버 title·detail은 그대로 보이지 않는다
  assert.doesNotMatch(noticeProblem({ status: 500, title: 'internal', detail: 'stack trace' }), /internal|stack/);
});

test('F-03-5 T12 [ASVS v5.0.0-8.2.3] 템플릿 작성 본문은 계약이 정한 칸만 싣는다', async () => {
  const { templateCreateBody } = await model();
  const body = templateCreateBody({ templateId: 'entry-delay', title: '입장 지연 안내', texts: TEXTS });
  assert.deepEqual(Object.keys(body).sort(), ['templateId', 'texts', 'title']);
  assert.deepEqual(Object.keys(body.texts).sort(), ['en', 'ja', 'ko', 'zh']);
});
