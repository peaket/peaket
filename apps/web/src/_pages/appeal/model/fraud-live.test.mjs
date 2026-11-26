// F-04-15 SCR-042 부정 예매 소명 화면의 순수 모델 시험(동결 로컬, LCH-310).
// 정본: docs/features/forensic-replay.md §6.7.5 '팬 화면', docs/api/openapi.yaml FraudAppealView,
// docs/design/d3-screens.md SCR-042, ADR-0173 결정 3·4·6.
// 결제자는 사유 범주·잠금·조치·이의·우선 구매를 보고, 받은 사람은 가진 표와 기한만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appealContentError,
  canSeeReasonCategories,
  createFraudAppealBody,
  fraudAppealProblem,
  fraudDeadlineText,
  holderTicketText,
  mapFraudLive,
  priorityPurchaseRows,
  submissionOf,
} from './fraud-live.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-26T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const CASE = '0194b220-0000-7000-8000-000000000301';
const T1 = '0194b220-0000-7000-8000-000000000401';
const T2 = '0194b220-0000-7000-8000-000000000402';

const raw = (over = {}) => ({
  caseId: CASE,
  eventId: 'event-1',
  party: 'PAYER',
  reasonCategories: ['MACRO_BOT', 'LIMIT_EVASION'],
  dueAt: iso(NOW + 2 * DAY),
  lockActive: true,
  lockExpiresAt: iso(NOW + 14 * DAY),
  lockedTicketIds: [T1, T2],
  heldTicketIds: [],
  excludedTicketIds: [],
  status: 'OPEN',
  objectionDueAt: null,
  objectionStatus: 'NONE',
  objectionNote: null,
  actionResult: null,
  priorityPurchases: [],
  version: 4,
  otherAccounts: ['x'],
  score: 99,
  ...over,
});

test('UI-04 결제자 소명 화면은 사유 범주·잠긴 표·잠금 기한·조치·이의·우선 구매를 서버 값으로 보인다', () => {
  const v = mapFraudLive(
    raw({
      actionResult: { cancelledTicketIds: [T1], restrictedUntil: iso(NOW + 365 * DAY), objectionDue: iso(NOW + 30 * DAY) },
      objectionDueAt: iso(NOW + 30 * DAY),
      objectionStatus: 'ACCEPTED',
      objectionNote: '이의를 인정합니다',
      priorityPurchases: [
        { grantId: 'g1', seatLabel: 'A구역 3열 14번', price: 154000, expiresAt: iso(NOW + 2 * DAY), status: 'OFFERED' },
        { grantId: 'g2', seatLabel: 'A구역 3열 15번', price: 154000, expiresAt: iso(NOW - HOUR), status: 'OFFERED' },
      ],
    }),
    NOW,
  );
  assert.equal(v.party, 'PAYER');
  assert.deepEqual(v.reasonCategories, ['MACRO_BOT', 'LIMIT_EVASION']);
  assert.deepEqual(v.lockedTicketIds, [T1, T2]);
  assert.equal(v.lockActive, true);
  assert.equal(v.objectionStatus, 'ACCEPTED');
  assert.equal(v.objectionNote, '이의를 인정합니다');
  assert.equal(v.actionResult?.restrictedUntilMs, NOW + 365 * DAY);
  assert.equal(canSeeReasonCategories(v), true);
  const rows = priorityPurchaseRows(v);
  assert.equal(rows.length, 1);
  assert.match(rows[0].priceText, /154,000/);
  assert.match(rows[0].deadlineText, /2026|11월|11\/28/);
  assert.match(fraudDeadlineText(v), /기한|11월|11\/28/);
  assert.ok(!JSON.stringify(v).includes('otherAccounts'));
  assert.ok(!JSON.stringify(v).includes('"score"'));
});

