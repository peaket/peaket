// CS 처리함 기한 알림 한 바퀴(F-06-2 GAT-280, R-T50 ②③, R-T12·R-T20 ①의 1영업일 전 알림). 시험 담당 lane3-f062-test.
// 실제 ops-svc 조립(메모리)의 기한 알림 작업(CsCaseDeadlineTick)과 운영 경보 원장(AlertsModule의 저장소)을 쓰고, 시계는 가짜 시계로 넘긴다.
// 정본: ADR-0364 결정 3(1영업일 전이 지나면 CS_CASE_DUE_SOON SEV3, 기한이 지나면 CS_CASE_OVERDUE SEV2를 건마다·기한마다 한 번,
// 세부는 건 ID·종류·기한 종류(PROGRESS·RESULT)·기한·담당자·받는 사람(ASSIGNEE·CS_LEAD)만, 해결하면 푼다), docs/features/transfer-refund.md §11 R-T50 ②③.
// 공휴일은 시험이 만든 날(2026-11-25 수)이다. 시작은 금 2026-11-20 23:30 KST.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { OPS_ALERT_STORE, type MemoryOpsAlertStore } from '../src/modules/alerts/index.js';
import { CsCaseDeadlineTick } from '../src/modules/cases/index.js';
import { BD1, BD10, BD3, caseRequest, csHarness, type CsHarness } from './cs-support.js';

let h: CsHarness;
let alerts: MemoryOpsAlertStore;
let tick: CsCaseDeadlineTick;
beforeEach(async () => {
  h = await csHarness();
  alerts = h.svc.app.get<MemoryOpsAlertStore>(OPS_ALERT_STORE);
  tick = h.svc.app.get(CsCaseDeadlineTick);
});
afterEach(async () => {
  await h.close();
});

const ms = (iso: string): number => Date.parse(iso);
/** 시계를 그 시각으로 옮기고 배경 작업을 두 번 돌린다 */
async function runTwiceAt(iso: string | number): Promise<void> {
  const t = typeof iso === 'number' ? iso : ms(iso);
  if (t > h.clock.now()) h.clock.advance(t - h.clock.now());
  await tick.run(h.clock.now());
  await tick.run(h.clock.now());
}
const ofCase = (caseId: string) => alerts.alerts.filter((a) => a.detail.caseId === caseId);
const summary = (caseId: string) => ofCase(caseId).map((a) => ({ kind: a.kind, severity: a.severity, dueAt: a.detail.dueAt, open: a.resolvedAtMs === undefined }));
const FAN_FIELDS = /name|phone|email|contact|account(?!Id)|bank|fan/i;

describe('R-T50 ② 경계 네 시각 × 두 번 돌리기', () => {
  test('R-T50 ② R-T20 ① 환불 대기(3영업일): 1영업일 전 − 1ms 경보 0, 1영업일 전 DUE_SOON SEV3 하나, 기한 − 1ms OVERDUE 0, 기한에 SEV2 하나', async () => {
    const id = (await h.intake(caseRequest('REFUND_ACCOUNT_PENDING', { category: 'REFUND' }))).body.caseId!;
    const soonAt = '2026-11-24T14:30:00.000Z'; // BD3(목 23:30 KST)에서 1영업일 전: 수(공휴일)를 건너 화 23:30 KST

    await runTwiceAt(ms(soonAt) - 1);
    expect(summary(id)).toEqual([]);
    await runTwiceAt(soonAt);
    expect(summary(id)).toEqual([{ kind: 'CS_CASE_DUE_SOON', severity: 'SEV3', dueAt: BD3, open: true }]);
    await runTwiceAt(ms(BD3) - 1);
    expect(summary(id)).toEqual([{ kind: 'CS_CASE_DUE_SOON', severity: 'SEV3', dueAt: BD3, open: true }]);
    await runTwiceAt(BD3);
    expect(summary(id)).toEqual([
      { kind: 'CS_CASE_DUE_SOON', severity: 'SEV3', dueAt: BD3, open: true },
      { kind: 'CS_CASE_OVERDUE', severity: 'SEV2', dueAt: BD3, open: true },
    ]);
    // 목록의 기한 상태도 서버가 센 넘김이다
    expect((await h.get(h.as('cs_agent'), id)).body.dueState).toBe('OVERDUE');
  });

  test('R-T50 ② 경보 세부는 건 ID·종류·기한 종류·기한·담당자·받는 사람(ASSIGNEE·CS_LEAD)뿐이고 팬 정보가 없다', async () => {
    const agent = h.as('cs_agent');
    const id = (await h.intake(caseRequest('SCANNER_UNREPORTED', { category: 'QUEUE_NOT_FLUSHED' }))).body.caseId!;
    expect((await h.patch(agent, id, { assignee: agent['x-user-id'] }, '"1"')).status).toBe(200);
    // 진행 기한 BD1(월 23:30 KST)의 1영업일 전은 금 23:30 KST = 시작 시각이라 열리자마자 임박이다
    await runTwiceAt(h.clock.now());
    const [a, ...rest] = ofCase(id);
    expect(rest).toEqual([]);
    expect([a!.kind, a!.severity, a!.source]).toEqual(['CS_CASE_DUE_SOON', 'SEV3', 'ops-svc']);
    expect(Object.keys(a!.detail)).toHaveLength(6);
    expect(Object.values(a!.detail)).toEqual(expect.arrayContaining([id, 'SCANNER_UNREPORTED', 'PROGRESS', BD1, agent['x-user-id'], ['ASSIGNEE', 'CS_LEAD']]));
    expect(Object.keys(a!.detail).filter((k) => FAN_FIELDS.test(k))).toEqual([]);
  });

  test('R-T12 ① 분쟁 건은 진행 기한(3영업일)과 결과 기한(10영업일)마다 한 번씩 알린다', async () => {
    const id = (await h.intake(caseRequest('DISPUTE', { category: 'INQUIRY_DISPUTE' }))).body.caseId!;
    await runTwiceAt(BD3);
    const progressOnly = ofCase(id).map((a) => [a.kind, a.detail.dueAt]);
    expect(progressOnly).toEqual([
      ['CS_CASE_DUE_SOON', BD3],
      ['CS_CASE_OVERDUE', BD3],
    ]);
    // 결과 기한 BD10(수 12-09 23:30 KST)의 1영업일 전: 화 12-08 23:30 KST
    await runTwiceAt(ms('2026-12-08T14:30:00.000Z') - 1);
    expect(ofCase(id)).toHaveLength(2);
    await runTwiceAt('2026-12-08T14:30:00.000Z');
    expect(ofCase(id).map((a) => [a.kind, a.detail.dueAt])).toEqual([
      ['CS_CASE_DUE_SOON', BD3],
      ['CS_CASE_OVERDUE', BD3],
      ['CS_CASE_DUE_SOON', BD10],
    ]);
  });
});

