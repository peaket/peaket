// 공지 화면의 요청 흐름(승인 재인증·판 머리·멱등 키·이미지 올리기)(F-03-5 T2·T3·T7·T8·T9·T15,
// C-T29, ASVS v5.0.0-3.5.1·3.5.3·5.1.1·8.1.1, 시험 먼저 ADR 0372번).
// 정본: docs/api/openapi.yaml createOpsNoticeTemplateApproval(ReauthToken·If-Match, commander),
// updateOpsNoticeTemplate(PATCH·If-Match), createOpsPartnerNotice(Idempotency-Key·202), putOpsHomeLayout(If-Match·reason),
// createOpsHomeLayoutBannerImage(multipart·X-Requested-With), docs/api/guidelines.md §7·§12, 계획 docs/review/plans/F-03-5.md §4.
// 가짜는 REST 경계만 쓴다. 검사·본문 만들기·오류 글은 진짜 모듈이다.
// 구현 전 트리에는 notice-actions.ts가 없어 시험마다 가져오기부터 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, fakeRest, json, problem } from './notices.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';
globalThis.__CONSOLE_BUILD__ = 'mf';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEXTS = { ko: '안내 문구', en: 'Notice', ja: '案内', zh: '通知' };
const TEMPLATE = { templateId: 'entry-delay', title: '입장 지연 안내', version: 3, texts: TEXTS, status: 'IN_REVIEW' };
const HOME = {
  version: 7,
  updatedBy: '민호(operator)',
  updatedAt: '2026-11-20T03:00:00.000Z',
  banners: [
    {
      bannerId: 'bn-1',
      productionId: E,
      imageId: 'img-1',
      alt: '공연 배너',
      title: '공연 제목',
      subtitle: '11/30(일) 피켓 아레나',
      displayFrom: '2026-11-01T00:00:00.000Z',
      displayUntil: '2026-12-01T00:00:00.000Z',
    },
  ],
  themes: [],
};
const PARTNER = {
  targetKind: 'EVENT',
  eventId: E,
  phase: 'ONGOING',
  title: '결제 확정 지연 안내',
  body: '결제 확정이 늦어지고 있습니다. 파트너께서 하실 일은 없습니다.',
  channels: ['CONSOLE_POPUP'],
};

function actions(role = 'commander', layout = 'desktop', reauth = async () => 'tok-1') {
  return import('./notice-actions.ts').then((m) =>
    m.createNoticeActions({
      role,
      layout,
      reauth: async (act) => {
        const token = await reauth(act);
        return token;
      },
    }),
  );
}

test('F-03-5 T7 [ASVS v5.0.0-3.5.1] 템플릿 승인은 commander가 APPROVAL로 재인증하고 If-Match·X-Reauth-Token을 한 요청에만 싣는다', async (t) => {
  const api = fakeRest();
  api.on('POST', `/v1/ops/notice-templates/${TEMPLATE.templateId}/approvals`, () => json(200, { ...TEMPLATE, status: 'APPROVED', version: 4 }));
  api.install();
  t.after(() => api.restore());

  const acts = [];
  const a = await actions('commander', 'desktop', async (act) => {
    acts.push(act);
    return 'tok-approve';
  });
  const out = await a.approveTemplate(TEMPLATE);
  assert.equal(out.kind, 'done');
  assert.deepEqual(acts, ['APPROVAL']);
  const posts = api.sent('POST', `/v1/ops/notice-templates/${TEMPLATE.templateId}/approvals`);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers['if-match'], '3');
  assert.equal(posts[0].headers['x-reauth-token'], 'tok-approve');
  assert.equal(posts[0].body, undefined, '승인은 본문 없이 머리만 보낸다');
});

test('F-03-5 T7 [ASVS v5.0.0-8.1.1] operator와 viewer는 템플릿을 승인하지 못하고 요청이 0이다', async (t) => {
  const api = fakeRest();
  api.install();
  t.after(() => api.restore());
  for (const role of ['operator', 'viewer']) {
    let reauthCalls = 0;
    const a = await actions(role, 'desktop', async () => {
      reauthCalls += 1;
      return 'tok';
    });
    const out = await a.approveTemplate(TEMPLATE);
    assert.equal(out.kind, 'blocked', role);
    assert.match(out.reason, /commander|권한/);
    assert.equal(reauthCalls, 0, role);
  }
  assert.equal(api.sent('POST', /notice-templates/).length, 0);
});

