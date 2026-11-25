// F-02-5(OPS-300) admission-ctrl 사전 모의 센 값: 리더가 회차마다 남긴 마지막 주기 값을 읽기 전용 PreviewControl로 준다
// (ADR-0365 결정 11 표의 명령 1 키 여덟, 결정 16 '리더만 답하고(아니면 UNAVAILABLE not-leader) 리더가 바뀐 뒤 첫 주기 전이면 no-cycle',
// '받는 쪽이 세지 않는 키는 unavailable(unknown-key)이고 오류가 아니다', '아무것도 쓰지 않는다', keys 1~16개, 범위는 소문자 UUID 회차).
// 계획 docs/review/plans/F-02-5.md 8.1·8.3의 이름 그대로: LeaderCycleSnapshots·ADMISSION_PREVIEW_KEYS·PreviewLeader·previewAdmissionControl·AdmissionControlDeps.preview.
// 리더 주기 값은 저장소가 아니라 진짜 LeaderCycleSnapshots에 직접 남긴다(주기가 남기는지는 test-int/f025-preview-leader.int.test.ts가 실제 시작 파일로 본다).
// 리더 여부는 Elector 짝 가짜 { isLeader() }(계획 8.3), 쓰기 경로(ApplyLeaderControl의 저장소)는 불리면 기록하는 짝 가짜로 두어 '쓰지 않는다'를 센다.
// 시험 이름: C-T6 ①(센 값 = 마지막 주기 값), 장부 밖 세부는 F025-PREVIEW(B21·B22, ADR-0365 결정 18).
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { describe, expect, test } from 'vitest';
import { previewAdmissionControl, type AdmissionControlDeps } from '../src/control/control-server.js';
import { ADMISSION_PREVIEW_KEYS, ApplyLeaderControl, LeaderCycleSnapshots, PreviewLeader, type LeaderStore } from '../src/modules/leader/index.js';

/** 정본 키 여덟(ADR-0365 결정 11 표, ops-svc DRY_RUN_KEYS.ADMISSION_TARGET과 같은 글) */
const CANON_KEYS = ['currentTarget', 'slotsUsed', 'soonAdmitted', 'inFlight', 'admitRatio', 'avgDwellSeconds', 'servingRateCap', 'servingRate'];
/** 사유 글(계획 8.1 'unavailable 사유 글', 정확히 이 글) */
const NO_CYCLE = 'no-cycle';
const NO_SOURCE = 'no-source';
const UNKNOWN_KEY = 'unknown-key';
const NOT_LEADER = 'not-leader';
/** 계획 8.1 keys 상한(1~16개) */
const MAX_KEYS = 16;

const CYCLE_AT = Date.parse('2026-12-05T11:00:00.200Z');

/** 리더 여부를 바꿀 수 있는 짝 가짜(PreviewLeader의 elector 포트 { isLeader(): boolean }) */
function leaderFlag(initial: boolean) {
  let leader = initial;
  return { elector: { isLeader: () => leader }, set: (v: boolean) => (leader = v) };
}

/** ApplyLeaderControl의 저장소 짝 가짜. 사전 모의가 쓰기 경로에 닿으면 calls에 남는다 */
function writeTrap() {
  const calls: string[] = [];
  const store: Pick<LeaderStore, 'applyControl' | 'schedule' | 'checkPlatform'> = {
    applyControl: async () => {
      calls.push('applyControl');
      return { kind: 'OK', appliedVersion: 1, changed: false };
    },
    schedule: async () => {
      calls.push('schedule');
      return null;
    },
    checkPlatform: async () => {
      calls.push('checkPlatform');
      return 'OK';
    },
  };
  const fence = { isFenced: () => false, markFenced: () => calls.push('markFenced') };
  return { calls, apply: new ApplyLeaderControl(store, { generation: () => 7 }, fence) };
}

function world(o: { leader?: boolean } = {}) {
  const snapshots = new LeaderCycleSnapshots();
  const flag = leaderFlag(o.leader ?? true);
  const preview = new PreviewLeader({ elector: flag.elector, snapshots });
  const trap = writeTrap();
  const deps: AdmissionControlDeps = { apply: trap.apply, podName: 'admission-ctrl-0', nowMs: () => CYCLE_AT + 5_000, preview };
  return { snapshots, flag, preview, trap, deps };
}

/** proto PreviewControlRequest의 칸(snake 그대로 받는 쪽에 넘어오는 꼴) */
const req = (o: { scope?: string; kind?: string; keys?: readonly string[] } = {}): Record<string, unknown> => ({
  scope: o.scope ?? randomUUID(),
  kind: o.kind ?? 'CONTROL_KIND_ADMISSION_TARGET',
  keys: [...(o.keys ?? ['currentTarget'])],
});

/** 시험 값: 리더 주기가 낸 값(상수와 겹치지 않게 고른 값) */
const CYCLE_VALUES = { currentTarget: 3_217, slotsUsed: 1_904, soonAdmitted: 233, inFlight: 41, admitRatio: 0.73, servingRateCap: 87 };

