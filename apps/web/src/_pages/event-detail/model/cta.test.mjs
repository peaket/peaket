// 공연 상세 예매 버튼(⑦) 모양과 차례(SCR-002, d5 §5.2 상태 표, d2 §3.6, ADR-0272 결정 2·3 '차례', ADR-0213 결정 2, BUILD_ORDER HOT-346)
// bookingCta는 ui/Booking.tsx의 ctaModel을 옮긴 것이다. 옮기기 전 모양(Booking.tsx:246~289)을 그대로 단언하고, 글은 d5의 글을 적는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingCta } from './cta.ts';

const T = (iso) => Date.parse(iso);
const EV = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const NOW = T('2026-11-21T03:00:00Z');
const FAR = T('2026-12-30T10:00:00Z');
const ROUNDS = [
  { eventId: 'e0', href: '/events/e0', label: '12/23(수) 19:00', current: false, openAtMs: NOW - 3_600_000, saleEndsAtMs: NOW - 1, status: 'SCHEDULED' }, // 판매 종료
  { eventId: EV, href: `/events/${EV}`, label: '12/24(목) 19:00', current: true, openAtMs: NOW - 3_600_000, saleEndsAtMs: FAR, status: 'SCHEDULED' },
  { eventId: 'e2', href: '/events/e2', label: '12/25(금) 19:00', current: false, openAtMs: NOW - 3_600_000, saleEndsAtMs: FAR, status: 'CANCELLED' }, // 취소
  { eventId: 'e3', href: '/events/e3', label: '12/26(토) 19:00', current: false, openAtMs: NOW - 3_600_000, saleEndsAtMs: FAR, status: 'SCHEDULED' }, // 판매 중
];
const DATA = {
  eventId: EV,
  roundLabel: '12/24(목) 19:00',
  lobbyText: '19:50',
  openTimeText: '20:00',
  rounds: ROUNDS,
  loginHref: `/login?returnTo=%2Fevents%2F${EV}`,
  signupHref: `/signup/complete?returnTo=%2Fevents%2F${EV}`,
  otherRoundFallbackHref: '/productions/p1',
  hasLobby: true,
};
const FIFO = { ...DATA, lobbyText: undefined, hasLobby: false };
const QUEUE_HREF = 'https://queue.peaket.example/queue/e1';
const ON_SALE = { status: 'known', saleStatus: 'ON_SALE', soldOutTiers: [] };
const SOLD_OUT = { status: 'known', saleStatus: 'SOLD_OUT', soldOutTiers: ['tier-r', 'tier-s'] };
const LOADING = { status: 'loading' };
const RESTRICTED = { text: '예매가 제한되어 있습니다 · 소명 기한 10/27', appealHref: '/my/appeals/rst-1' };
const REASON = '이 회차의 선예매 대상이 아닙니다. 일반 예매는 11/21(토) 00:30에 시작합니다';
const SAME_ORDER = '로비 안에서는 언제 들어와도 순번이 같습니다';
const VERIFY_PURPOSE = '휴대폰 본인확인은 계정당 한 번만 합니다. 한 사람은 한 계정으로만 예매할 수 있습니다';

/** 빠진 칸과 undefined 칸을 같게 본다 */
const norm = (m) => JSON.parse(JSON.stringify(m));
const cta = (o = {}) => norm(bookingCta({ phase: 'queue', data: DATA, now: NOW, personal: null, restricted: null, eligibility: null, live: ON_SALE, queueHref: QUEUE_HREF, ...o }));

const ENDED = { special: 'ended', endedText: '판매가 끝난 회차입니다', meta: '12/24(목) 19:00 · 판매가 끝난 회차입니다', more: { label: '다른 회차', href: '/events/e3' } };
const CANCELLED = { special: 'ended', endedText: '취소된 회차입니다', meta: '12/24(목) 19:00 · 취소된 회차입니다', more: { label: '다른 회차', href: '/events/e3' } };
const LOAD = { special: 'load', meta: '12/24(목) 19:00' };
const QUEUE = { meta: '12/24(목) 19:00 · 판매 중', primary: { type: 'enter', label: '대기열 들어가기' }, minW: 240 };

