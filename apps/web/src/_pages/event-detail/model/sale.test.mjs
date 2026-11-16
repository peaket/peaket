// 공연 상세의 판매 단계·팬별 판매 자격·선예매 안내·명단 밖 알림(SCR-002, ADR-0272 결정 3·4, d5 §5.2 '판매 정책 자격 없음'·'선예매 대상', BUILD_ORDER HOT-346)
// 단언 값은 정본(ADR-0272·d5·openapi)의 글과 시각을 그대로 적는다. 코드의 상수를 가져오지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingCta } from './cta.ts';
import { toEventDetail } from './detail.ts';
import {
  deniedHashCleanUrl,
  deniedWindow,
  eligibilityGate,
  eligibilityJudgeAt,
  isDeniedHash,
  needsEligibility,
  presaleNotice,
  saleBoundaryAfter,
  toFanEligibility,
  toSalePhases,
} from './sale.ts';

const T = (iso) => Date.parse(iso);
const EV = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
// 오픈 11/20(금) 20:00 KST. 일반 예매는 KST 날짜가 바뀌는 UTC 15:00 뒤(11/21(토) 00:30 KST)에 시작한다
const OPEN = T('2026-11-20T11:00:00Z');
const GEN = T('2026-11-20T15:30:00Z');
const SALE_END = T('2026-12-23T10:00:00Z');
const P = { kind: 'PRESALE', startsAtMs: OPEN, endsAtMs: GEN, limit: 2 };
const G = { kind: 'GENERAL', startsAtMs: GEN, endsAtMs: SALE_END, limit: 3 };
const PHASES = [P, G];
const MEMBER = { status: 'member', me: { signupCompleted: true, verified: true } };
const fan = (eligible, phases = PHASES, lists = [{ name: '팬클럽 선예매', destroyAtMs: T('2026-12-24T10:00:00Z') }]) => ({
  status: 'known',
  phases: phases.map((p, i) => ({ ...p, eligible: Array.isArray(eligible) ? eligible[i] : p.kind === 'PRESALE' ? eligible : true })),
  lists,
});
const gate = (o = {}) => eligibilityGate({ phase: 'lobby', session: MEMBER, phases: PHASES, fan: fan(false), denied: null, openAtMs: OPEN, nowMs: OPEN - 5 * 60_000, ...o });
const NOT_TARGET = '이 회차의 선예매 대상이 아닙니다';
const REASON = '이 회차의 선예매 대상이 아닙니다. 일반 예매는 11/21(토) 00:30에 시작합니다';

// ── T1 ──
const iso = (ms) => new Date(ms).toISOString();
const apiPhase = (kind, s, e, limitPerPerson) => ({ kind, startsAt: s === undefined ? undefined : typeof s === 'number' ? iso(s) : s, endsAt: e === undefined ? undefined : typeof e === 'number' ? iso(e) : e, limitPerPerson });