describe('F025-PREVIEW admission-ctrl 리더 주기 값 남기기와 키 목록 (B20·B21)', () => {
  test('F025-PREVIEW ① ADMISSION_PREVIEW_KEYS는 정본 명령 1 키 여덟과 같은 글이다', () => {
    expect([...ADMISSION_PREVIEW_KEYS].sort()).toEqual([...CANON_KEYS].sort());
    expect(new Set(ADMISSION_PREVIEW_KEYS).size).toBe(CANON_KEYS.length);
  });

  test('F025-PREVIEW ② LeaderCycleSnapshots는 회차마다 마지막 주기 값만 둔다(다른 회차와 섞이지 않고, 본 적 없는 회차는 undefined)', () => {
    const s = new LeaderCycleSnapshots();
    const a = randomUUID();
    const b = randomUUID();
    s.record(a, CYCLE_AT, { currentTarget: 100 });
    s.record(b, CYCLE_AT + 1, { currentTarget: 9 });
    s.record(a, CYCLE_AT + 200, { currentTarget: 10, slotsUsed: 4 });
    expect(s.latest(a)).toEqual({ atMs: CYCLE_AT + 200, values: { currentTarget: 10, slotsUsed: 4 } });
    expect(s.latest(b)).toEqual({ atMs: CYCLE_AT + 1, values: { currentTarget: 9 } });
    expect(s.latest(randomUUID())).toBeUndefined();
  });
});

describe('C-T6 ① admission-ctrl PreviewLeader 센 값 (B20)', () => {
  test('C-T6 ① 명령 1 키의 센 값은 그 회차 마지막 리더 주기의 값이고 measuredAtMs는 그 주기의 시각이다', () => {
    const w = world();
    const e = randomUUID();
    w.snapshots.record(e, CYCLE_AT - 200, { currentTarget: 1, slotsUsed: 2 });
    w.snapshots.record(e, CYCLE_AT, CYCLE_VALUES);
    const r = w.preview.run({ scope: e, keys: ['currentTarget', 'slotsUsed', 'soonAdmitted', 'inFlight', 'admitRatio'] });
    expect(r.status).toBe('OK');
    if (r.status !== 'OK') return;
    const byKey = Object.fromEntries(r.counts.map((c) => [c.key, c]));
    expect(Object.keys(byKey).sort()).toEqual(['admitRatio', 'currentTarget', 'inFlight', 'slotsUsed', 'soonAdmitted']);
    expect(byKey.currentTarget).toMatchObject({ value: 3_217, measuredAtMs: CYCLE_AT });
    expect(byKey.slotsUsed).toMatchObject({ value: 1_904, measuredAtMs: CYCLE_AT });
    expect(byKey.soonAdmitted).toMatchObject({ value: 233, measuredAtMs: CYCLE_AT });
    expect(byKey.inFlight).toMatchObject({ value: 41, measuredAtMs: CYCLE_AT });
    expect(byKey.admitRatio).toMatchObject({ value: 0.73, measuredAtMs: CYCLE_AT });
    for (const c of r.counts) expect(c.source, '출처는 비지 않은 이름이다').toMatch(/^[a-z][a-z0-9:_-]*$/);
    expect(r.unavailable).toEqual([]);
  });

  test('C-T6 ① 요청하지 않은 키는 돌려주지 않는다(같은 주기의 다른 값이 있어도)', () => {
    const w = world();
    const e = randomUUID();
    w.snapshots.record(e, CYCLE_AT, CYCLE_VALUES);
    const r = w.preview.run({ scope: e, keys: ['soonAdmitted'] });
    expect(r).toMatchObject({ status: 'OK', unavailable: [] });
    if (r.status !== 'OK') return;
    expect(r.counts.map((c) => [c.key, c.value])).toEqual([['soonAdmitted', 233]]);
  });
});

describe('F025-PREVIEW admission-ctrl 세지 못함은 0이 아니라 unavailable (B21)', () => {
  test('F025-PREVIEW ③ 리더가 아니면 마지막 주기 값이 남아 있어도 NOT_LEADER다', () => {
    const w = world({ leader: false });
    const e = randomUUID();
    w.snapshots.record(e, CYCLE_AT, CYCLE_VALUES);
    expect(w.preview.run({ scope: e, keys: ['currentTarget'] })).toEqual({ status: 'NOT_LEADER' });
    w.flag.set(true);
    expect(w.preview.run({ scope: e, keys: ['currentTarget'] }).status).toBe('OK');
  });

  test('F025-PREVIEW ④ 그 회차의 주기가 아직 없으면(리더가 바뀐 뒤 첫 주기 전) 요청한 키마다 no-cycle이고 센 값은 0개다', () => {
    const w = world();
    const other = randomUUID();
    w.snapshots.record(other, CYCLE_AT, CYCLE_VALUES);
    const r = w.preview.run({ scope: randomUUID(), keys: ['currentTarget', 'slotsUsed'] });
    expect(r).toMatchObject({ status: 'OK', counts: [] });
    if (r.status !== 'OK') return;
    expect([...r.unavailable].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'currentTarget', reason: NO_CYCLE },
      { key: 'slotsUsed', reason: NO_CYCLE },
    ]);
  });

  test('F025-PREVIEW ⑤ 명령 1 키이지만 리더가 그 주기에 계산하지 않은 값은 no-source, 명령 1 키가 아닌 글은 unknown-key이고 둘 다 0으로 적지 않는다', () => {
    const w = world();
    const e = randomUUID();
    // avgDwellSeconds·servingRate는 이 주기 값에 없다(정할 것 2: 리더가 계산하지 않는 값은 no-source)
    w.snapshots.record(e, CYCLE_AT, CYCLE_VALUES);
    const r = w.preview.run({ scope: e, keys: ['avgDwellSeconds', 'servingRate', 'purchaseSessions', 'currentTarget'] });
    expect(r.status).toBe('OK');
    if (r.status !== 'OK') return;
    expect(r.counts.map((c) => c.key)).toEqual(['currentTarget']);
    expect([...r.unavailable].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'avgDwellSeconds', reason: NO_SOURCE },
      { key: 'purchaseSessions', reason: UNKNOWN_KEY },
      { key: 'servingRate', reason: NO_SOURCE },
    ]);
  });
});