test('F-03-5 T7 403 reauth-required면 새 토큰으로 한 번만 다시 보낸다', async (t) => {
  const api = fakeRest();
  let attempt = 0;
  api.on('POST', `/v1/ops/notice-templates/${TEMPLATE.templateId}/approvals`, () => {
    attempt += 1;
    return attempt === 1 ? problem(403, 'reauth-required') : json(200, { ...TEMPLATE, status: 'APPROVED', version: 4 });
  });
  api.install();
  t.after(() => api.restore());

  const tokens = ['tok-1', 'tok-2'];
  const a = await actions('commander', 'desktop', async () => tokens.shift());
  const out = await a.approveTemplate(TEMPLATE);
  assert.equal(out.kind, 'done');
  const posts = api.sent('POST', `/v1/ops/notice-templates/${TEMPLATE.templateId}/approvals`);
  assert.equal(posts.length, 2);
  assert.deepEqual(
    posts.map((p) => p.headers['x-reauth-token']),
    ['tok-1', 'tok-2'],
  );
});

test('F-03-5 T8 [ASVS v5.0.0-3.5.3] 템플릿 저장은 POST·PATCH에 If-Match·Idempotency-Key를 쓰고 주소에 사유를 싣지 않는다', async (t) => {
  const api = fakeRest();
  api.on('POST', '/v1/ops/notice-templates', () => json(201, { ...TEMPLATE, version: 1 }));
  api.on('PATCH', `/v1/ops/notice-templates/${TEMPLATE.templateId}`, () => json(200, { ...TEMPLATE, version: 4 }));
  api.install();
  t.after(() => api.restore());

  const a = await actions('operator');
  const created = await a.createTemplate({ templateId: 'entry-delay', title: '입장 지연 안내', texts: TEXTS });
  assert.equal(created.kind, 'done');
  const posts = api.sent('POST', '/v1/ops/notice-templates');
  assert.equal(posts.length, 1);
  assert.match(posts[0].headers['idempotency-key'], UUID_V4);
  assert.equal(posts[0].url.search, '');

  const updated = await a.updateTemplate(TEMPLATE, { templateId: 'entry-delay', title: '입장 지연 안내(고침)', texts: TEXTS });
  assert.equal(updated.kind, 'done');
  const patches = api.sent('PATCH', `/v1/ops/notice-templates/${TEMPLATE.templateId}`);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].headers['if-match'], '3');
  assert.deepEqual(Object.keys(patches[0].body).sort(), ['texts', 'title']);
});

test('F-03-5 T8 [ASVS v5.0.0-3.5.3] 파트너 긴급 공지는 POST에 Idempotency-Key를 달고 202를 받는다', async (t) => {
  const api = fakeRest();
  api.on('POST', '/v1/ops/partner-notices', () => json(202, { noticeId: 'pn-1' }));
  api.install();
  t.after(() => api.restore());

  const a = await actions('operator');
  const out = await a.sendPartnerNotice(PARTNER);
  assert.equal(out.kind, 'done');
  const posts = api.sent('POST', '/v1/ops/partner-notices');
  assert.equal(posts.length, 1);
  assert.match(posts[0].headers['idempotency-key'], UUID_V4);
  assert.deepEqual(posts[0].body, PARTNER);
});

test('F-03-5 T2 C-T29 홈 구성 게시는 PUT에 If-Match·버전·사유를 싣고, 사유가 비면 요청이 0이다', async (t) => {
  const api = fakeRest();
  api.on('PUT', '/v1/ops/home-layout', () => json(200, { ...HOME, version: 8 }));
  api.install();
  t.after(() => api.restore());

  const { homeLayoutView } = await import('./home-layout.ts');
  const view = homeLayoutView(HOME, { nowMs: Date.parse('2026-11-25T03:00:00.000Z'), approvedProductionIds: [E] });
  const a = await actions('operator');

  const empty = await a.publishHomeLayout(view, '   ');
  assert.equal(empty.kind, 'invalid');
  assert.equal(api.sent('PUT', '/v1/ops/home-layout').length, 0);

  const out = await a.publishHomeLayout(view, '겨울 시즌 배너로 바꿉니다');
  assert.equal(out.kind, 'done');
  const puts = api.sent('PUT', '/v1/ops/home-layout');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].headers['if-match'], '7');
  assert.equal(puts[0].body.version, 7);
  assert.equal(puts[0].body.reason, '겨울 시즌 배너로 바꿉니다');
  assert.equal('updatedBy' in puts[0].body, false);
});

