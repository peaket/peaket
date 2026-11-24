// F-04-9 체크포인트 재구성 시험. 정본: docs/features/forensic-replay.md §3.4·§8 FX-T3.
// "처음부터 적용 = 체크포인트 + 이후 사건 = 생성기 정답"을 임의 시각 100곳에서 견준다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKPOINT_BUDGET_BYTES,
  buildCheckpoints,
  checkpointIntervalMs,
  reconstructAt,
} from './checkpoint.ts';
import { COLUMN_SPECS, EVENT_KIND, NO_SEAT, RESULT, SEAT_STATE, validateFile } from './events.ts';
import { defaultParams, generateScenario, seatStateAt } from './scenario.ts';
import { Xoshiro128 } from './prng.ts';

const PARAMS = {
  ...defaultParams('concert', 'checkpoint-seed'),
  seats: 1_200,
  sectionCount: 4,
  queueSize: 3_000,
  windowMs: 120_000,
  botRatio: 0.3,
};

function scenario() {
  const value = generateScenario(PARAMS);
  const result = validateFile({
    meta: value.meta,
    schema: COLUMN_SPECS.map((c) => ({ name: c.name, type: c.type })),
    columns: value.columns,
    envelope: { fileName: 'scenario.arrow', byteLength: 1, magicHead: 'ARROW1', magicTail: 'ARROW1' },
    openedSource: 'SYNTHETIC',
  });
  assert.equal(result.ok, true);
  assert.equal(result.dropped, 0);
  return value;
}

function applyEvent(state, columns, i) {
  const kind = columns.kind[i];
  const seat = columns.seat[i];
  if (seat === NO_SEAT || seat >= state.length) return;
  if (kind === EVENT_KIND.HOLD_TRY && columns.result[i] === RESULT.HELD) {
    if (state[seat] === SEAT_STATE.EMPTY) state[seat] = SEAT_STATE.HELD;
  } else if (kind === EVENT_KIND.HOLD_END) {
    if (state[seat] === SEAT_STATE.HELD) state[seat] = SEAT_STATE.EMPTY;
  } else if (kind === EVENT_KIND.PAY_TRY) {
    if (state[seat] === SEAT_STATE.HELD || state[seat] === SEAT_STATE.PAYING) state[seat] = SEAT_STATE.PAYING;
  } else if (kind === EVENT_KIND.SALE) {
    if (state[seat] === SEAT_STATE.PAYING) state[seat] = SEAT_STATE.SOLD;
  } else if (kind === EVENT_KIND.PAY_FAIL) {
    if (state[seat] === SEAT_STATE.PAYING) state[seat] = SEAT_STATE.EMPTY;
  }
}

function replayFromScratch(columns, seatCount, t) {
  const state = new Uint8Array(seatCount);
  for (let i = 0; i < columns.t_ms.length; i += 1) {
    if (columns.t_ms[i] > t) break;
    applyEvent(state, columns, i);
  }
  return state;
}

test('FX-T3 ① 체크포인트 간격이 정본의 두 예와 같고 32MB를 넘지 않는다', () => {
  assert.equal(checkpointIntervalMs(600_000, 50_000), 1_000);
  assert.equal(checkpointIntervalMs(1_800_000, 100_000), 6_000);
  assert.equal(checkpointIntervalMs(600_000, 100_000), 2_000);
  assert.equal(checkpointIntervalMs(60_000, 1_000), 1_000);
  assert.equal(CHECKPOINT_BUDGET_BYTES, 32 * 1024 * 1024);

  const cases = [
    [600_000, 50_000],
    [1_800_000, 100_000],
    [1_800_000, 50_000],
    [600_000, 10_000],
  ];
  for (const [windowMs, seats] of cases) {
    const interval = checkpointIntervalMs(windowMs, seats);
    const count = Math.ceil(windowMs / interval);
    assert.ok(count * seats <= CHECKPOINT_BUDGET_BYTES, `${windowMs}ms·${seats}석이 한도를 넘는다`);
  }
});

test('FX-T3 ② 임의 시각 100곳에서 세 결과가 같다', () => {
  const { columns, truth, meta } = scenario();
  const checkpoints = buildCheckpoints(columns, { seatCount: meta.seatCount, windowMs: meta.windowToMs });
  const rng = new Xoshiro128('checkpoint-times');
  for (let n = 0; n < 100; n += 1) {
    const t = rng.nextInt(meta.windowToMs + 1);
    const fromScratch = replayFromScratch(columns, meta.seatCount, t);
    const fromCheckpoint = reconstructAt(checkpoints, columns, t);
    const fromTruth = seatStateAt(truth, t);
    assert.deepEqual(fromCheckpoint, fromScratch, `t=${t}ms에서 체크포인트와 처음부터 적용이 다르다`);
    assert.deepEqual(fromCheckpoint, fromTruth, `t=${t}ms에서 체크포인트와 생성기 정답이 다르다`);
  }
});

test('FX-T3 ③ 경계 시각과 좌석 없는 사건을 견딘다', () => {
  const { columns, truth, meta } = scenario();
  const checkpoints = buildCheckpoints(columns, { seatCount: meta.seatCount, windowMs: meta.windowToMs });
  const first = columns.t_ms[0];
  const last = columns.t_ms[columns.t_ms.length - 1];
  const times = [-1, -600_000, 0, 1, 999, 1_000, 1_001, first, last, meta.windowToMs, meta.windowToMs + 10_000];
  for (const t of times) {
    const expected = t < 0 ? new Uint8Array(meta.seatCount) : replayFromScratch(columns, meta.seatCount, t);
    assert.deepEqual(reconstructAt(checkpoints, columns, t), expected, `t=${t}ms`);
    if (t >= 0) assert.deepEqual(reconstructAt(checkpoints, columns, t), seatStateAt(truth, t), `t=${t}ms 정답`);
  }
  assert.deepEqual(reconstructAt(checkpoints, columns, -1), new Uint8Array(meta.seatCount));
});

test('FX-T3 ④ 체크포인트 메모리가 32MB 이하이다', () => {
  const { columns, meta } = scenario();
  const checkpoints = buildCheckpoints(columns, { seatCount: meta.seatCount, windowMs: meta.windowToMs });
  assert.equal(checkpoints.intervalMs, 1_000);
  assert.equal(checkpoints.times.length, Math.ceil(meta.windowToMs / 1_000));
  assert.equal(checkpoints.data.length, checkpoints.times.length * meta.seatCount);
  assert.ok(checkpoints.data.length <= CHECKPOINT_BUDGET_BYTES);

  const limitInterval = checkpointIntervalMs(1_800_000, 100_000);
  const limitCount = Math.ceil(1_800_000 / limitInterval);
  assert.equal(limitCount, 300);
  assert.equal(limitCount * 100_000, 30_000_000);
  assert.ok(limitCount * 100_000 <= CHECKPOINT_BUDGET_BYTES);
});

test('FX-T3 ⑤ 마지막 시각의 상태가 생성기 정답과 같고 상태 값이 네 가지뿐이다', () => {
  const { columns, truth, meta } = scenario();
  const checkpoints = buildCheckpoints(columns, { seatCount: meta.seatCount, windowMs: meta.windowToMs });
  const final = reconstructAt(checkpoints, columns, meta.windowToMs);
  assert.deepEqual(final, seatStateAt(truth, meta.windowToMs));
  for (const value of final) assert.ok(value >= 0 && value <= 3);
  assert.ok(final.includes(SEAT_STATE.SOLD));
  assert.ok(final.includes(SEAT_STATE.HELD) || final.includes(SEAT_STATE.PAYING));
});
