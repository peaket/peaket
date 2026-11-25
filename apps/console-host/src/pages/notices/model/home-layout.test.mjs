// 홈 구성 보기·상태·검사·저장 본문(F-03-5 T1·T2·T6·T11·T12·T15, C-T29, ASVS v5.0.0-2.2.3·2.3.2·8.1.2·8.2.3, 시험 먼저 ADR 0372번).
// 정본: docs/design/d5-screen-blueprint.md §7.16 [홈 구성](배너 10·테마 5·테마당 공연 20 [가정], 상태 게시 중·예정·끝남·노출 안 됨),
// docs/features/control-tower.md §14 C-T29(판매 승인 전 422, 판이 다르면 412), ADR-0063·ADR-0199 결정 5(배너 제목 40·부제 80),
// docs/api/openapi.yaml HomeLayout·HomeLayoutInput(updatedBy·updatedAt 읽기 전용, 요청은 닫힌 객체), 계획 docs/review/plans/F-03-5.md §4.
// 구현 전 트리에는 home-layout.ts가 없어 시험마다 가져오기부터 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const NOW = Date.parse('2026-11-25T03:00:00.000Z'); // KST 12:00
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function banner(over = {}) {
  return {
    bannerId: 'bn-1',
    productionId: A,
    imageId: 'img-1',
    alt: 'LUMEN 콘서트 2026 서울, 10/25(일) 피켓 아레나',
    title: 'LUMEN 콘서트 2026 서울',
    subtitle: '10/25(일)~10/26(월) 피켓 아레나',
    displayFrom: '2026-11-01T00:00:00.000Z',
    displayUntil: '2026-12-01T00:00:00.000Z',
    ...over,
  };
}
function theme(over = {}) {
  return {
    themeId: 'th-1',
    name: '올해의 재즈',
    productionIds: [A, B],
    displayFrom: '2026-11-01T00:00:00.000Z',
    displayUntil: '2026-12-01T00:00:00.000Z',
    ...over,
  };
}
function raw(over = {}) {
  return {
    version: 7,
    updatedBy: '민호(operator)',
    updatedAt: '2026-11-20T03:00:00.000Z',
    banners: [banner()],
    themes: [theme()],
    ...over,
  };
}
const ctx = (over = {}) => ({ nowMs: NOW, approvedProductionIds: [A, B], cancelledProductionIds: [], ...over });

test('F-03-5 T1 C-T29 판매 승인 전 공연·대체 텍스트 없음·기간이 뒤집힌 배너는 저장을 막는다', async () => {
  const { bannerIssue, homeLayoutInputOf, homeLayoutView } = await import('./home-layout.ts');
  assert.equal(bannerIssue(banner(), ctx()), null);
  assert.match(bannerIssue(banner({ productionId: C }), ctx()), /판매 승인/);
  assert.match(bannerIssue(banner({ alt: '' }), ctx()), /대체 텍스트/);
  assert.match(bannerIssue(banner({ alt: 'ㄱ'.repeat(301) }), ctx()), /300/);
  assert.match(bannerIssue(banner({ title: '' }), ctx()), /제목/);
  assert.match(bannerIssue(banner({ title: 'ㄱ'.repeat(41) }), ctx()), /40/);
  assert.match(bannerIssue(banner({ subtitle: 'ㄱ'.repeat(81) }), ctx()), /80/);
  assert.match(bannerIssue(banner({ imageId: '' }), ctx()), /이미지/);
  assert.match(
    bannerIssue(banner({ displayFrom: '2026-12-02T00:00:00.000Z', displayUntil: '2026-12-01T00:00:00.000Z' }), ctx()),
    /기간/,
  );
  const view = homeLayoutView(raw({ banners: [banner({ productionId: C })] }), ctx());
  assert.equal(homeLayoutInputOf(view, { reason: '겨울 시즌 배너로 바꿉니다' }), null);
});

test('F-03-5 T6 [ASVS v5.0.0-2.2.3] 배너·테마 대상은 판매 승인된 공연만이고 테마 공연은 1~20개다', async () => {
  const { themeIssue, bannerIssue } = await import('./home-layout.ts');
  assert.equal(themeIssue(theme(), ctx()), null);
  assert.match(themeIssue(theme({ productionIds: [A, C] }), ctx()), /판매 승인/);
  assert.match(themeIssue(theme({ productionIds: [] }), ctx()), /공연/);
  assert.match(themeIssue(theme({ productionIds: Array.from({ length: 21 }, () => A) }), ctx()), /20/);
  assert.match(themeIssue(theme({ name: 'ㄱ'.repeat(31) }), ctx()), /30/);
  // 회차가 모두 취소된 공연은 노출 안 됨(까닭)
  const view = (await import('./home-layout.ts')).homeLayoutView(raw(), ctx({ cancelledProductionIds: [A] }));
  assert.equal(view.banners[0].status, '노출 안 됨');
  assert.match(view.banners[0].reason, /취소/);
  assert.equal(bannerIssue(view.banners[0], ctx({ cancelledProductionIds: [A] })), null, '이미 저장된 배너의 표시는 검사와 다르다');
});