test('SCR-002 판매 단계: salePhases를 시각 순 조각으로 바꾸고 틀린 조각(시각 없음·끝 ≤ 시작·모르는 종류·한도 0·11)은 버린다(한도 1·10은 남긴다)', () => {
  const early = T('2026-11-19T11:00:00Z');
  const last = SALE_END;
  const list = [
    apiPhase('GENERAL', GEN, SALE_END, 3),
    apiPhase('PRESALE', OPEN, GEN, 2),
    apiPhase('PRESALE', undefined, GEN, 2), // 시작 없음
    apiPhase('PRESALE', OPEN, undefined, 2), // 끝 없음
    apiPhase('PRESALE', 'not-a-date', GEN, 2), // 시작이 시각이 아님
    apiPhase('PRESALE', OPEN, OPEN, 2), // 끝 = 시작
    apiPhase('PRESALE', GEN, OPEN, 2), // 끝 < 시작
    apiPhase('VIP', OPEN, GEN, 2), // 모르는 종류
    apiPhase('presale', OPEN, GEN, 2), // 대소문자가 다른 종류
    apiPhase('PRESALE', OPEN, GEN, 0), // 한도 0
    apiPhase('PRESALE', OPEN, GEN, 11), // 한도 11
    apiPhase('GENERAL', last, last + 1, 10), // 한도 10, 끝 = 시작 + 1ms는 남긴다
    apiPhase('PRESALE', early, early + 60 * 60_000, 1), // 한도 1
  ];
  assert.deepEqual(toSalePhases(list), [
    { kind: 'PRESALE', startsAtMs: early, endsAtMs: early + 60 * 60_000, limit: 1 },
    { kind: 'PRESALE', startsAtMs: OPEN, endsAtMs: GEN, limit: 2 },
    { kind: 'GENERAL', startsAtMs: GEN, endsAtMs: SALE_END, limit: 3 },
    { kind: 'GENERAL', startsAtMs: last, endsAtMs: last + 1, limit: 10 },
  ]);
  assert.deepEqual(toSalePhases(undefined), []);
  assert.deepEqual(toSalePhases([]), []);
  // 계약의 maxItems 10: 시각 순으로 10개까지(거꾸로 넣어도 이른 10개)
  const hour = 60 * 60_000;
  const many = Array.from({ length: 12 }, (_, i) => apiPhase('GENERAL', OPEN + i * hour, OPEN + (i + 1) * hour, 4)).reverse();
  const got = toSalePhases(many);
  assert.equal(got.length, 10);
  assert.deepEqual(got.map((p) => p.startsAtMs), Array.from({ length: 10 }, (_, i) => OPEN + i * hour));
});

test('SCR-002 판매 단계: 공연 상세 값(toEventDetail)이 공개 요약의 salePhases를 조각으로 싣는다(없으면 빈 목록)', () => {
  const summary = (o = {}) => ({ eventId: EV, productionId: 'p1', title: 'LUMEN', startsAt: '2026-12-24T10:00:00Z', openAt: iso(OPEN), saleEndsAt: iso(SALE_END), ...o });
  assert.deepEqual(toEventDetail(summary({ salePhases: [apiPhase('GENERAL', GEN, SALE_END, 3), apiPhase('PRESALE', OPEN, GEN, 2)] })).salePhases, [P, G]);
  assert.deepEqual(toEventDetail(summary()).salePhases, []);
});

// ── T2 ──
test('SCR-002 팬별 판매 자격은 회원이고 끝나지 않은 PRESALE 조각이 있을 때만 부른다(endsAt = 지금은 끝남, 지금 + 1ms는 부른다, 비회원·받는 중·모름·GENERAL만은 부르지 않는다)', () => {
  assert.equal(needsEligibility(PHASES, MEMBER, OPEN - 60_000), true, '오픈 전');
  assert.equal(needsEligibility(PHASES, MEMBER, GEN - 1), true, 'PRESALE 끝 = 지금 + 1ms');
  assert.equal(needsEligibility(PHASES, MEMBER, GEN), false, 'PRESALE 끝 = 지금은 끝난 조각');
  for (const status of ['guest', 'loading', 'unknown']) assert.equal(needsEligibility(PHASES, { status }, OPEN - 60_000), false, status);
  assert.equal(needsEligibility([G], MEMBER, OPEN - 60_000), false, 'GENERAL만');
  assert.equal(needsEligibility([], MEMBER, OPEN - 60_000), false, '조각 없음');
});

// ── T3 ──
test('SCR-002 판정 시각: closed·pending·notYet·lobby·fifo는 오픈 시각, queue는 지금, ended·cancelled는 없음', () => {
  const now = OPEN - 7 * 60_000 - 123;
  for (const phase of ['closed', 'pending', 'notYet', 'lobby', 'fifo']) assert.equal(eligibilityJudgeAt(phase, OPEN, now), OPEN, phase);
  const after = OPEN + 42_000;
  assert.equal(eligibilityJudgeAt('queue', OPEN, after), after);
  for (const phase of ['ended', 'cancelled', undefined]) assert.equal(eligibilityJudgeAt(phase, OPEN, now), undefined, String(phase));
});

