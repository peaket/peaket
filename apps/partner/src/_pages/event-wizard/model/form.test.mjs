// 공연 등록 위저드 입력 규칙(SCR-021, d5 §6.4, ADR-0118, ADR-0198, ADR-0245). 순수 함수만 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearFieldErrors,
  emptyDraft,
  kopisStatus,
  parseDraft,
  parseRequestKey,
  problemToErrors,
  requestKeyFor,
  serializeDraft,
  toCreateBody,
  validateStep,
  warningText,
} from './form.ts';

const round = (o = {}) => ({ key: 'r1', openAt: '2026-11-20T20:00', lobbyMinutes: 10, entryOpensAt: '2026-12-24T18:00', startsAt: '2026-12-24T19:00', endsAt: '2026-12-24T21:30', reentryAllowed: false, ...o });
const filled = (o = {}) => ({
  ...emptyDraft(),
  title: '겨울 콘서트',
  genre: '콘서트',
  ageRating: '만 7세 이상',
  runningMinutes: '120',
  place: { kind: 'picked', id: '0190f3a1-7c2e-7a00-8000-000000000001', name: '피켓홀' },
  artists: [{ artistId: 'a1', name: 'LUMEN' }],
  producer: '(주)피켓',
  rounds: [round()],
  ...o,
});
const fields = (errs) => errs.map((e) => e.field);

test('SCR-021 1단계: 보드에서 필수로 표시한 칸이 비면 넘어가지 못한다', () => {
  assert.deepEqual(fields(validateStep(emptyDraft(), 1)).sort(), ['ageRating', 'artists', 'genre', 'place', 'producer', 'runningMinutes', 'title']);
  assert.deepEqual(validateStep(filled(), 1), []);
  assert.deepEqual(fields(validateStep(filled({ title: '   ' }), 1)), ['title']);
});

test('SCR-021 1단계: 길이·숫자 상한(openapi PartnerProductionCreate)', () => {
  assert.deepEqual(validateStep(filled({ title: '가'.repeat(100) }), 1), []);
  assert.deepEqual(fields(validateStep(filled({ title: '가'.repeat(101) }), 1)), ['title']);
  assert.deepEqual(fields(validateStep(filled({ ageRating: '가'.repeat(31) }), 1)), ['ageRating']);
  assert.deepEqual(fields(validateStep(filled({ producer: '가'.repeat(201) }), 1)), ['producer']);
  assert.deepEqual(fields(validateStep(filled({ notice: '가'.repeat(1001) }), 1)), ['notice']);
  assert.deepEqual(fields(validateStep(filled({ runningMinutes: '0' }), 1)), ['runningMinutes']);
  assert.deepEqual(fields(validateStep(filled({ runningMinutes: '1.5' }), 1)), ['runningMinutes']);
  assert.deepEqual(validateStep(filled({ runningMinutes: '1440' }), 1), []);
  assert.deepEqual(fields(validateStep(filled({ runningMinutes: '1441' }), 1)), ['runningMinutes']);
});

test('ADR-0244 저장할 수 없는 글자는 보내기 전에 막는다', () => {
  assert.deepEqual(fields(validateStep(filled({ title: 'a\u0000' }), 1)), ['title']);
  assert.deepEqual(fields(validateStep(filled({ producer: 'a\ud800' }), 1)), ['producer']);
  assert.deepEqual(validateStep(filled({ title: '😀' }), 1), []);
});

test('SCR-021 1단계: 새 공연장 요청은 이름과 주소가 있어야 한다', () => {
  assert.deepEqual(fields(validateStep(filled({ place: { kind: 'new', name: '새 홀', address: '' } }), 1)), ['place']);
  assert.deepEqual(fields(validateStep(filled({ place: { kind: 'new', name: '새 홀', address: '가'.repeat(201) } }), 1)), ['place']);
  assert.deepEqual(validateStep(filled({ place: { kind: 'new', name: '새 홀', address: '서울' } }), 1), []);
});

test('SCR-021 1단계: 아티스트는 20개까지이고 같은 아티스트를 두 번 고르지 못한다', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ artistId: `a${i}`, name: `이름${i}` }));
  assert.deepEqual(validateStep(filled({ artists: many(20) }), 1), []);
  assert.deepEqual(fields(validateStep(filled({ artists: many(21) }), 1)), ['artists']);
  assert.deepEqual(fields(validateStep(filled({ artists: [{ artistId: 'a1', name: 'x' }, { artistId: 'a1', name: 'x' }] }), 1)), ['artists']);
});