// ── T9 ──
test('SCR-002 예매 버튼 차례: 판매 종료·취소 > 매진 > 개인 받는 중 > 로그인 > 예매 제한 > 가입 > 본인확인 > 판매 자격 없음 > 시각 상태', () => {
  const all = { personal: 'login', restricted: RESTRICTED, eligibility: { reason: REASON } };
  // 판매 종료·취소 > 매진(과 그 밖 모든 덮기)
  assert.deepEqual(cta({ phase: 'ended', live: SOLD_OUT, ...all }), ENDED, '판매 종료 > 매진');
  assert.deepEqual(cta({ phase: 'cancelled', live: SOLD_OUT, ...all }), CANCELLED, '취소 > 매진');
  // 상태 파일 ENDED는 시각 판정보다 앞서는 판매 종료 줄
  assert.deepEqual(cta({ phase: 'queue', live: { status: 'known', saleStatus: 'ENDED', soldOutTiers: [] }, ...all }), ENDED, '상태 파일 ENDED');
  // 매진 > 개인 받는 중
  assert.equal(cta({ live: SOLD_OUT, personal: 'loading' }).special, 'soldOut', '매진 > 개인 받는 중');
  // 개인 받는 중 > 예매 제한
  assert.deepEqual(cta({ personal: 'loading', restricted: RESTRICTED }), LOAD, '개인 받는 중 > 예매 제한');
  // 로그인 > 예매 제한
  assert.deepEqual(cta({ personal: 'login', restricted: RESTRICTED }).primary, { type: 'link', label: '로그인하고 입장', href: DATA.loginHref }, '로그인 > 예매 제한');
  // 로그인 > 판매 자격 없음
  assert.deepEqual(cta({ personal: 'login', eligibility: { reason: REASON } }).primary, { type: 'link', label: '로그인하고 입장', href: DATA.loginHref }, '로그인 > 판매 자격 없음');
  // 예매 제한 > 가입
  assert.equal(cta({ personal: 'signup', restricted: RESTRICTED }).endedText, RESTRICTED.text, '예매 제한 > 가입');
  assert.deepEqual(cta({ personal: 'signup', restricted: 'loading' }), LOAD, '예매 제한 받는 중 > 가입');
  // 예매 제한 > 판매 자격 없음
  assert.equal(cta({ restricted: RESTRICTED, eligibility: { reason: REASON } }).endedText, RESTRICTED.text, '예매 제한 > 판매 자격 없음');
  // 가입 > 판매 자격 없음
  assert.deepEqual(cta({ personal: 'signup', eligibility: { reason: REASON } }).primary, { type: 'link', label: '가입을 마치고 입장', href: DATA.signupHref }, '가입 > 판매 자격 없음');
  // 본인확인 > 판매 자격 없음
  assert.deepEqual(cta({ personal: 'verify', eligibility: { reason: REASON } }).primary, { type: 'verify', label: '휴대폰 본인확인' }, '본인확인 > 판매 자격 없음');
  // 판매 자격 없음 > 시각 상태
  const m = cta({ eligibility: { reason: REASON } });
  assert.deepEqual([m.primary, m.desc], [{ type: 'disabled', label: '대기열 들어가기' }, REASON], '판매 자격 없음 > 시각 상태');
  // 판매 자격을 받는 동안은 뼈대
  assert.deepEqual(cta({ eligibility: 'loading' }), LOAD, '판매 자격 받는 중');
});

