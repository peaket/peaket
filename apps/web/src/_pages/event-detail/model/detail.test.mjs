// 공연 상세 응답 → 화면 값(SCR-002, d5 §5.2, openapi EventPublicSummary, ADR-0200, BUILD_ORDER HOT-311)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingPhase, roundBadge, tierBadge, toEventDetail } from './detail.ts';

const EV = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const api = (o = {}) => ({
  eventId: EV,
  productionId: '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4d01',
  title: 'LUMEN 콘서트 2026 서울',
  startsAt: '2026-12-24T10:00:00.000Z', // 12/24(목) 19:00 KST
  sellerName: '(주)피켓공연',
  genre: '콘서트',
  ageRating: '만 7세 이상',
  runningMinutes: 150,
  posterUrl: 'https://img.peaket.example/posters/lumen',
  posterAlt: 'LUMEN 포스터',
  descriptionText: '첫 문단입니다.\n\n둘째 문단\n  \n셋째 문단 <b>굵게</b>',
  detailImages: [{ url: 'https://img.peaket.example/d/1', alt: '출연진 소개' }],
  artists: [{ artistId: 'a1', name: '루멘' }, { name: '' }],
  placeId: 'pl-1',
  placeName: '피켓 아레나',
  placeAddress: '서울 어딘가 1',
  openAt: '2026-11-20T11:00:00.000Z', // 11/20(금) 20:00
  lobbyOpensAt: '2026-11-20T10:50:00.000Z', // 19:50
  entryOpensAt: '2026-12-24T09:30:00.000Z', // 18:30
  endsAt: '2026-12-24T12:30:00.000Z',
  saleEndsAt: '2026-12-23T10:00:00.000Z',
  status: 'SCHEDULED',
  queueOrder: 'HYBRID',
  seatAssignment: 'PICK',
  perPersonLimit: 4,
  reentryAllowed: false,
  badges: ['HYBRID', 'PRESALE'],
  rounds: [
    { eventId: EV, startsAt: '2026-12-24T10:00:00.000Z', openAt: '2026-11-20T11:00:00.000Z', saleEndsAt: '2026-12-23T10:00:00.000Z', status: 'SCHEDULED' },
    { eventId: 'e2', startsAt: '2026-12-25T10:00:00.000Z', openAt: '2026-11-21T11:00:00.000Z', saleEndsAt: '2026-12-24T10:00:00.000Z', status: 'SCHEDULED' },
  ],
  priceTiers: [
    { tierId: 'r', name: 'R석', price: 154000 },
    { tierId: 's', name: 'S석', price: 132000 },
    { name: '이름 없는 ID 없음' },
  ],
  seller: { legalName: '(주)피켓공연', representative: '김피켓', address: '서울 어딘가 1', phone: '02-0000-0000', email: 'seller@peaket.example', businessRegNo: '000-00-00000', mailOrderReportNo: '2026-서울-0000' },
  ...o,
});

test('[ASVS v5.0.0-1.2.1] 공연 상세 응답을 한국 시각 글과 화면 값으로 바꾼다(설명 글은 줄 단위 문단의 글자로만)', () => {
  const d = toEventDetail(api());
  assert.equal(d.eventId, EV);
  assert.equal(d.title, 'LUMEN 콘서트 2026 서울');
  assert.equal(d.roundLabel, '12/24(목) 19:00');
  assert.equal(d.openText, '11/20(금) 20:00');
  assert.equal(d.lobbyText, '19:50');
  assert.equal(d.openTimeText, '20:00');
  assert.equal(d.infoLine, '피켓 아레나 · 150분 · 만 7세 이상');
  // 양도 마감: 공연 시작 2시간 전(17:00)과 입장 시작(18:30) 중 이른 때
  assert.equal(d.transferDeadlineText, '12/24(목) 17:00');
  // 문단: 빈 줄로 나누고 앞뒤 공백·빈 문단은 버린다. 태그 모양 글자도 글자 그대로다(HTML로 그리지 않는다)
  assert.deepEqual(d.description, ['첫 문단입니다.', '둘째 문단', '셋째 문단 <b>굵게</b>']);
  assert.equal(d.hasDetail, true);
  assert.deepEqual(d.artists, ['루멘']);
  assert.deepEqual(d.tiers, [{ id: 'r', name: 'R석', price: 154000 }, { id: 's', name: 'S석', price: 132000 }]);
  assert.equal(d.sortMode, 'HYBRID');
  assert.equal(d.seatMode, 'PICK');
  assert.equal(d.presale, true);
  assert.equal(d.perPersonLimit, 4);
  assert.equal(d.seller.legalName, '(주)피켓공연');
  assert.equal(d.place.name, '피켓 아레나');
  assert.deepEqual(d.rounds.map((r) => [r.eventId, r.label, r.current, r.href]), [
    [EV, '12/24(목) 19:00', true, `/events/${EV}`],
    ['e2', '12/25(금) 19:00', false, '/events/e2'],
  ]);
});

test('화면에 꼭 필요한 칸(회차·공연·공연명·시작·오픈·판매 종료)이 없거나 시각이 틀리면 그리지 않는다', () => {
  for (const k of ['eventId', 'productionId', 'title', 'startsAt', 'openAt', 'saleEndsAt']) assert.equal(toEventDetail(api({ [k]: undefined })), undefined, k);
  assert.equal(toEventDetail(api({ openAt: 'not-a-date' })), undefined);
});

