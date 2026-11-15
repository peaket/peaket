// 공연 상세의 등급별 실시간 판매 상태: 대기 상태 파일 구간 0(SCR-002, ADR-0272 결정 1, d5 §5.2 '매진'·'잔여석 조회 실패'·'로딩', BUILD_ORDER HOT-346)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierBadge } from './detail.ts';
import { LIVE_SALE_FETCH_INIT, liveSaleUrl, toLiveSale } from './live-sale.ts';

const file = (o = {}) => ({ serving: 120, servingRate: 1.5, generatedAtMs: Date.parse('2026-11-20T11:05:00Z'), saleStatus: 'ON_SALE', soldOutTiers: ['tier-r'], ...o });
const STATUSES = ['ON_SALE', 'PAUSED', 'ALL_HELD', 'TIER_SOLD_OUT', 'SOLD_OUT', 'ENDED'];
const SOLD = { text: '매진', kind: 'badge', tone: 'neutral' };
const ON = { text: '판매 중', kind: 'muted' };
const ENDED = { text: '판매 종료', kind: 'badge', tone: 'neutral' };
const SOON = { text: '오픈 예정', kind: 'badge', tone: 'primary' };

// ── T12 ──
test('[ASVS v5.0.0-16.5.2] SCR-002 등급 판매 상태: 404·500·연결 실패(status 0)·본문 {}·모르는 saleStatus·soldOutTiers가 배열 아님은 unknown이고 배지는 고정 글 \'판매 중\'(POL-029), loading은 뼈대(undefined)', () => {
  // 200이고 모양이 맞을 때만 known(여섯 값 모두)
  for (const saleStatus of STATUSES) assert.deepEqual(toLiveSale(200, file({ saleStatus })), { status: 'known', saleStatus, soldOutTiers: ['tier-r'] }, saleStatus);
  const cases = [
    [404, file()],
    [500, file()],
    [503, file()],
    [0, undefined],
    [201, file()],
    [304, file()],
    [200, {}],
    [200, null],
    [200, 'ON_SALE'],
    [200, file({ saleStatus: 'BOGUS' })],
    [200, file({ saleStatus: 'sold_out' })],
    [200, file({ saleStatus: undefined })],
    [200, file({ soldOutTiers: 'tier-r' })],
    [200, file({ soldOutTiers: { 0: 'tier-r' } })],
  ];
  for (const [status, body] of cases) assert.deepEqual(toLiveSale(status, body), { status: 'unknown' }, `${status} ${JSON.stringify(body)}`);
  // 실패면 고정 글 '판매 중'이고 등급마다 같다. 받기 전은 뼈대
  for (const tier of ['tier-r', 'tier-s']) assert.deepEqual(tierBadge('queue', { status: 'unknown' }, tier), ON, tier);
  assert.equal(tierBadge('queue', { status: 'loading' }, 'tier-r'), undefined);
});

// ── T13 ──
test('SCR-002 등급 배지: SOLD_OUT은 모든 등급 <매진>, ON_SALE·PAUSED·ALL_HELD·TIER_SOLD_OUT은 soldOutTiers에 든 등급만 <매진>이고 목록 밖 등급(등급마다)은 \'판매 중\', ENDED는 <판매 종료>, 오픈 전 <오픈 예정>, 판매 종료·취소 <판매 종료>', () => {
  const live = (saleStatus, soldOutTiers = ['tier-r']) => ({ status: 'known', saleStatus, soldOutTiers });
  for (const tier of ['tier-r', 'tier-s', 'tier-a']) {
    assert.deepEqual(tierBadge('queue', live('SOLD_OUT', []), tier), SOLD, `SOLD_OUT ${tier}`);
    assert.deepEqual(tierBadge('queue', live('ENDED', ['tier-r']), tier), ENDED, `ENDED ${tier}`);
  }
  for (const s of ['ON_SALE', 'PAUSED', 'ALL_HELD', 'TIER_SOLD_OUT']) {
    assert.deepEqual(tierBadge('queue', live(s), 'tier-r'), SOLD, `${s} 든 등급`);
    for (const tier of ['tier-s', 'tier-a', 'TIER-R', 'tier-r ']) assert.deepEqual(tierBadge('queue', live(s), tier), ON, `${s} 목록 밖 ${JSON.stringify(tier)}`);
  }
  // 오픈 전(상태 파일을 받지 않는다)은 받기 전·모름이어도 <오픈 예정>
  for (const phase of ['closed', 'pending', 'notYet', 'lobby', 'fifo']) {
    for (const l of [{ status: 'loading' }, { status: 'unknown' }]) assert.deepEqual(tierBadge(phase, l, 'tier-r'), SOON, `${phase} ${l.status}`);
  }
  // 판매 종료·취소는 상태 파일 값과 상관없이 <판매 종료>
  for (const phase of ['ended', 'cancelled']) {
    for (const l of [{ status: 'loading' }, live('ON_SALE'), live('SOLD_OUT')]) assert.deepEqual(tierBadge(phase, l, 'tier-s'), ENDED, `${phase} ${l.status}`);
  }
  assert.equal(tierBadge(undefined, live('SOLD_OUT'), 'tier-r'), undefined, '상태를 아직 모르면 뼈대');
});

// ── T14 ──
test('SCR-002 상태 파일 주소는 queue-files 출처의 구간 0(회차 ID 인코딩, 쿼리 없음)이고 쿠키 없이 브라우저 캐시만 건너뛴다(credentials omit·cache no-store·머리 없음)', () => {
  const ev = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
  assert.equal(liveSaleUrl('https://queue-files.peaket.example', ev), `https://queue-files.peaket.example/v1/queues/${ev}/segment-states/0.json`);
  const odd = liveSaleUrl('https://queue-files.peaket.example', 'e 1/../가?x=1');
  assert.equal(odd, 'https://queue-files.peaket.example/v1/queues/e%201%2F..%2F%EA%B0%80%3Fx%3D1/segment-states/0.json');
  assert.ok(!odd.includes('?') && !odd.includes('#'), '쿼리·조각(캐시 버스터)이 없다');
  assert.deepEqual(LIVE_SALE_FETCH_INIT, { credentials: 'omit', cache: 'no-store' });
  assert.equal(LIVE_SALE_FETCH_INIT.headers, undefined, '사용자 머리 없음');
});