// ── T4 ──
test('[FE-T18] SCR-002 판매 정책 자격 없음: 판정 시각의 PRESALE 조각에서 eligible false면 "이 회차의 선예매 대상이 아닙니다. 일반 예매는 M/D(요일) HH:MM에 시작합니다"', () => {
  // 오픈 전(로비): 판정 시각 = 오픈 = PRESALE 시작 → 그 조각. 일반 조각 시작은 UTC 15:30 = KST 다음 날 00:30
  assert.deepEqual(gate(), { reason: REASON });
  for (const phase of ['closed', 'notYet', 'fifo']) assert.deepEqual(gate({ phase }), { reason: REASON }, phase);
  // 오픈 뒤: 판정 시각 = 지금
  assert.deepEqual(gate({ phase: 'queue', nowMs: OPEN + 60_000 }), { reason: REASON });
  // 판정 시각 = 조각 끝은 다음 조각(GENERAL)이라 덮지 않는다
  assert.equal(gate({ phase: 'queue', nowMs: GEN }), null);
  // 일반 조각이 없으면 첫 문장만
  assert.deepEqual(gate({ phases: [P], fan: fan(false, [P]) }), { reason: NOT_TARGET });
  // 판정 시각 '뒤'의 첫 GENERAL: 앞선 GENERAL이 아니라 지금 PRESALE 뒤의 것
  const h = 60 * 60_000;
  const P1 = { kind: 'PRESALE', startsAtMs: OPEN, endsAtMs: OPEN + h, limit: 2 };
  const G1 = { kind: 'GENERAL', startsAtMs: OPEN + h, endsAtMs: OPEN + 2 * h, limit: 4 };
  const P2 = { kind: 'PRESALE', startsAtMs: OPEN + 2 * h, endsAtMs: GEN, limit: 2 };
  const four = [P1, G1, P2, G];
  assert.deepEqual(gate({ phase: 'queue', phases: four, fan: fan([true, true, false, true], four), nowMs: OPEN + 2 * h + 60_000 }), { reason: REASON });
});

// ── T5 ──
test('SCR-002 자격 모름은 덮지 않는다: idle·none·조각 차례나 시각이 공개 요약과 다름·비회원은 null, 받는 중은 notYet·lobby·queue만 loading이고 closed·fifo는 null', () => {
  assert.equal(gate({ fan: { status: 'idle' } }), null, 'idle');
  assert.equal(gate({ fan: { status: 'none' } }), null, 'none(확인 못 함)');
  for (const phase of ['notYet', 'lobby']) assert.equal(gate({ phase, fan: { status: 'loading' } }), 'loading', phase);
  assert.equal(gate({ phase: 'queue', nowMs: OPEN + 60_000, fan: { status: 'loading' } }), 'loading', 'queue');
  for (const phase of ['closed', 'fifo']) assert.equal(gate({ phase, fan: { status: 'loading' } }), null, phase);
  // 팬 자격의 조각이 공개 요약과 다르면 모름
  const shifted = { ...P, startsAtMs: P.startsAtMs + 60_000 };
  assert.equal(gate({ fan: fan(false, [shifted, G]) }), null, '시작 시각이 다름');
  assert.equal(gate({ fan: fan(false, [{ ...P, endsAtMs: GEN + 1 }, G]) }), null, '끝 시각이 다름');
  assert.equal(gate({ fan: fan([false, false], [{ ...P, kind: 'GENERAL' }, G]) }), null, '종류가 다름');
  assert.equal(gate({ fan: fan([true, false], [G, P]) }), null, '차례가 다름');
  assert.equal(gate({ fan: fan(false, [G]) }), null, '조각 수가 다름');
  for (const status of ['guest', 'loading', 'unknown']) assert.equal(gate({ session: { status } }), null, `비회원 ${status}`);
  for (const phase of ['ended', 'cancelled', undefined]) assert.equal(gate({ phase }), null, `판정 시각 없음 ${phase}`);
});

