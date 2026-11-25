// SCR-048 수요 예측·규모 올리기·판매 중지 요청 모델 시험(LCH-090, ADR-0078, ADR-0123, d5 §7.9).
// 화면이 읽는 응답을 값으로 옮기고, 올릴 수 없는 이유와 요청 본문을 순수 함수로 가른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapDemandForecast,
  mapSaleReviewDetail,
  saleSuspensionCommand,
  scaleChangeBody,
  scaleRaiseIssues,
} from './sale-review.ts';

const forecast = () => ({
  eventId: 'ev-1',
  computedAt: '2026-11-25T00:00:00.000Z',
  trigger: 'SALE_REVIEW',
  subscribers: 120,
  ratioMedian: 2,
  ratioUpper: 3,
  sampleCount: 0,
  defaultRatioUsed: true,
  expectedMedian: 240,
  expectedUpper: 360,
  suggestedScale: 'SMALL',
  currentScale: null,
  raiseSuggested: false,
});

const detail = () => ({
  productionId: 'prd-1',
  title: '겨울 콘서트',
  promoterId: 'prom-1',
  promoterName: '(주)피켓공연',
  status: 'APPROVED',
  reapproval: false,
  submittedAt: null,
  rejectionReason: null,
  seller: null,
  verifiedAt: null,
  placeId: '3f1c2d9e-0000-4000-8000-000000000001',
  placeName: '피켓 아레나',
  requestedPlace: false,
  artists: [],
  accessibleSeatingCheck: true,
  accessibleSeating: {
    confirmed: true,
    shortfallReason: 'RELAXED_STANDARD',
    note: null,
    totalSeats: 250,
    wheelchairSeats: 2,
    requiredSeats: 3,
    locationCheckSeats: 1,
    onlineWheelchairSeats: 1,
  },
  salePolicy: [],
  events: [
    { eventId: 'ev-1', openAt: '2026-12-01T11:00:00.000Z', startsAt: '2026-12-02T10:30:00.000Z', status: 'SCHEDULED', scale: 'SMALL', demandForecastPath: '/v1/ops/events/ev-1/demand-forecast', pgPrimary: 'TOSS', pgFallback: 'PORTONE' },
    { eventId: 'ev-2', openAt: '2026-12-03T11:00:00.000Z', startsAt: '2026-12-04T10:30:00.000Z', status: 'CANCELLED', scale: 'MEDIUM', demandForecastPath: '/v1/ops/events/ev-2/demand-forecast', pgPrimary: 'PORTONE', pgFallback: null },
  ],
  suspensionApprovalPending: false,
  payoutAccount: null,
  pgRegistration: null,
});

test('LCH-090 ㉠ 수요 예측 응답을 화면 값으로 옮기고 기본 비율·표본·제안을 보인다', () => {
  const mapped = mapDemandForecast(forecast());
  assert.deepEqual(mapped, {
    subscribers: 120,
    ratioMedian: 2,
    ratioUpper: 3,
    sampleCount: 0,
    defaultRatioUsed: true,
    expectedMedian: 240,
    expectedUpper: 360,
    suggestedScale: 'SMALL',
    currentScale: null,
    raiseSuggested: false,
  });
  assert.equal(mapDemandForecast({}), null);
  assert.equal(mapDemandForecast({ subscribers: 'x' }), null);
});

test('LCH-090 ㉡ 규모 올리기는 지금보다 큰 값과 사유가 있어야 하고 본문에 고른 값만 낸다', () => {
  assert.deepEqual(scaleRaiseIssues('SMALL', 'MEDIUM', '수요가 늘었습니다'), []);
  assert.deepEqual(scaleRaiseIssues('MEDIUM', 'SMALL', '수요가 늘었습니다'), ['지금보다 큰 규모만 올릴 수 있습니다']);
  assert.deepEqual(scaleRaiseIssues('SMALL', 'SMALL', '수요가 늘었습니다'), ['지금보다 큰 규모만 올릴 수 있습니다']);
  assert.deepEqual(scaleRaiseIssues('SMALL', null, '수요가 늘었습니다'), ['올릴 규모를 골라 주세요']);
  assert.deepEqual(scaleRaiseIssues('SMALL', 'MEDIUM', '  '), ['사유를 적어 주세요']);
  assert.deepEqual(scaleRaiseIssues('SMALL', 'MEDIUM', 'x'.repeat(501)), ['사유는 500자까지 적을 수 있습니다']);

  assert.deepEqual(scaleChangeBody('ev-1', 'MEDIUM', ' 수요가 늘었습니다 '), { scale: 'MEDIUM', reason: '수요가 늘었습니다' });
  assert.deepEqual(scaleChangeBody('ev-1', 'LARGE', '간격 예외', true), { scale: 'LARGE', reason: '간격 예외', intervalException: true });
});

test('LCH-090 ㉢ 상세는 휠체어 재계산 값과 회차별 결제사 지정을 옮긴다', () => {
  const d = mapSaleReviewDetail(detail());
  assert.deepEqual(d.accessibleSeating, {
    confirmed: true,
    shortfallReason: 'RELAXED_STANDARD',
    note: null,
    totalSeats: 250,
    wheelchairSeats: 2,
    requiredSeats: 3,
    locationCheckSeats: 1,
    onlineWheelchairSeats: 1,
  });
  assert.equal(d.accessibleSeatingCheck, true);
  assert.equal(d.events[0].pgPrimary, 'TOSS');
  assert.equal(d.events[0].pgFallback, 'PORTONE');
  assert.equal(d.events[1].pgFallback, null);
});

test('LCH-090 판매 중지·재개 요청은 취소되지 않은 회차마다 같은 참조로 명령을 만든다', () => {
  const { commands, issues } = saleSuspensionCommand(detail(), 'SALE_STOP', 'FRAUD_SUSPECTED', '사기 의심');
  assert.deepEqual(issues, []);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'SALE_STOP');
  assert.equal(commands[0].reason, '사기 의심');
  assert.equal(commands[0].params.eventId, 'ev-1');
  assert.equal(commands[0].params.reasonCode, 'FRAUD_SUSPECTED');
  assert.match(commands[0].params.suspensionRef, /^[0-9a-f-]{36}$/);

  const bad = saleSuspensionCommand(detail(), 'SALE_STOP', 'FRAUD_SUSPECTED', '  ');
  assert.deepEqual(bad.commands, []);
  assert.deepEqual(bad.issues, ['사유를 적어 주세요']);
});