test('SCR-021 1단계: 다른 이름은 5개까지이고 겹치면 안 된다', () => {
  assert.deepEqual(validateStep(filled({ aliases: ['a', 'b', 'c', 'd', 'e'] }), 1), []);
  assert.deepEqual(fields(validateStep(filled({ aliases: ['a', 'b', 'c', 'd', 'e', 'f'] }), 1)), ['aliases']);
  assert.deepEqual(fields(validateStep(filled({ aliases: ['a', 'a'] }), 1)), ['aliases']);
});

test('ADR-0198 2단계: 회차는 1~50개이고 공연 시작과 종료는 필수다', () => {
  assert.deepEqual(fields(validateStep(filled({ rounds: [] }), 2)), ['rounds']);
  assert.deepEqual(validateStep(filled(), 2), []);
  assert.deepEqual(fields(validateStep(filled({ rounds: [round({ openAt: '' })] }), 2)), ['rounds.0.openAt']);
  assert.deepEqual(fields(validateStep(filled({ rounds: [round({ startsAt: '', openAt: '' })] }), 2)).sort(), ['rounds.0.openAt', 'rounds.0.startsAt']);
  assert.deepEqual(fields(validateStep(filled({ rounds: [round({ endsAt: '' })] }), 2)), ['rounds.0.endsAt']);
  assert.deepEqual(fields(validateStep(filled({ rounds: [round({ entryOpensAt: '' })] }), 2)), ['rounds.0.entryOpensAt']);
  assert.deepEqual(fields(validateStep(filled({ rounds: Array.from({ length: 51 }, (_, i) => round({ key: String(i) })) }), 2)), ['rounds']);
});

test('ADR-0198 2단계: 오픈 < 판매 종료(공연 시작 − 24시간) < 공연 시작 < 종료, 입장 시작 ≤ 공연 시작', () => {
  assert.deepEqual(fields(validateStep(filled({ rounds: [round({ openAt: '2026-12-25T00:00' })] }), 2)), ['rounds.0.openAt']);
  assert.deepEqual(fields(validateStep(filled({ rounds: [round({ openAt: '2026-12-23T19:00' })] }), 2)), ['rounds.0.openAt']);
  assert.deepEqual(validateStep(filled({ rounds: [round({ openAt: '2026-12-23T18:59' })] }), 2), []);
  assert.deepEqual(fields(validateStep(filled({ rounds: [round({ endsAt: '2026-12-24T19:00' })] }), 2)), ['rounds.0.endsAt']);
  assert.deepEqual(validateStep(filled({ rounds: [round({ entryOpensAt: '2026-12-24T19:00' })] }), 2), []);
  assert.deepEqual(fields(validateStep(filled({ rounds: [round({ entryOpensAt: '2026-12-24T19:01' })] }), 2)), ['rounds.0.entryOpensAt']);
});

test('ADR-0198 2단계: 오픈이 이미 지났으면 막고, 로비 개방은 0~60분이다', () => {
  const after = Date.parse('2026-11-21T00:00:00+09:00');
  assert.deepEqual(fields(validateStep(filled(), 2, after)), ['rounds.0.openAt']);
  assert.deepEqual(validateStep(filled(), 2, Date.parse('2026-11-01T00:00:00+09:00')), []);
  assert.deepEqual(fields(validateStep(filled({ rounds: [round({ lobbyMinutes: 61 })] }), 2)), ['rounds.0.lobbyMinutes']);
  assert.deepEqual(fields(validateStep(filled({ rounds: [round({ lobbyMinutes: '' })] }), 2)), ['rounds.0.lobbyMinutes']);
  assert.deepEqual(validateStep(filled({ rounds: [round({ lobbyMinutes: 0 })] }), 2), []);
});

test('SCR-021 4단계: 1인 한도는 1~10이다', () => {
  assert.deepEqual(validateStep(filled({ perPersonLimit: 4 }), 4), []);
  assert.deepEqual(fields(validateStep(filled({ perPersonLimit: 11 }), 4)), ['perPersonLimit']);
  assert.deepEqual(fields(validateStep(filled({ perPersonLimit: 0 }), 4)), ['perPersonLimit']);
});

test('ADR-0118 정렬 방식 이름을 두 값으로 바꾼다', () => {
  const opts = (queueOrder) => {
    const e = toCreateBody(filled({ queueOrder })).events[0];
    return [e.lobbyShuffle, e.openBatch];
  };
  assert.deepEqual(opts('HYBRID'), [true, true]);
  assert.deepEqual(opts('PREQUEUE_SHUFFLE'), [true, false]);
  assert.deepEqual(opts('FIFO'), [false, true]);
});