test('UI-04 [ASVS v5.0.0-14.2.6] 받은 사람 화면은 가진 표와 기한만 보이고 사유 범주·잠금·이용 제한·우선 구매를 비운다', () => {
  const v = mapFraudLive(
    raw({
      party: 'HOLDER',
      heldTicketIds: [T2],
      excludedTicketIds: [],
      reasonCategories: ['MACRO_BOT'],
      lockedTicketIds: [T1],
      lockActive: true,
      lockExpiresAt: iso(NOW + 14 * DAY),
      actionResult: { cancelledTicketIds: [T2], restrictedUntil: iso(NOW + 365 * DAY) },
      priorityPurchases: [{ grantId: 'g1', seatLabel: 'A구역', price: 154000, expiresAt: iso(NOW + DAY), status: 'OFFERED' }],
    }),
    NOW,
  );
  assert.equal(v.party, 'HOLDER');
  assert.deepEqual(v.reasonCategories, []);
  assert.deepEqual(v.lockedTicketIds, []);
  assert.equal(v.lockActive, false);
  assert.equal(v.lockExpiresAtMs, null);
  assert.deepEqual(v.priorityPurchases, []);
  assert.equal(v.actionResult?.restrictedUntilMs, null);
  assert.deepEqual(v.actionResult?.cancelledTicketIds, [T2]);
  assert.equal(canSeeReasonCategories(v), false);
  assert.match(holderTicketText(v), /1매|1장/);
  assert.deepEqual(priorityPurchaseRows(v), []);
});

test('UI-05 소명 제출은 기한·이의 창·상태로만 열리고 본문은 1~2,000자다', () => {
  const open = mapFraudLive(raw(), NOW);
  assert.equal(submissionOf(open, NOW).allowed, true);
  assert.equal(submissionOf(open, NOW + 3 * DAY).allowed, false);
  assert.equal(submissionOf(open, NOW + 3 * DAY).reason, 'expired');
  const inObjection = mapFraudLive(raw({ status: 'OPEN', dueAt: iso(NOW - DAY), objectionDueAt: iso(NOW + 10 * DAY) }), NOW);
  assert.equal(submissionOf(inObjection, NOW).allowed, true);
  for (const status of ['SUBMITTED', 'ACCEPTED', 'REJECTED', 'EXPIRED']) {
    assert.equal(submissionOf(mapFraudLive(raw({ status }), NOW), NOW).allowed, false, status);
  }
  assert.equal(appealContentError('가'.repeat(2000)), undefined);
  assert.match(appealContentError(''), /1자/);
  assert.match(appealContentError('가'.repeat(2001)), /2,000/);
  assert.equal(appealContentError('\u1100\u1161'.repeat(1000)), undefined);
  assert.equal(appealContentError('😀'.repeat(1001)), undefined);
  assert.equal(appealContentError('가'.repeat(1999) + '😀'), undefined);
  assert.match(appealContentError('😀'.repeat(2001)), /2,000/);
  assert.match(appealContentError('가'.repeat(2000) + '😀'), /2,000/);
  assert.equal(appealContentError('가\u200b\u200b\u0000\u0007'), undefined);
  assert.match(appealContentError('\u200b'.repeat(2000)), /1자/);
});

test('UI-05 [ASVS v5.0.0-14.2.6] 받은 사람은 OPEN·EXPIRED에서만 제출하고 판단이 끝난 상태에서는 막는다', () => {
  const holder = (status) => mapFraudLive(raw({ party: 'HOLDER', heldTicketIds: [T2], status, dueAt: iso(NOW - HOUR), objectionDueAt: null }), NOW);
  assert.equal(submissionOf(holder('OPEN'), NOW).allowed, true);
  assert.equal(submissionOf(holder('EXPIRED'), NOW).allowed, true);
  for (const status of ['SUBMITTED', 'ACCEPTED', 'REJECTED']) {
    assert.equal(submissionOf(holder(status), NOW).allowed, false, status);
  }
});

test('UI-05 소명 본문은 kind FRAUD_CASE·targetId 사건 ID로 만들고 오류를 화면 문구로 바꾼다', () => {
  const v = mapFraudLive(raw(), NOW);
  assert.deepEqual(createFraudAppealBody(v, '  가족이 대신 예매했습니다  '), { kind: 'FRAUD_CASE', targetId: CASE, body: '가족이 대신 예매했습니다' });
  assert.equal(fraudAppealProblem({ status: 401 }).kind, 'auth');
  assert.match(fraudAppealProblem({ status: 409, code: 'fraud-case-state' }).message, /기한|상태/);
  assert.match(fraudAppealProblem({ status: 422, code: 'invalid-body' }).message, /본문|내용/);
  assert.match(fraudAppealProblem({ status: 503, code: 'dependency-unavailable' }).message, /잠시/);
  assert.equal(fraudAppealProblem({ status: 500 }).kind, 'error');
});
