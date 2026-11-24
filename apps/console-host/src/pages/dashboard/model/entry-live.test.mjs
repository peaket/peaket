// GAT-360 재현 시험: 관제 입장 탭의 실제 값 해석(시험 먼저).
// 입장 시작·마감은 readiness.schedule에서, 스캐너 신선도와 중복 입장 급증은 ops 경보 목록에서 읽는다.
// 값이 없거나 늦으면 '세지 못함'/'늦음'과 까닭을 고른다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryAlertsOf, entryScheduleOf, entryStageOf, staleText } from './entry-live.ts';

const NOW = Date.parse('2026-10-25T08:12:30Z');

test('GAT-360 입장 시작·마감을 readiness 일정에서 읽고 없으면 세지 못함 까닭을 남긴다', () => {
  const ok = entryScheduleOf({
    stage: 'entry',
    schedule: { opensAt: '2026-10-01T10:00:00Z', saleEndsAt: '2026-10-24T10:00:00Z', entryOpensAt: '2026-10-25T07:30:00Z', entryClosedAt: '2026-10-25T12:00:00Z' },
  });
  assert.equal(ok.stage, 'entry');
  assert.equal(ok.entryOpensAt, '2026-10-25T07:30:00Z');
  assert.equal(ok.entryClosedAt, '2026-10-25T12:00:00Z');
  assert.equal(ok.unavailable, undefined);

  const noEntry = entryScheduleOf({ stage: 'live', schedule: { opensAt: '2026-10-01T10:00:00Z', saleEndsAt: '2026-10-24T10:00:00Z' } });
  assert.equal(noEntry.entryOpensAt, null);
  assert.equal(noEntry.unavailable, '입장 시작 시각을 읽지 못했습니다');

  const bad = entryScheduleOf({});
  assert.equal(bad.stage, null);
  assert.equal(bad.unavailable, '회차 단계를 읽지 못했습니다');
});

test('GAT-360 단계는 입장 시각과 지금으로 가른다(경계 포함)', () => {
  assert.equal(entryStageOf({ entryOpensAt: '2026-10-25T07:30:00Z', entryClosedAt: '2026-10-25T12:00:00Z', stage: 'entry' }, NOW), 'open');
  assert.equal(entryStageOf({ entryOpensAt: '2026-10-25T08:12:30Z', entryClosedAt: null, stage: 'entry' }, NOW), 'open');
  assert.equal(entryStageOf({ entryOpensAt: '2026-10-25T08:12:31Z', entryClosedAt: null, stage: 'entry' }, NOW), 'before');
  assert.equal(entryStageOf({ entryOpensAt: '2026-10-25T07:30:00Z', entryClosedAt: '2026-10-25T08:12:30Z', stage: 'none' }, NOW), 'closed');
  assert.equal(entryStageOf({ entryOpensAt: null, entryClosedAt: null, stage: null }, NOW), 'unknown');
});

test('GAT-360 경보 목록에서 스캐너 신선도·중복 입장 급증만 골라 값과 까닭을 남긴다', () => {
  const alerts = entryAlertsOf({
    items: [
      {
        alertId: 'a1',
        status: 'firing',
        startsAt: '2026-10-25T08:10:00Z',
        severity: 'SEV2',
        title: '스캐너가 2분 넘게 변경분을 받지 못했다',
        kind: 'hygiene',
        sourceKind: 'scanner-freshness:dev-1',
        detail: { deviceName: '서문-02', gateZone: '서문', ageMs: 167_000, thresholdMs: 120_000 },
      },
      { alertId: 'a2', status: 'firing', startsAt: '2026-10-25T08:09:20Z', severity: 'SEV3', title: '중복 입장 이상 표시가 10분에 12건입니다', kind: 'hygiene', sourceKind: 'duplicate-surge:evt-1', detail: { kind: 'DUPLICATE_SURGE', count: 12, windowMs: 600_000, threshold: 10 } },
      { alertId: 'a3', status: 'firing', startsAt: '2026-10-25T08:00:00Z', severity: 'SEV2', title: '다른 경보', kind: 'slo', sourceKind: 'slo:hold' },
    ],
    seq: '9',
  });
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((a) => a.kind), ['SCANNER_STALE', 'DUPLICATE_SURGE']);
  assert.deepEqual(alerts[0], {
    kind: 'SCANNER_STALE',
    severity: 'SEV2',
    title: '스캐너가 2분 넘게 변경분을 받지 못했다',
    startsAt: '2026-10-25T08:10:00Z',
    deviceName: '서문-02',
    gateZone: '서문',
    ageMs: 167_000,
    thresholdMs: 120_000,
    count: null,
  });
  assert.equal(alerts[1].count, 12);
  assert.equal(alerts[1].thresholdMs, 10);
});

test('GAT-360 늦음 표시는 기준(2분)을 넘으면 까닭과 함께 늦음이다', () => {
  assert.deepEqual(staleText(119_999), { late: false, text: '1분 59초 전' });
  assert.deepEqual(staleText(120_000), { late: false, text: '2분 0초 전' });
  assert.deepEqual(staleText(167_000, 120_000), { late: true, text: '2분 47초 전 · 기준 2분 초과' });
  assert.deepEqual(staleText(undefined), { late: false, text: '세지 못함' });
});