test('ADR-0198 등록 본문: 시각은 한국 시각으로 보내고, 앞뒤 빈칸은 떼고, 비운 칸은 싣지 않는다', () => {
  const body = toCreateBody(filled({ title: ' 겨울 ', artists: [{ artistId: 'a1', name: 'LUMEN' }, { name: ' 새 이름 ' }], aliases: [' WINTER '], runningMinutes: '120', notice: '' }));
  assert.equal(body.title, '겨울');
  assert.equal(body.placeId, '0190f3a1-7c2e-7a00-8000-000000000001');
  assert.equal('newPlace' in body, false);
  assert.deepEqual(body.artists, [{ artistId: 'a1' }, { name: '새 이름' }]);
  assert.deepEqual(body.aliases, ['WINTER']);
  assert.equal(body.runningMinutes, 120);
  assert.equal(body.ageRating, '만 7세 이상');
  assert.deepEqual(body.kopisFields, { producer: '(주)피켓' });
  const e = body.events[0];
  assert.equal(e.openAt, '2026-11-20T20:00:00+09:00');
  assert.equal(e.startsAt, '2026-12-24T19:00:00+09:00');
  assert.equal(e.endsAt, '2026-12-24T21:30:00+09:00');
  assert.equal(e.entryOpensAt, '2026-12-24T18:00:00+09:00');
  assert.deepEqual([e.lobbyMinutes, e.reentryAllowed, e.seatAssignment, e.perPersonLimit], [10, false, 'PICK', 4]);
  assert.equal('aliases' in toCreateBody(filled()), false);
});

test('ADR-0198 새 공연장 요청을 보낸다', () => {
  const body = toCreateBody(filled({ place: { kind: 'new', name: '새 홀', address: '서울' } }));
  assert.deepEqual(body.newPlace, { name: '새 홀', address: '서울' });
  assert.equal('placeId' in body, false);
});

test('d5 §6.4 서버 판정을 그 회차의 오픈 시각 칸 오류로 바꾼다(가능 시각은 한국 시각)', () => {
  assert.deepEqual(problemToErrors({ status: 409, type: 'open-too-close', extensions: { eventIndex: 1, suggestedOpenAt: '2026-11-20T11:05:00Z' } }), [
    { step: 2, field: 'rounds.1.openAt', message: '다른 공연과 5분 이상 떨어져야 합니다(가능: 20:05)' },
  ]);
  assert.deepEqual(problemToErrors({ status: 409, type: 'open-too-close', extensions: { eventIndex: 0 } }), [{ step: 2, field: 'rounds.0.openAt', message: '다른 공연과 5분 이상 떨어져야 합니다' }]);
  assert.deepEqual(problemToErrors({ status: 409, type: 'open-maintenance-window', extensions: { eventIndex: 0 } }), [{ step: 2, field: 'rounds.0.openAt', message: '수요일 03:00~06:30에는 오픈할 수 없습니다' }]);
  assert.equal(problemToErrors({ status: 422, type: 'event-schedule-invalid', extensions: { eventIndex: 2 } })[0].field, 'rounds.2.openAt');
});

test('d5 §6.4 칸을 짚을 수 없는 판정은 오류 요약으로 보인다', () => {
  assert.deepEqual(problemToErrors({ status: 404, type: 'not-found', extensions: {} }), [{ step: 1, field: 'place', message: '공연장이나 아티스트를 찾지 못했습니다. 다시 골라 주세요' }]);
  assert.equal(problemToErrors({ status: 503, type: 'server-busy', extensions: {} })[0].field, 'form');
  assert.equal(problemToErrors({ status: 403, type: 'about:blank', extensions: {} })[0].field, 'form');
  // 차례가 없거나 이상하면 없는 칸을 짚지 않는다
  assert.equal(problemToErrors({ status: 409, type: 'open-too-close', extensions: {} })[0].field, 'form');
  assert.equal(problemToErrors({ status: 409, type: 'open-too-close', extensions: { eventIndex: -1 } })[0].field, 'form');
});

test('d5 §6.4 대형 간격 경고 문구', () => {
  assert.equal(
    warningText({ eventIndex: 0, code: 'LARGE_SHOW_NEAR', suggestedOpenAt: '2026-11-20T11:30:00Z' }),
    '이 공연이 판매 승인에서 대형 공연(예상 대기 50만 명 이상)으로 정해지면 다른 대형 공연과 30분 이상 떨어져야 합니다. 그때 오픈 시각을 바꿔야 할 수 있습니다(가능: 20:30)',
  );
  assert.equal(warningText({ eventIndex: 0, code: 'LARGE_SHOW_NEAR' }).endsWith('있습니다'), true);
});