test('F-03-5 T6 [ASVS v5.0.0-2.3.2] 배너 10장·테마 5개를 넘으면 게시를 막는다', async () => {
  const { homeLayoutIssues, homeLayoutInputOf, homeLayoutView } = await import('./home-layout.ts');
  const manyBanners = Array.from({ length: 11 }, (_, i) => banner({ bannerId: `bn-${i}` }));
  const manyThemes = Array.from({ length: 6 }, (_, i) => theme({ themeId: `th-${i}` }));
  const v1 = homeLayoutView(raw({ banners: manyBanners }), ctx());
  assert.match(homeLayoutIssues(v1).join(' '), /배너.*10/);
  const v2 = homeLayoutView(raw({ themes: manyThemes }), ctx());
  assert.match(homeLayoutIssues(v2).join(' '), /테마.*5/);
  assert.equal(homeLayoutInputOf(v1, { reason: '사유' }), null);
  assert.equal(homeLayoutInputOf(v2, { reason: '사유' }), null);
});

test('F-03-5 T2 C-T29 홈 구성 상태는 게시 중·예정·끝남·노출 안 됨으로 나뉘고 판을 If-Match로 쓴다', async () => {
  const { homeLayoutView, ifMatchOf } = await import('./home-layout.ts');
  const view = homeLayoutView(
    raw({
      banners: [
        banner({ bannerId: 'bn-live' }),
        banner({ bannerId: 'bn-soon', displayFrom: '2026-11-26T00:00:00.000Z' }),
        banner({ bannerId: 'bn-done', displayUntil: '2026-11-24T00:00:00.000Z' }),
        banner({ bannerId: 'bn-unapproved', productionId: C }),
      ],
      themes: [theme({ themeId: 'th-live' }), theme({ themeId: 'th-soon', displayFrom: '2026-11-26T00:00:00.000Z' })],
    }),
    ctx(),
  );
  assert.deepEqual(
    view.banners.map((b) => b.status),
    ['게시 중', '예정', '끝남', '노출 안 됨'],
  );
  assert.deepEqual(
    view.themes.map((t) => t.status),
    ['게시 중', '예정'],
  );
  assert.equal(ifMatchOf(7), '7');
});

test('F-03-5 T11 [ASVS v5.0.0-8.1.2] updatedBy·updatedAt은 보기에는 있고 저장 본문에는 없다', async () => {
  const { homeLayoutView, homeLayoutInputOf } = await import('./home-layout.ts');
  const view = homeLayoutView(raw(), ctx());
  assert.equal(view.updatedBy, '민호(operator)');
  assert.equal(view.updatedAt, '2026-11-20T03:00:00.000Z');
  const body = homeLayoutInputOf(view, { reason: '겨울 시즌 배너로 바꿉니다' });
  assert.equal('updatedBy' in body, false);
  assert.equal('updatedAt' in body, false);
});

test('F-03-5 T12 [ASVS v5.0.0-8.2.3] 저장 본문은 version·banners·themes·reason만 싣고 화면용 status·reason을 싣지 않는다', async () => {
  const { homeLayoutView, homeLayoutInputOf } = await import('./home-layout.ts');
  const body = homeLayoutInputOf(homeLayoutView(raw(), ctx()), { reason: '겨울 시즌 배너로 바꿉니다' });
  assert.deepEqual(Object.keys(body).sort(), ['banners', 'reason', 'themes', 'version']);
  assert.deepEqual(Object.keys(body.banners[0]).sort(), [
    'alt',
    'bannerId',
    'displayFrom',
    'displayUntil',
    'imageId',
    'productionId',
    'subtitle',
    'title',
  ]);
  assert.deepEqual(Object.keys(body.themes[0]).sort(), ['displayFrom', 'displayUntil', 'name', 'productionIds', 'themeId']);
  assert.equal('status' in body.banners[0], false);
});

test('F-03-5 T15 C-T29 게시 사유가 비면 본문을 만들지 않고, 있으면 버전과 사유를 함께 싣는다', async () => {
  const { homeLayoutView, homeLayoutInputOf } = await import('./home-layout.ts');
  const view = homeLayoutView(raw(), ctx());
  assert.equal(homeLayoutInputOf(view, { reason: '   ' }), null);
  const body = homeLayoutInputOf(view, { reason: ' 겨울 시즌 배너로 바꿉니다 ' });
  assert.equal(body.version, 7);
  assert.equal(body.reason, '겨울 시즌 배너로 바꿉니다');
  assert.equal(body.banners.length, 1);
});