// ── T10 ──
test('SCR-002 회차 매진: 특수 모양 soldOut이고 ( 다른 회차 › )는 다음 판매 중 회차, 대기열 버튼·오픈 알림·제한 글·자격 없음은 없다', () => {
  const m = cta({ live: SOLD_OUT, restricted: RESTRICTED, eligibility: { reason: REASON } });
  assert.equal(m.special, 'soldOut');
  assert.deepEqual(m.more, { label: '다른 회차', href: '/events/e3' }, '판매 종료(e0)·취소(e2) 회차를 건너뛴다');
  assert.equal(m.primary, undefined, '대기열 버튼 없음');
  assert.equal(m.alert, undefined, '오픈 알림 없음');
  assert.equal(m.desc, undefined, '자격 없음 이유 글 없음');
  const text = JSON.stringify(m);
  assert.ok(!text.includes('예매가 제한'), '제한 글 없음');
  assert.ok(!text.includes('선예매 대상이 아닙니다'), '자격 없음 글 없음');
  // 다른 판매 중 회차가 없으면 대신 갈 곳
  const only = { ...DATA, rounds: ROUNDS.slice(0, 3) };
  assert.deepEqual(cta({ data: only, live: SOLD_OUT }).more, { label: '다른 회차', href: '/productions/p1' });
  // 개인 상태(로그인·본인확인)도 보이지 않는다(살 수 있는 때가 없다)
  for (const personal of ['login', 'verify', 'signup']) assert.equal(cta({ live: SOLD_OUT, personal }).special, 'soldOut', personal);
});

test('SCR-002 ALL_HELD·PAUSED·TIER_SOLD_OUT·모름은 대기열 버튼 그대로', () => {
  for (const saleStatus of ['ON_SALE', 'ALL_HELD', 'PAUSED', 'TIER_SOLD_OUT']) assert.deepEqual(cta({ live: { status: 'known', saleStatus, soldOutTiers: ['tier-r'] } }), QUEUE, saleStatus);
  assert.deepEqual(cta({ live: { status: 'unknown' } }), QUEUE, '모름(실패)');
  assert.deepEqual(cta({ live: LOADING }), QUEUE, '받기 전');
});

// ── T11 ──
test('[FE-T18] 자격 없음 버튼: 로비가 있는 공연의 오픈 전은 \'로비 입장\', 선착순 오픈 전·오픈 뒤는 \'대기열 들어가기\'이고 모두 비활성(type disabled)과 이유 글(desc)이 함께이며, 오픈 전이면 오픈 알림 토글을 둔다', () => {
  const no = { eligibility: { reason: REASON }, live: LOADING };
  for (const phase of ['closed', 'notYet', 'lobby']) {
    const m = cta({ phase, ...no });
    assert.deepEqual([m.primary, m.desc, Boolean(m.alert)], [{ type: 'disabled', label: '로비 입장' }, REASON, true], phase);
  }
  const f = cta({ phase: 'fifo', data: FIFO, ...no });
  assert.deepEqual([f.primary, f.desc, Boolean(f.alert)], [{ type: 'disabled', label: '대기열 들어가기' }, REASON, true], 'fifo');
  for (const data of [DATA, FIFO]) {
    const q = cta({ phase: 'queue', data, eligibility: { reason: REASON } });
    assert.deepEqual([q.primary, q.desc, q.alert], [{ type: 'disabled', label: '대기열 들어가기' }, REASON, undefined], `queue hasLobby=${data.hasLobby}`);
  }
  // 이유 글은 받은 글 그대로(일반 조각이 없으면 첫 문장만)
  assert.equal(cta({ eligibility: { reason: '이 회차의 선예매 대상이 아닙니다' } }).desc, '이 회차의 선예매 대상이 아닙니다');
});

test("[FE-T18] pending에서도 자격 없음은 '로비 입장' 비활성 + 이유 글 + 오픈 알림 토글(closed·notYet·lobby와 같은 모양)", () => {
  // 계획 '시험 뒤 정한 것' S3, ADR-0272 결정 3 '자격 없음' 끝
  const m = cta({ phase: 'pending', live: LOADING, eligibility: { reason: REASON } });
  assert.deepEqual([m.primary, m.desc, Boolean(m.alert)], [{ type: 'disabled', label: '로비 입장' }, REASON, true]);
  for (const phase of ['closed', 'notYet', 'lobby']) {
    const o = cta({ phase, live: LOADING, eligibility: { reason: REASON } });
    assert.deepEqual([o.primary, o.desc], [m.primary, m.desc], `${phase}와 같은 모양(깜빡이지 않는다)`);
  }
  // 자격을 받는 동안·모름의 pending은 지금처럼 뼈대
  assert.deepEqual(cta({ phase: 'pending', live: LOADING, eligibility: 'loading' }), LOAD, '받는 중');
  assert.deepEqual(cta({ phase: 'pending', live: LOADING, eligibility: null }), LOAD, '모름');
});

