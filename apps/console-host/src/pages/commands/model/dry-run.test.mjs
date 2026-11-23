// dry-run 응답 → 화면 줄(F-03-4 T1, C-T6 ②, 시험 먼저 ADR 0372번).
// 정본: docs/features/control-tower.md §4 dry-run 두 갈래(센 값은 원천·센 시각과 함께, 예측 값은 식·넣은 값·가정과 함께), §14 C-T6 ②,
// docs/api/openapi.yaml CommandDryRun(판 1: approvalMode NONE|ONE|TWO, reauthRequired, counted·predicted·unavailable·limits, '원천을 세지 못한 값은 unavailable에만 있고 0으로 적지 않는다'),
// 계획 docs/review/plans/F-03-4.md §4 dry-run.ts.
// 구현 전 트리에는 model/dry-run.ts가 없어 가져오기부터 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AT, E, dryRunAdmissionUp, dryRunKillSwitch, dryRunPgFallback } from './commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);

const load = () => import('./dry-run.ts');

test('F-03-4 T1 C-T6 ②-1 명령 1 목표 올림의 예측 줄마다 값·식·넣은 값(이름, 값 차례 그대로)·가정이 함께 있고, 센 값은 원천·센 시각과 함께다', async () => {
  const { dryRunView } = await load();
  const v = dryRunView(dryRunAdmissionUp());
  assert.equal(v.approval, 'one');
  assert.equal(v.reauth, false);
  assert.deepEqual(v.counted[0], { key: 'currentTarget', value: 4000, source: 'admission-ctrl', measuredAt: AT });
  assert.equal(v.counted.length, 6);
  assert.deepEqual(
    v.predicted.map((p) => p.key),
    ['vacancy', 'fillSeconds', 'steadyAdmissionRate', 'servingRate'],
  );
  assert.deepEqual(v.predicted[0], {
    key: 'vacancy',
    value: 940,
    formula: 'targetNew − slotsUsed − soonAdmitted − inFlight',
    inputs: [
      ['targetNew', 5200],
      ['slotsUsed', 3900],
      ['soonAdmitted', 260],
      ['inFlight', 100],
    ],
    assumptions: [],
  });
  assert.deepEqual(v.predicted[2].assumptions, ['정상 상태다(머무는 시간·입장 비율이 지금과 같다)']);
  assert.deepEqual(v.limits, [
    ['admissionTargetMax', 8000],
    ['admissionTargetMin', 1000],
  ]);
});

test('F-03-4 T1 C-T6 ②-2 세지 못한 값은 값 칸 없이 원천·까닭만 갖는다(0으로 바꾸지 않는다)', async () => {
  const { dryRunView } = await load();
  const v = dryRunView(dryRunKillSwitch());
  assert.equal(v.approval, 'none');
  assert.equal(v.reauth, true);
  assert.deepStrictEqual(v.unavailable, [{ key: 'paymentSessions', source: 'purchase-db', reason: 'source-not-wired' }]);
  assert.equal(Object.hasOwn(v.unavailable[0], 'value'), false);
  // 세지 못한 키는 센 값 줄에 0으로 끼어들지 않는다
  assert.equal(
    v.counted.some((c) => c.key === 'paymentSessions'),
    false,
  );
  assert.deepEqual(v.predicted, []);
  assert.deepEqual(v.limits, []);
});

test('F-03-4 T1 C-T6 ②-3 명령 6 결제 갈래는 2인·재인증이고, 회차 키(admissionTargetCapNew:<회차>) 예측과 지금 값의 세지 못한 까닭을 그대로 나른다', async () => {
  const { dryRunView } = await load();
  const v = dryRunView(dryRunPgFallback());
  assert.equal(v.approval, 'two');
  assert.equal(v.reauth, true);
  assert.equal(v.predicted.length, 1);
  assert.equal(v.predicted[0].key, `admissionTargetCapNew:${E}`);
  assert.equal(v.predicted[0].value, 5400);
  assert.equal(v.predicted[0].formula, 'min(admissionTargetMax, pgTps × avgDwellSeconds ÷ paymentRatio × safetyFactor)');
  assert.deepEqual(v.predicted[0].inputs, [
    ['pgTps', 60],
    ['avgDwellSeconds', 180],
    ['paymentRatio', 1],
    ['safetyFactor', 0.5],
    ['admissionTargetMax', 8000],
  ]);
  assert.equal(v.predicted[0].assumptions.length, 2);
  assert.deepStrictEqual(v.unavailable, [{ key: `admissionTargetCapNow:${E}`, source: 'prediction', reason: `input-unavailable:currentPgTps:${E}` }]);
});