test('F-03-5 T2 C-T29 412는 다른 운영자가 먼저 저장했다는 글로 돌려주고 낡은 판을 다시 보내지 않는다', async (t) => {
  const api = fakeRest();
  api.on('PUT', '/v1/ops/home-layout', () => problem(412, 'precondition-failed'));
  api.install();
  t.after(() => api.restore());

  const { homeLayoutView } = await import('./home-layout.ts');
  const view = homeLayoutView(HOME, { nowMs: Date.parse('2026-11-25T03:00:00.000Z'), approvedProductionIds: [E] });
  const a = await actions('operator');
  const out = await a.publishHomeLayout(view, '겨울 시즌 배너로 바꿉니다');
  assert.equal(out.kind, 'problem');
  assert.equal(out.status, 412);
  assert.match(out.message, /다른 운영자가 먼저 저장했습니다/);
  assert.equal(api.sent('PUT', '/v1/ops/home-layout').length, 1);
});

test('F-03-5 T7·T9 [ASVS v5.0.0-3.5.1][ASVS v5.0.0-5.1.1] 배너는 JPEG·PNG·WebP 10MB 이하만 X-Requested-With로 올린다', async (t) => {
  const api = fakeRest();
  api.on('POST', '/v1/ops/home-layout/banner-images', () => json(201, { imageId: 'img-9', previewUrl: 'https://cdn.example/banner.jpg' }));
  api.install();
  t.after(() => api.restore());

  const a = await actions('operator');
  for (const bad of [
    new File([new Uint8Array(8)], 'banner.gif', { type: 'image/gif' }),
    new File([new Uint8Array(8)], 'banner.svg', { type: 'image/svg+xml' }),
    new File([new Uint8Array(11 * 1024 * 1024)], 'banner.png', { type: 'image/png' }),
  ]) {
    const out = await a.uploadBanner(bad);
    assert.equal(out.kind, 'invalid', bad.name);
  }
  assert.equal(api.sent('POST', '/v1/ops/home-layout/banner-images').length, 0);

  const good = new File([new Uint8Array(8)], 'banner.png', { type: 'image/png' });
  const out = await a.uploadBanner(good);
  assert.equal(out.kind, 'done');
  assert.equal(out.value.imageId, 'img-9');
  const posts = api.sent('POST', '/v1/ops/home-layout/banner-images');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers['x-requested-with'], 'XMLHttpRequest');
  assert.match(posts[0].headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.ok(posts[0].bytes > 0, 'multipart 본문이 비었다');
});

test('F-03-5 T9 [ASVS v5.0.0-5.1.1] 서버 415·413은 이미지 형식·용량 글로 바꾼다', async (t) => {
  const api = fakeRest();
  let status = 415;
  api.on('POST', '/v1/ops/home-layout/banner-images', () => problem(status, 'unsupported-media-type'));
  api.install();
  t.after(() => api.restore());
  const a = await actions('operator');
  const file = new File([new Uint8Array(8)], 'banner.png', { type: 'image/png' });
  const first = await a.uploadBanner(file);
  assert.match(first.message, /형식/);
  status = 413;
  const second = await a.uploadBanner(file);
  assert.match(second.message, /용량/);
});

test('F-03-5 T3 C-T29 viewer는 홈 구성을 게시하지 못하고 요청이 0이다', async (t) => {
  const api = fakeRest();
  api.install();
  t.after(() => api.restore());
  const { homeLayoutView } = await import('./home-layout.ts');
  const view = homeLayoutView(HOME, { nowMs: Date.parse('2026-11-25T03:00:00.000Z'), approvedProductionIds: [E] });
  const a = await actions('viewer');
  const out = await a.publishHomeLayout(view, '사유');
  assert.equal(out.kind, 'blocked');
  assert.equal(api.sent('PUT', '/v1/ops/home-layout').length, 0);
});