describe('F025-PREVIEW admission-ctrl 제어 포트 PreviewControl 꼴 (B22)', () => {
  test('F025-PREVIEW ⑥ 리더면 마지막 주기 값과 파드 이름을 주고 쓰기 경로(ApplyLeaderControl 저장소)는 한 번도 부르지 않는다', async () => {
    const w = world();
    const e = randomUUID();
    w.snapshots.record(e, CYCLE_AT, CYCLE_VALUES);
    const r = await previewAdmissionControl(req({ scope: e, keys: ['currentTarget', 'servingRateCap'] }), w.deps);
    expect(r.podName).toBe('admission-ctrl-0');
    expect(r.counts.map((c) => [c.key, c.value, c.measuredAtMs]).sort()).toEqual([
      ['currentTarget', 3_217, CYCLE_AT],
      ['servingRateCap', 87, CYCLE_AT],
    ]);
    expect(r.unavailable).toEqual([]);
    expect(w.trap.calls).toEqual([]);
  });

  test('F025-PREVIEW ⑦ 리더가 아니면 UNAVAILABLE not-leader이고 아무것도 쓰지 않는다', async () => {
    const w = world({ leader: false });
    await expect(previewAdmissionControl(req(), w.deps)).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE, message: NOT_LEADER });
    expect(w.trap.calls).toEqual([]);
  });

  test('F025-PREVIEW ⑧ 범위가 소문자 UUID가 아니면(대문자 UUID·PLATFORM·빈 글·UUID 아님) INVALID_ARGUMENT다', async () => {
    const w = world();
    for (const scope of [randomUUID().toUpperCase(), 'PLATFORM', '', 'not-a-uuid', `${randomUUID()}x`]) {
      await expect(previewAdmissionControl(req({ scope }), w.deps), `scope=${scope}`).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    }
    expect(w.trap.calls).toEqual([]);
  });

  test('F025-PREVIEW ⑨ keys가 0개·17개면 INVALID_ARGUMENT이고 16개(상한 정각)는 받는다', async () => {
    const w = world();
    const e = randomUUID();
    w.snapshots.record(e, CYCLE_AT, CYCLE_VALUES);
    await expect(previewAdmissionControl(req({ scope: e, keys: [] }), w.deps)).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    const sixteen = [...CANON_KEYS, ...Array.from({ length: MAX_KEYS - CANON_KEYS.length }, (_, i) => `extra${i}`)];
    expect(sixteen).toHaveLength(16);
    const ok = await previewAdmissionControl(req({ scope: e, keys: sixteen }), w.deps);
    expect(ok.counts.length + ok.unavailable.length).toBe(16);
    expect(ok.unavailable.filter((u) => u.key.startsWith('extra')).every((u) => u.reason === UNKNOWN_KEY)).toBe(true);
    await expect(previewAdmissionControl(req({ scope: e, keys: [...sixteen, 'extra99'] }), w.deps)).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
  });

  test('F025-PREVIEW ⑩ kind가 CONTROL_KIND_ADMISSION_TARGET이 아니면 UNIMPLEMENTED다(명령 3 키는 purchase-svc·queue-svc 몫)', async () => {
    const w = world();
    for (const kind of ['CONTROL_KIND_SALE_PAUSE', 'CONTROL_KIND_ADMISSION_PAUSE', 'CONTROL_KIND_AUTOMATION_STOP', '']) {
      await expect(previewAdmissionControl(req({ kind }), w.deps), `kind=${kind}`).rejects.toMatchObject({ code: grpc.status.UNIMPLEMENTED });
    }
  });

  test('F025-PREVIEW ⑪ 사전 모의 받는 쪽을 조립하지 않은 파드(preview 없음)는 UNIMPLEMENTED다', async () => {
    const w = world();
    const { preview: _omit, ...rest } = w.deps;
    await expect(previewAdmissionControl(req(), rest)).rejects.toMatchObject({ code: grpc.status.UNIMPLEMENTED });
  });
});