test('빠진 칸은 화면의 기본값이다: 회차 목록이 없으면 이 회차만, 로비가 없으면(선착순) 로비 글 없음, 판매자 정보가 없으면 상호만', () => {
  const d = toEventDetail(api({ rounds: undefined, lobbyOpensAt: null, queueOrder: 'FIFO', seller: undefined, descriptionText: '', detailImages: [], ageRating: undefined, runningMinutes: undefined, entryOpensAt: null }));
  assert.deepEqual(d.rounds.map((r) => r.eventId), [EV]);
  assert.equal(d.lobbyText, undefined);
  assert.equal(d.sortMode, 'FIFO');
  assert.equal(d.seller, undefined);
  assert.equal(d.sellerName, '(주)피켓공연');
  assert.equal(d.hasDetail, false);
  assert.equal(d.infoLine, '피켓 아레나');
  assert.equal(d.transferDeadlineText, '12/24(목) 17:00');
  // 회차 목록에 이 회차가 빠져 있으면 넣고 시작 순으로 둔다
  const e = toEventDetail(api({ rounds: [api().rounds[1]] }));
  assert.deepEqual(e.rounds.map((r) => r.eventId), [EV, 'e2']);
});

const T = (iso) => Date.parse(iso);
const D = toEventDetail(api());

test('예매 버튼 상태는 시각으로 고른다: 로비 전 → 로비 열림(이 기기 열리는 시각 전·뒤) → 오픈 뒤 → 판매 종료', () => {
  const unlock = T('2026-11-20T10:50:42Z');
  assert.deepEqual(bookingPhase(D, T('2026-11-20T10:00:00Z'), unlock), { phase: 'closed', nextAt: T('2026-11-20T10:50:00Z') });
  assert.deepEqual(bookingPhase(D, T('2026-11-20T10:50:10Z'), unlock), { phase: 'notYet', nextAt: unlock });
  assert.deepEqual(bookingPhase(D, T('2026-11-20T10:55:00Z'), unlock), { phase: 'lobby', nextAt: T('2026-11-20T11:00:00Z') });
  assert.deepEqual(bookingPhase(D, T('2026-11-20T11:00:00Z'), unlock), { phase: 'queue', nextAt: T('2026-12-23T10:00:00Z') });
  assert.deepEqual(bookingPhase(D, T('2026-12-23T10:00:00Z'), unlock), { phase: 'ended' });
  // 로비 시간 안에서 이 기기의 열리는 시각을 아직 모르면 뼈대(비활성 버튼이 잠깐 비치지 않게)
  assert.deepEqual(bookingPhase(D, T('2026-11-20T10:55:00Z'), undefined), { phase: 'pending', nextAt: T('2026-11-20T11:00:00Z') });
  assert.equal(bookingPhase(D, T('2026-11-20T10:00:00Z'), undefined).phase, 'closed', '로비 전에는 열리는 시각과 상관없다');
});

test('선착순(로비 없음)은 오픈 전 비활성 대기열 버튼, 취소된 회차는 판매 종료 모양이다', () => {
  const f = toEventDetail(api({ queueOrder: 'FIFO', lobbyOpensAt: null }));
  assert.deepEqual(bookingPhase(f, T('2026-11-20T10:55:00Z'), undefined), { phase: 'fifo', nextAt: T('2026-11-20T11:00:00Z') });
  assert.equal(bookingPhase(f, T('2026-11-20T11:00:01Z'), undefined).phase, 'queue');
  const c = toEventDetail(api({ status: 'CANCELLED' }));
  assert.deepEqual(bookingPhase(c, T('2026-11-20T10:00:00Z'), undefined), { phase: 'cancelled' });
});

test('등급 배지: 오픈 전 <오픈 예정>, 판매 중은 실시간 출처가 없어 고정 글 \'판매 중\'(POL-029), 판매 종료 뒤 <판매 종료>', () => {
  assert.deepEqual(tierBadge('closed'), { text: '오픈 예정', kind: 'badge', tone: 'primary' });
  assert.deepEqual(tierBadge('lobby'), { text: '오픈 예정', kind: 'badge', tone: 'primary' });
  assert.deepEqual(tierBadge('pending'), { text: '오픈 예정', kind: 'badge', tone: 'primary' });
  assert.deepEqual(tierBadge('queue'), { text: '판매 중', kind: 'muted' });
  assert.deepEqual(tierBadge('ended'), { text: '판매 종료', kind: 'badge', tone: 'neutral' });
  assert.deepEqual(tierBadge('cancelled'), { text: '판매 종료', kind: 'badge', tone: 'neutral' });
  assert.equal(tierBadge(undefined), undefined);
});

test('회차 칩 배지는 회차마다 그 회차의 오픈·판매 종료로 고른다', () => {
  const [a, b] = D.rounds;
  assert.deepEqual(roundBadge(a, T('2026-11-20T12:00:00Z')), { text: '판매 중', tone: 'success' });
  assert.deepEqual(roundBadge(b, T('2026-11-20T12:00:00Z')), { text: '오픈 예정', tone: 'primary' });
  assert.deepEqual(roundBadge(a, T('2026-12-23T10:00:00Z')), { text: '판매 종료', tone: 'neutral' });
  assert.deepEqual(roundBadge({ ...a, status: 'CANCELLED' }, T('2026-11-20T12:00:00Z')), { text: '취소', tone: 'neutral' });
});
