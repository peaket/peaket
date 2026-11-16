// 캐시 화면 경로의 정규 주소 표 시험(BAT-170 W7L2-S10 재현, 계획 §16 S10-3, docs/frontend.md §5.18 '정규 주소 하나로 모은다').
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 칸마다 정본 꼴은 openapi 꼴(UUID는 소문자), 로케일은 en·ja·zh 소문자,
// 닫힌 목록 칸은 글자 그대로다. 대소문자만 다르거나 퍼센트로 감싼 정본 글자는 정본 주소로 308(쿼리 보존), 꼴 밖은 404다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCanonicalSegment, normalizeRoute } from './route-normalize.ts';

const ID = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const ONE_UPPER = '0B8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const ALL_UPPER = ID.toUpperCase();
const ok = (p, q) => assert.deepEqual(normalizeRoute(p, q), { kind: 'ok' }, `${p}${q ?? ''}`);
const moved = (p, q, to) => assert.deepEqual(normalizeRoute(p, q), { kind: 'redirect', location: to }, `${p}${q ?? ''}`);
const gone = (p, q) => assert.deepEqual(normalizeRoute(p, q), { kind: 'not-found' }, `${p}${q ?? ''}`);

/** UUID 칸을 가진 경로 틀(일곱 가운데 다섯. 로케일 경로는 아래에서 따로) */
const UUID_ROUTES = [
  (id) => `/events/${id}`,
  (id) => `/events/${id}/shuffle-proof`,
  (id) => `/my/tickets/${id}`,
  (id) => `/shop/${id}`,
  (id) => `/booking/${id}/checkout/return`,
  (id) => `/en/events/${id}`,
];

test('HOT-390 W7L2-S10 정규화 표: 칸마다 정본 꼴은 그대로, 대소문자만 다르면 308, 그 밖은 404다', () => {
  for (const route of UUID_ROUTES) {
    const canon = route(ID);
    ok(canon, '');
    ok(canon, '?tab=info');
    // 대소문자만 다르면 소문자 주소로, 쿼리는 그대로
    moved(route(ONE_UPPER), '', canon);
    moved(route(ALL_UPPER), '?tab=info&x=1', `${canon}?tab=info&x=1`);
    // 꼴 밖: 길이 35·37, 하이픈 자리 틀림, 16진 밖 글자
    for (const bad of [ID.slice(0, -1), `${ID}0`, '0b8f1f2e4-a1d-4c1e-9b5a-1f0a2b3c4e01', `0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e0g`]) gone(route(bad), '');
    // 퍼센트로 감싼 정본 글자는 308(감싼 대문자 %41도 소문자 주소로), 감싸도 꼴 밖이면 404
    moved(route(`%30${ID.slice(1)}`), '', canon); // %30 = '0'
    moved(route(ID.replace('4a1d', '4%41%31d')), '', canon); // %41 = 'A'(대문자), %31 = '1'
    gone(route(`0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e0%67`), '');
  }
  // 로케일: en·ja·zh 소문자만. 대소문자만 다르면 308, 그 밖은 404
  for (const l of ['en', 'ja', 'zh']) ok(`/${l}/events/${ID}`, '');
  moved(`/EN/events/${ID}`, '', `/en/events/${ID}`);
  moved(`/En/events/${ALL_UPPER}`, '?q=1', `/en/events/${ID}?q=1`);
  for (const l of ['ko', 'kr', 'fr', 'english']) gone(`/${l}/events/${ID}`, '');
  gone(`//events/${ID}`, '');
  // 정책 문서 이름은 목록 글자 그대로만
  ok('/policy/privacy', '');
  gone('/policy/Privacy', '');
  gone('/policy/PRIVACY', '');
  gone('/policy/no-such-policy', '');
  // 데모·시험 고정 ID는 닫힌 목록으로만 받는다(화면 목록 src/shared/config/screens.*.ts가 쓰는 고정 자료). 목록 밖·대소문자 다름은 404
  ok('/events/evt-lumen-1025/shuffle-proof', '');
  ok('/booking/evt-lumen-1025/checkout/return', '');
  gone('/events/evt-not-in-list-0000', '');
  gone('/events/EVT-LUMEN-1025/shuffle-proof', '');
  // 표 밖의 경로는 건드리지 않는다
  for (const p of ['/', '/search', '/help']) ok(p, '');
});

// BAT-170 웨이브 끝 재검증(2bf0a549). 시험 담당(l2w7-BAT170-test)이 썼다. 정본 docs/frontend.md §5.18 '정규 주소 하나로 모은다' ⓑⓒ.
test('HOT-390 V170-R15 공연 상세·로케일 상세 칸은 UUID만 받고 고정 자료 ID는 받지 않는다', () => {
  gone('/events/evt-lumen-1025', '');
  gone('/en/events/evt-lumen-1025', '');
  gone('/ja/events/evt-lumen-1025', '');
  // 대조군: 같은 고정 자료 ID도 shuffle-proof·checkout/return 칸은 받는다
  ok('/events/evt-lumen-1025/shuffle-proof', '');
  ok('/booking/evt-lumen-1025/checkout/return', '');
});

test('HOT-390 V170-R16 화면의 겹친 가드(isCanonicalSegment)는 정본 꼴과 글자까지 같을 때만 참이다', () => {
  // 정본 꼴은 참
  assert.equal(isCanonicalSegment('event-detail', ID), true);
  for (const l of ['en', 'ja', 'zh']) assert.equal(isCanonicalSegment('locale', l), true, l);
  assert.equal(isCanonicalSegment('policy', 'privacy'), true);
  assert.equal(isCanonicalSegment('event', 'evt-lumen-1025'), true, 'shuffle-proof 칸은 고정 자료 ID를 받는다');
  // 대소문자만 다르거나 꼴 밖이면 거짓(정규화 표가 308로 옮길 값이어도 화면은 받지 않는다)
  for (const v of [ONE_UPPER, ALL_UPPER, 'evt-lumen-1025', ID.slice(0, -1), `%30${ID.slice(1)}`]) assert.equal(isCanonicalSegment('event-detail', v), false, `event-detail ${v}`);
  for (const v of ['EN', 'En', 'ko', '']) assert.equal(isCanonicalSegment('locale', v), false, `locale ${v}`);
  for (const v of ['Privacy', 'PRIVACY', 'no-such-policy']) assert.equal(isCanonicalSegment('policy', v), false, `policy ${v}`);
  assert.equal(isCanonicalSegment('event', 'EVT-LUMEN-1025'), false);
  assert.equal(isCanonicalSegment('event', ALL_UPPER), false);
});