test('[FE-T18] SCR-002 pending(이 기기의 로비 입장 시각을 모름)도 자격 없음이면 이유 글이고, 자격 받는 중·모름은 덮지 않는다(gate null)', () => {
  // 계획 '시험 뒤 정한 것' S3, ADR-0272 결정 3 '자격 없음' 끝: 판정 시각은 오픈 시각이라 열리는 시각과 상관없다
  assert.deepEqual(gate({ phase: 'pending' }), { reason: REASON });
  assert.equal(gate({ phase: 'pending', fan: { status: 'loading' } }), null, '받는 중');
  assert.equal(gate({ phase: 'pending', fan: { status: 'none' } }), null, '모름');
  assert.equal(gate({ phase: 'pending', fan: { status: 'idle' } }), null, '받기 전');
});

test('SCR-002 eligible true인 조각과 GENERAL 조각은 덮지 않는다', () => {
  assert.equal(gate({ fan: fan(true) }), null, '선예매 대상');
  // GENERAL 조각은 eligible false여도 덮지 않는다(선예매만 명단으로 막는다)
  assert.equal(gate({ phase: 'queue', nowMs: GEN + 60_000, fan: fan([false, false]) }), null);
});

// ── T6 ──
test('SCR-002 조각 경계에 다시 고른다: 일반 예매 시작 1ms 전은 자격 없음, 시작 시각에는 덮지 않는다(saleBoundaryAfter는 지금 뒤 가장 이른 startsAt·endsAt, 같은 시각은 지난 것)', () => {
  assert.deepEqual(gate({ phase: 'queue', nowMs: GEN - 1 }), { reason: REASON });
  assert.equal(gate({ phase: 'queue', nowMs: GEN }), null);
  assert.equal(saleBoundaryAfter(PHASES, OPEN - 1), OPEN);
  assert.equal(saleBoundaryAfter(PHASES, OPEN), GEN, '같은 시각은 지난 것');
  assert.equal(saleBoundaryAfter(PHASES, GEN - 1), GEN);
  assert.equal(saleBoundaryAfter(PHASES, GEN), SALE_END);
  assert.equal(saleBoundaryAfter(PHASES, SALE_END), undefined);
  assert.equal(saleBoundaryAfter([], OPEN), undefined);
  // 조각 사이가 비면 다음 조각의 시작
  const gapStart = GEN + 10 * 60_000;
  assert.equal(saleBoundaryAfter([P, { ...G, startsAtMs: gapStart }], GEN + 1), gapStart);
});