test('[FE-T18] 기존 상태(로비 닫힘·카운트다운·로비·선착순·오픈 뒤·판매 종료·취소·로그인·가입·본인확인·예매 제한)의 모양은 옮기기 전과 같다', () => {
  const pre = { live: LOADING };
  assert.deepEqual(cta({ phase: 'closed', ...pre }), { desc: '로비는 19:50에 열립니다', alert: {}, primary: { type: 'disabled', label: '로비 입장' }, minW: 200 });
  assert.deepEqual(cta({ phase: 'notYet', ...pre }), { desc: SAME_ORDER, alert: { iconOnlyBelowMd: true }, primary: { type: 'countdown' }, minW: 240 });
  assert.deepEqual(cta({ phase: 'lobby', ...pre }), { desc: SAME_ORDER, alert: {}, primary: { type: 'link', label: '로비 입장', href: QUEUE_HREF }, minW: 200 });
  assert.deepEqual(cta({ phase: 'fifo', data: FIFO, ...pre }), { desc: '대기열은 20:00에 열립니다', alert: {}, primary: { type: 'disabled', label: '대기열 들어가기' }, minW: 200 });
  assert.deepEqual(cta({ phase: 'queue' }), QUEUE);
  assert.deepEqual(cta({ phase: 'ended', live: LOADING }), ENDED);
  assert.deepEqual(cta({ phase: 'cancelled', live: LOADING }), CANCELLED);
  assert.deepEqual(cta({ phase: undefined, live: LOADING }), LOAD, '시각을 아직 모름');
  assert.deepEqual(cta({ phase: 'pending', live: LOADING }), LOAD, '이 기기의 열리는 시각을 아직 모름');
  // 로그인: 오픈 전은 로비 글과 오픈 알림, 오픈 뒤는 없음
  assert.deepEqual(cta({ phase: 'lobby', live: LOADING, personal: 'login' }), { meta: '12/24(목) 19:00 · 로비 19:50부터', alert: {}, primary: { type: 'link', label: '로그인하고 입장', href: DATA.loginHref }, minW: 200 });
  assert.deepEqual(cta({ personal: 'login' }), { meta: '12/24(목) 19:00', primary: { type: 'link', label: '로그인하고 입장', href: DATA.loginHref }, minW: 200 });
  assert.deepEqual(cta({ phase: 'lobby', live: LOADING, personal: 'signup' }), { meta: '12/24(목) 19:00 · 로비 19:50부터', alert: {}, primary: { type: 'link', label: '가입을 마치고 입장', href: DATA.signupHref }, minW: 200 });
  assert.deepEqual(cta({ phase: 'notYet', live: LOADING, personal: 'verify' }), { desc: VERIFY_PURPOSE, alert: { iconOnlyBelowMd: true }, primary: { type: 'verify', label: '휴대폰 본인확인' }, minW: 200 });
  assert.deepEqual(cta({ personal: 'verify' }), { desc: VERIFY_PURPOSE, primary: { type: 'verify', label: '휴대폰 본인확인' }, minW: 200 });
  assert.deepEqual(cta({ personal: 'loading' }), LOAD);
  // 예매 제한: 판매 종료 줄과 같은 모양(글 + ( 소명하기 › )), 소명 링크가 없으면 more 없음
  assert.deepEqual(cta({ restricted: RESTRICTED }), { special: 'ended', endedText: RESTRICTED.text, meta: `12/24(목) 19:00 · ${RESTRICTED.text}`, more: { label: '소명하기', href: '/my/appeals/rst-1' } });
  assert.deepEqual(cta({ restricted: { text: '예매가 제한되어 있습니다' } }), { special: 'ended', endedText: '예매가 제한되어 있습니다', meta: '12/24(목) 19:00 · 예매가 제한되어 있습니다' });
  assert.deepEqual(cta({ restricted: 'loading' }), LOAD);
});