// F-06-2 검증 1 놓친 표본 3 반영(시험 담당 lane3-f062-test): 경보 원장의 같은 키 한 번 받기가 가려 주지 않게, 같은 기한의 경보는 건 표시(cs_case.due_soon_alerted_for·overdue_alerted_for)로
// 한 번만 연다는 것을 따로 본다(ADR-0364 결정 3 '같은 기한은 한 번', data.md due_soon_alerted_for 'next_due_at과 같으면 다시 열지 않는다')
describe('R-T50 ② 같은 기한의 경보는 건 표시로 한 번만 연다', () => {
  test('R-T50 ② 첫 바퀴가 연 경보를 밖에서 풀어도 다음 바퀴는 같은 기한의 경보를 다시 열지 않고, 두 번째 바퀴의 연 수는 0이다', async () => {
    const id = (await h.intake(caseRequest('REFUND_ACCOUNT_PENDING', { category: 'REFUND' }))).body.caseId!;
    const at = ms(BD3); // 1영업일 전과 기한이 모두 지난 시각
    h.clock.advance(at - h.clock.now());
    expect(await tick.run(at)).toEqual({ dueSoon: 1, overdue: 1, resolved: 0 });
    // 운영자가 경보 원장에서 두 경보를 손으로 풀었다(건은 열린 채)
    for (const a of ofCase(id)) await alerts.resolve({ eventKey: a.eventKey, kind: a.kind, reason: '운영자가 확인함', nowMs: at });
    expect(summary(id).map((a) => a.open)).toEqual([false, false]);
    expect(await tick.run(at + 60_000)).toEqual({ dueSoon: 0, overdue: 0, resolved: 0 });
    expect(summary(id).map((a) => [a.kind, a.open])).toEqual([
      ['CS_CASE_DUE_SOON', false],
      ['CS_CASE_OVERDUE', false],
    ]);
  });

  test('R-T50 ② 1영업일 전 경보만 연 뒤 다음 바퀴(기한 전)의 연 수는 0이다', async () => {
    await h.intake(caseRequest('REFUND_ACCOUNT_PENDING', { category: 'REFUND' }));
    const soon = ms('2026-11-24T14:30:00.000Z');
    expect(await tick.run(soon)).toEqual({ dueSoon: 1, overdue: 0, resolved: 0 });
    expect(await tick.run(soon + 60_000)).toEqual({ dueSoon: 0, overdue: 0, resolved: 0 });
  });
});

describe('R-T50 ③ 해결하면 경보가 풀린다', () => {
  test('R-T50 ③ 두 경보가 열린 건을 해결하면 둘 다 풀리고 그 뒤 새 경보 0이다', async () => {
    const agent = h.as('cs_agent');
    const id = (await h.intake(caseRequest('REFUND_FAILED', { category: 'REFUND' }))).body.caseId!;
    await runTwiceAt(BD3);
    expect(summary(id).map((a) => [a.kind, a.open])).toEqual([
      ['CS_CASE_DUE_SOON', true],
      ['CS_CASE_OVERDUE', true],
    ]);
    const done = await h.patch(agent, id, { status: 'RESOLVED', resultNote: '같은 멱등키로 재처리했다' }, '"1"');
    expect(done.status).toBe(200);
    expect(summary(id).map((a) => [a.kind, a.open])).toEqual([
      ['CS_CASE_DUE_SOON', false],
      ['CS_CASE_OVERDUE', false],
    ]);
    await runTwiceAt(ms(BD3) + 86_400_000);
    expect(ofCase(id)).toHaveLength(2);
    expect(summary(id).every((a) => !a.open)).toBe(true);
  });

  test('R-T50 ③ 다른 열린 건의 경보는 남는다(해결한 건만 푼다)', async () => {
    const agent = h.as('cs_agent');
    const a = (await h.intake(caseRequest('REFUND_FAILED', { category: 'REFUND' }))).body.caseId!;
    const b = (await h.intake(caseRequest('REFUND_FAILED', { category: 'REFUND' }))).body.caseId!;
    await runTwiceAt(BD3);
    await h.patch(agent, a, { status: 'RESOLVED', resultNote: '재처리' }, '"1"');
    await runTwiceAt(ms(BD3) + 60_000);
    expect(summary(b).map((x) => [x.kind, x.open])).toEqual([
      ['CS_CASE_DUE_SOON', true],
      ['CS_CASE_OVERDUE', true],
    ]);
  });
});