// ── T7 ──
test('SCR-002 선예매 대상 안내: 명단 이름(\' · \'로 이음)·가장 이른 대상 조각의 시작과 한도·판매자 상호·가장 늦은 파기 날짜 글', () => {
  const h = 60 * 60_000;
  const P1 = { kind: 'PRESALE', startsAtMs: OPEN, endsAtMs: OPEN + h, limit: 2 };
  const G1 = { kind: 'GENERAL', startsAtMs: OPEN + h, endsAtMs: OPEN + 2 * h, limit: 4 };
  const P2 = { kind: 'PRESALE', startsAtMs: OPEN + 2 * h, endsAtMs: GEN, limit: 3 }; // 11/20(금) 22:00 KST
  const phases = [P1, G1, P2, G];
  // 파기 예정: 12/24 19:00 KST와 12/25 00:30 KST(UTC 15:30) 가운데 늦은 것
  const lists = [
    { name: '팬클럽 선예매', destroyAtMs: T('2026-12-24T15:30:00Z') },
    { name: '멤버십', destroyAtMs: T('2026-12-24T10:00:00Z') },
  ];
  const f = fan([true, true, true, true], phases, lists);
  assert.deepEqual(presaleNotice({ fan: f, sellerName: '(주)피켓공연', nowMs: OPEN - h }), {
    lead: '팬클럽 선예매 · 멤버십 선예매 대상입니다. 11/20(금) 20:00부터 1인 2매까지 예매할 수 있습니다',
    notice: '판매자((주)피켓공연)가 보낸 팬클럽 선예매 · 멤버십 명단에 회원님이 있습니다. 이 명단은 선예매 자격 확인에만 쓰고, 이 공연의 판매 기간이 끝나고 1일 뒤(12/25) 지웁니다',
  });
  // 첫 대상 조각이 끝났으면(끝 = 지금) 다음 대상 조각의 시작과 한도
  assert.equal(presaleNotice({ fan: f, sellerName: '(주)피켓공연', nowMs: OPEN + h }).lead, '팬클럽 선예매 · 멤버십 선예매 대상입니다. 11/20(금) 22:00부터 1인 3매까지 예매할 수 있습니다');
  // 판매자 상호가 없으면 "판매자가 보낸"
  assert.equal(
    presaleNotice({ fan: f, sellerName: '', nowMs: OPEN - h }).notice,
    '판매자가 보낸 팬클럽 선예매 · 멤버십 명단에 회원님이 있습니다. 이 명단은 선예매 자격 확인에만 쓰고, 이 공연의 판매 기간이 끝나고 1일 뒤(12/25) 지웁니다',
  );
  // 명단이 없으면 이름은 '판매 자격'
  const noList = presaleNotice({ fan: fan([true, true, true, true], phases, []), sellerName: '(주)피켓공연', nowMs: OPEN - h });
  assert.equal(noList.lead, '판매 자격 선예매 대상입니다. 11/20(금) 20:00부터 1인 2매까지 예매할 수 있습니다');
  // 명단이 없으면 파기 날짜를 모르므로 괄호째 뺀다(d5 §5.2 글 그대로, ADR-0272 결정 3, 계획 '시험 뒤 정한 것' S1)
  assert.equal(noList.notice, '판매자((주)피켓공연)가 보낸 판매 자격 명단에 회원님이 있습니다. 이 명단은 선예매 자격 확인에만 쓰고, 이 공연의 판매 기간이 끝나고 1일 뒤 지웁니다');
  // 안내가 없는 때: 대상 조각이 모두 끝남 · eligible false만 · GENERAL만 대상 · 모름·받는 중·받기 전
  assert.equal(presaleNotice({ fan: f, sellerName: '(주)피켓공연', nowMs: GEN }), null, '대상 조각이 모두 끝남');
  assert.equal(presaleNotice({ fan: fan(false), sellerName: '(주)피켓공연', nowMs: OPEN - h }), null, 'eligible false만');
  assert.equal(presaleNotice({ fan: fan([false, true]), sellerName: '(주)피켓공연', nowMs: OPEN - h }), null, 'GENERAL만 대상');
  for (const status of ['none', 'loading', 'idle']) assert.equal(presaleNotice({ fan: { status }, sellerName: '(주)피켓공연', nowMs: OPEN - h }), null, status);
});

// ── T8 ──
test('[Q-T36 ⑧] 공연 상세: 주소 조각은 정확히 #sale-eligibility-required만 명단 밖 알림을 켠다(#Sale-…·뒤 글자·빈 조각은 끈다)', () => {
  assert.equal(isDeniedHash('#sale-eligibility-required'), true);
  for (const h of ['#Sale-eligibility-required', '#SALE-ELIGIBILITY-REQUIRED', '#sale-eligibility-required-x', '#sale-eligibility-required ', '#sale-eligibility-required&x=1', 'sale-eligibility-required', '#sale-eligibility', '#', '']) {
    assert.equal(isDeniedHash(h), false, JSON.stringify(h));
  }
});