test('d5 §6.4 전산망 항목 상태는 입력한 값을 따른다', () => {
  const empty = kopisStatus(emptyDraft());
  assert.equal(empty['공연 명칭·종류'], '입력 필요');
  assert.equal(empty['기간·장소'], '입력 필요');
  assert.equal(empty['안내 사항'], '비어 있음');
  const full = kopisStatus(filled({ notice: '촬영 금지' }));
  assert.equal(full['공연 명칭·종류'], '입력됨');
  assert.equal(full['기간·장소'], '입력됨');
  assert.equal(full['시간'], '입력됨');
  assert.equal(full['관람 가능 연령'], '입력됨');
  assert.equal(full['출연진·제작진·기획사·제작사'], '입력됨');
  assert.equal(full['안내 사항'], '입력됨');
  assert.equal(kopisStatus(filled({ producer: '' }))['출연진·제작진·기획사·제작사'], '입력 필요');
});

test('임시저장: 저장한 값을 되살리고, 깨진 값은 버린다', () => {
  const d = filled({ aliases: ['x'] });
  assert.deepEqual(parseDraft(serializeDraft(d)), d);
  assert.equal(parseDraft('{깨짐'), null);
  assert.equal(parseDraft('{"v":2}'), null);
  assert.equal(parseDraft(serializeDraft({ ...d, rounds: 'x' })), null);
  assert.equal(parseDraft(serializeDraft({ ...d, rounds: [{ key: 'r' }] })), null);
  assert.equal(parseDraft(serializeDraft({ ...d, place: { kind: 'x' } })), null);
  assert.equal(parseDraft(serializeDraft({ ...d, queueOrder: 'LOTTERY' })), null);
  assert.equal(parseDraft(serializeDraft({ ...d, artists: [{}] })), null);
  assert.equal(parseDraft(null), null);
});

test('ADR-0245 멱등 키: 같은 본문을 다시 보내면 같은 키, 고치면 새 키, 저장한 키를 되살린다', () => {
  let n = 0;
  const make = () => `key-${++n}`;
  const a = requestKeyFor(null, { title: 'a' }, make);
  assert.equal(a.key, 'key-1');
  assert.equal(requestKeyFor(a, { title: 'a' }, make).key, 'key-1');
  assert.equal(requestKeyFor(a, { title: 'b' }, make).key, 'key-2');
  assert.deepEqual(parseRequestKey(JSON.stringify(a)), a);
  assert.equal(parseRequestKey('{깨짐'), null);
  assert.equal(parseRequestKey('{"key":1}'), null);
  assert.equal(parseRequestKey(null), null);
});

test('리뷰 재현: 회차를 지우면 회차 오류를 모두 지운다(지우면 차례가 밀린다)', () => {
  const es = [
    { step: 2, field: 'rounds.1.openAt', message: 'a' },
    { step: 2, field: 'rounds', message: 'b' },
    { step: 1, field: 'title', message: 'c' },
    { step: 4, field: 'form', message: 'd' },
  ];
  assert.deepEqual(fields(clearFieldErrors(es, 'rounds.*')), ['title']);
  assert.deepEqual(fields(clearFieldErrors(es, 'title')), ['rounds.1.openAt', 'rounds']);
  assert.deepEqual(fields(clearFieldErrors(es, 'rounds.1.openAt')), ['rounds', 'title']);
});

test('리뷰 재현: 비어 있는 새 공연장은 입력됨으로 치지 않는다', () => {
  assert.equal(kopisStatus(filled({ place: { kind: 'new', name: '', address: '' } }))['기간·장소'], '입력 필요');
  assert.equal(kopisStatus(filled({ place: { kind: 'new', name: '새 홀', address: '서울' } }))['기간·장소'], '입력됨');
});

test('리뷰 재현: 결과를 모르는 실패(응답 유실·서버 오류)는 다시 보내도 된다고 알린다', () => {
  for (const p of [{ status: 0, type: 'network', extensions: {} }, { status: 503, type: 'server-busy', extensions: {} }]) {
    const [e] = problemToErrors(p);
    assert.equal(e.field, 'form');
    assert.match(e.message, /등록되었는지 확인하지 못했습니다/);
    assert.match(e.message, /내용을 바꾸지 말고/);
  }
});

test('리뷰 재현: 가능한 시각이 다른 날이면 날짜도 보인다', () => {
  const p = (suggestedOpenAt) => ({ status: 409, type: 'open-too-close', extensions: { eventIndex: 0, suggestedOpenAt } });
  const d = filled({ rounds: [round({ openAt: '2026-11-20T23:58' })] });
  assert.match(problemToErrors(p('2026-11-20T15:03:00Z'), d)[0].message, /가능: 11\/21 00:03\)/);
  assert.match(problemToErrors(p('2026-11-20T14:59:00Z'), d)[0].message, /가능: 23:59\)/);
});