// ── 리뷰 지적 R040-2 재현(계획 '리뷰 뒤 정한 것' RV6~RV8, ADR-0272 결정 4 바로잡음): 명단 밖 알림은 켤 때 정한 창 안에서만 덮는다 ──
const CTA_DATA = {
  eventId: EV,
  roundLabel: '12/24(목) 19:00',
  lobbyText: '19:50',
  openTimeText: '20:00',
  rounds: [{ eventId: EV, href: `/events/${EV}`, label: '12/24(목) 19:00', current: true, openAtMs: OPEN, saleEndsAtMs: SALE_END, status: 'SCHEDULED' }],
  loginHref: '/login',
  signupHref: '/signup/complete',
  otherRoundFallbackHref: '/productions/p1',
  hasLobby: true,
};
/** 부르는 쪽 바깥 경계: 판정(eligibilityGate)의 결과를 예매 버튼(bookingCta)에 넣는다 */
const ctaWith = (eligibility, nowMs) =>
  bookingCta({ phase: 'queue', data: CTA_DATA, now: nowMs, personal: null, restricted: null, eligibility, live: { status: 'known', saleStatus: 'ON_SALE', soldOutTiers: [] }, queueHref: 'https://queue.peaket.example/e1' });

test('[R040-2][Q-T36 ⑧] 오픈 전 로비 403으로 켠 명단 밖 알림: 창은 오픈 시각이 든 PRESALE 조각의 끝까지이고, 일반 예매 시작 1ms 전 bookingCta는 비활성 \'대기열 들어가기\'와 이유 글, 시작 시각에는 [대기열 들어가기]다', () => {
  // 창(오픈 시각이 든 PRESALE의 끝 = 일반 예매 시작). 팬 자격은 일부러 대상(eligible true)이다(사본 없음·설정 틀림, Q-T36 ⑨)
  const win = { untilMs: GEN };
  const g = (o) => gate({ fan: fan(true), denied: win, ...o });
  assert.deepEqual(g({ phase: 'lobby', nowMs: OPEN - 60_000 }), { reason: REASON }, '오픈 1분 전 로비');
  const before = g({ phase: 'queue', nowMs: GEN - 1 });
  assert.deepEqual(before, { reason: REASON }, '일반 예매 시작 1ms 전');
  assert.deepEqual(ctaWith(before, GEN - 1).primary, { type: 'disabled', label: '대기열 들어가기' });
  assert.equal(ctaWith(before, GEN - 1).desc, REASON);
  const at = g({ phase: 'queue', nowMs: GEN });
  assert.equal(at, null, '일반 예매 시작 시각에는 덮지 않는다(새로고침 없이 버튼이 돌아온다)');
  assert.deepEqual(ctaWith(at, GEN).primary, { type: 'enter', label: '대기열 들어가기' });
  assert.equal(saleBoundaryAfter(PHASES, GEN - 1), GEN, '그 시각에 다시 고른다');
  // 창을 정하는 함수: 오픈 10분 전(로비)에 켜면 판정 시각 = 오픈 시각이 든 PRESALE의 끝
  assert.deepEqual(deniedWindow(PHASES, OPEN, OPEN - 10 * 60_000), { untilMs: GEN });
});

test('[R040-2][Q-T36 ⑧] 오픈 뒤 진입 403으로 켠 알림의 창은 지금이 든 PRESALE 조각의 끝까지이고, 이유 글의 일반 예매 시각은 판정 시각 뒤 첫 GENERAL이다', () => {
  assert.deepEqual(deniedWindow(PHASES, OPEN, OPEN + 5 * 60_000), { untilMs: GEN });
  assert.deepEqual(deniedWindow(PHASES, OPEN, GEN - 1), { untilMs: GEN }, 'PRESALE 끝 1ms 전에 켬');
  // 팬 자격과 상관없이(대상·모름) 창 안이면 자격 없음
  for (const f of [fan(true), { status: 'none' }, { status: 'idle' }]) assert.deepEqual(gate({ phase: 'queue', nowMs: OPEN + 5 * 60_000, fan: f, denied: { untilMs: GEN } }), { reason: REASON }, f.status);
  // 조각 넷: 두 번째 PRESALE 안에서 켜면 그 끝까지이고, 이유 글은 앞선 GENERAL이 아니라 판정 시각 뒤 첫 GENERAL(11/21(토) 00:30)
  const h = 60 * 60_000;
  const P1 = { kind: 'PRESALE', startsAtMs: OPEN, endsAtMs: OPEN + h, limit: 2 };
  const G1 = { kind: 'GENERAL', startsAtMs: OPEN + h, endsAtMs: OPEN + 2 * h, limit: 4 };
  const P2 = { kind: 'PRESALE', startsAtMs: OPEN + 2 * h, endsAtMs: GEN, limit: 2 };
  const four = [P1, G1, P2, G];
  const read = OPEN + 2 * h + 60_000;
  const win = deniedWindow(four, OPEN, read);
  assert.deepEqual(win, { untilMs: GEN });
  assert.deepEqual(gate({ phase: 'queue', phases: four, fan: fan(true, four), denied: win, nowMs: read }), { reason: REASON });
});

test('[R040-2] 판정 시각의 조각이 GENERAL이거나 없을 때 창은 켠 시각 뒤 첫 조각 경계까지, 공개 요약에 조각이 없으면 문서 동안', () => {
  const X = GEN + 3 * 60 * 60_000;
  const Gs = { kind: 'GENERAL', startsAtMs: GEN, endsAtMs: X, limit: 3 };
  const P3 = { kind: 'PRESALE', startsAtMs: X, endsAtMs: SALE_END, limit: 2 };
  const three = [P, Gs, P3];
  // GENERAL 안에서 켠 창 { untilMs: X }: 경계 1ms 전은 자격 없음, 경계에서 null
  const win = { untilMs: X };
  assert.deepEqual(gate({ phase: 'queue', phases: three, fan: fan(true, three), denied: win, nowMs: X - 1 }), { reason: NOT_TARGET }, '경계 1ms 전(뒤에 GENERAL이 없어 첫 문장만)');
  assert.equal(gate({ phase: 'queue', phases: three, fan: fan(true, three), denied: win, nowMs: X }), null, '경계에서 꺼진다');
  // 창을 정하는 함수: GENERAL 안에서 켬 → 다음 경계(X)
  assert.deepEqual(deniedWindow(three, OPEN, GEN + 60_000), { untilMs: X });
  // 조각 사이 빈 시각에서 켬 → 다음 조각 시작
  const gapStart = GEN + 10 * 60_000;
  const gapped = [P, { ...G, startsAtMs: gapStart }];
  assert.deepEqual(deniedWindow(gapped, OPEN, GEN + 60_000), { untilMs: gapStart });
  // 공개 요약에 조각이 없으면 문서 동안(untilMs 없음): 30일 뒤에도 자격 없음
  const none = deniedWindow([], OPEN, OPEN + 60_000);
  assert.equal(none.untilMs, undefined);
  assert.deepEqual(gate({ phase: 'queue', phases: [], fan: { status: 'none' }, denied: none, nowMs: OPEN + 30 * 24 * 60 * 60_000 }), { reason: NOT_TARGET });
  // 판매 종료면 판정 시각이 없어 덮지 않는다
  assert.equal(gate({ phase: 'ended', fan: fan(true), denied: { untilMs: GEN }, nowMs: OPEN + 60_000 }), null);
});

// ── 검증에서 살아남은 틀린 구현을 잡는 시험(계획 '검증 뒤 정한 것' VV1~VV3, ADR-0272 결정 3·4 바로잡음) ──
test('[V040-34][Q-T36 ⑧] 오픈 전에 켠 명단 밖 알림이고 일반 예매가 오픈 시각에 바로 시작하면 이유 글은 "이 회차의 선예매 대상이 아닙니다. 일반 예매는 {오픈 시각 M/D(요일) HH:MM}에 시작합니다"다', () => {
  const h = 60 * 60_000;
  const early = [
    { kind: 'PRESALE', startsAtMs: OPEN - h, endsAtMs: OPEN, limit: 2 },
    { kind: 'GENERAL', startsAtMs: OPEN, endsAtMs: SALE_END, limit: 3 },
  ];
  const win = deniedWindow(early, OPEN, OPEN - 10 * 60_000);
  assert.deepEqual(win, { untilMs: OPEN }, '창은 오픈 시각(판정 시각의 GENERAL이라 켠 시각 뒤 첫 경계)');
  // 판정 시각(오픈)과 같은 시각에 시작하는 GENERAL을 고른다: 오픈 11/20(금) 20:00 KST
  assert.deepEqual(gate({ phase: 'lobby', phases: early, fan: fan(true, early), denied: win, nowMs: OPEN - 60_000 }), {
    reason: '이 회차의 선예매 대상이 아닙니다. 일반 예매는 11/20(금) 20:00에 시작합니다',
  });
  // 창 끝(지금 = 오픈)이면 덮지 않는다
  for (const phase of ['queue', 'lobby']) assert.equal(gate({ phase, phases: early, fan: fan(true, early), denied: win, nowMs: OPEN }), null, phase);
});

test('[V040-34] 이유 글은 지금이 아니라 판정 시각으로 고른다: 오픈 전에는 오픈 시각 뒤 첫 GENERAL이다', () => {
  const h = 60 * 60_000;
  // 오픈 전 조각이 섞인 공개 조각(계약 밖이지만 toSalePhases가 받는 모양)
  const mixed = [
    { kind: 'GENERAL', startsAtMs: OPEN - 2 * h, endsAtMs: OPEN - h, limit: 4 },
    { kind: 'PRESALE', startsAtMs: OPEN, endsAtMs: GEN, limit: 2 },
    { kind: 'GENERAL', startsAtMs: GEN, endsAtMs: SALE_END, limit: 3 },
  ];
  // 지금 = 오픈 − 3시간이고 판정 시각 = 오픈. 지금 뒤 첫 GENERAL(오픈 − 2시간 = 11/20(금) 18:00)이 아니라 G(11/21(토) 00:30)
  assert.deepEqual(gate({ phase: 'closed', phases: mixed, fan: fan([true, false, true], mixed), nowMs: OPEN - 3 * h }), { reason: REASON });
  // 판정 시각이 이미 시작한 GENERAL 안이고 뒤 GENERAL이 없으면(명단 밖 알림, queue) 첫 문장만
  assert.deepEqual(gate({ phase: 'queue', fan: fan(true), denied: { untilMs: SALE_END }, nowMs: GEN + h }), { reason: NOT_TARGET });
});

test('[V040-28][Q-T36 ⑧] 명단 밖 조각을 지운 주소는 경로와 쿼리를 남기고 조각만 뺀다(다른 조각·대소문자·뒤 글자·빈 조각은 null)', () => {
  const H = '#sale-eligibility-required';
  assert.equal(deniedHashCleanUrl({ pathname: '/events/e1', search: '?ref=a', hash: H }), '/events/e1?ref=a');
  assert.equal(deniedHashCleanUrl({ pathname: '/events/e1', search: '', hash: H }), '/events/e1');
  for (const hash of ['#Sale-eligibility-required', '#SALE-ELIGIBILITY-REQUIRED', '#sale-eligibility-required-x', '#sale-eligibility-required ', '#sale-eligibility-required&x=1', 'sale-eligibility-required', '#sale-eligibility', '#', '']) {
    assert.equal(deniedHashCleanUrl({ pathname: '/events/e1', search: '?ref=a', hash }), null, JSON.stringify(hash));
  }
});

// toFanEligibility는 T16(가게)에서 바깥 경계로 본다. 여기서는 모양 틀림이 none인지만
test('SCR-002 팬별 판매 자격 본문의 모양이 틀리면 자격 모름(none)', () => {
  for (const body of [null, undefined, 'x', {}, { phases: 'x', lists: [] }, { phases: [], lists: 'x' }]) assert.deepEqual(toFanEligibility(body), { status: 'none' }, JSON.stringify(body));
});
