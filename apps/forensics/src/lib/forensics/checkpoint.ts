// F-04-9 좌석 상태 체크포인트와 재구성. 정본: docs/features/forensic-replay.md §3.4·§8 FX-T3.
// 체크포인트 전체가 32MB를 넘지 않게 간격을 정하고, 재생 시각 앞 체크포인트에서 시작해 그 뒤 사건만 적용한다.
// 경합 표시는 저장하지 않는다(재생할 때 앞뒤 1초로 계산한다).
import { ceilPositive } from './math.ts';
import {
  EVENT_KIND,
  NO_SEAT,
  RESULT,
  SEAT_STATE,
  type EventColumns,
} from './events.ts';

export const CHECKPOINT_BUDGET_BYTES = 32 * 1024 * 1024;

export interface CheckpointTarget {
  seatCount: number;
  windowMs: number;
}

export interface Checkpoints {
  /** 각 체크포인트의 시각(ms). 간격마다 하나이고 마지막은 windowMs보다 작거나 같다. */
  times: Int32Array;
  /** times.length × seatCount 바이트. 체크포인트 i의 상태는 data.subarray(i*seatCount, …)다. */
  data: Uint8Array;
  seatCount: number;
  intervalMs: number;
}

/** 정본 §3.4: 간격(초) = max(1, 올림(회차 길이(초) × 좌석 수 ÷ 32MB)). */
export function checkpointIntervalMs(windowMs: number, seatCount: number, budgetBytes: number = CHECKPOINT_BUDGET_BYTES): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 1_000;
  if (!Number.isFinite(seatCount) || seatCount <= 0) return 1_000;
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) return 1_000;
  const raw = ((windowMs / 1_000) * seatCount) / budgetBytes;
  return Math.max(1_000, ceilPositive(raw) * 1_000);
}

function applyEvent(state: Uint8Array, columns: EventColumns, index: number): void {
  const seat = columns.seat[index];
  if (seat === NO_SEAT || seat >= state.length) return;
  const kind = columns.kind[index];
  if (kind === EVENT_KIND.HOLD_TRY && columns.result[index] === RESULT.HELD) {
    if (state[seat] === SEAT_STATE.EMPTY) state[seat] = SEAT_STATE.HELD;
  } else if (kind === EVENT_KIND.HOLD_END) {
    if (state[seat] === SEAT_STATE.HELD) state[seat] = SEAT_STATE.EMPTY;
  } else if (kind === EVENT_KIND.PAY_TRY) {
    if (state[seat] !== SEAT_STATE.SOLD) state[seat] = SEAT_STATE.PAYING;
  } else if (kind === EVENT_KIND.SALE) {
    if (state[seat] === SEAT_STATE.PAYING) state[seat] = SEAT_STATE.SOLD;
  } else if (kind === EVENT_KIND.PAY_FAIL) {
    if (state[seat] === SEAT_STATE.PAYING) state[seat] = SEAT_STATE.EMPTY;
  }
}

/** first > target인 첫 사건 위치. 사건 시각은 비내림차순이어야 한다. */
function firstAfter(times: Int32Array, target: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (times[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function buildCheckpoints(columns: EventColumns, target: CheckpointTarget): Checkpoints {
  const intervalMs = checkpointIntervalMs(target.windowMs, target.seatCount);
  const count = Math.max(1, Math.floor(target.windowMs / intervalMs));
  const times = new Int32Array(count);
  const data = new Uint8Array(count * target.seatCount);
  const state = new Uint8Array(target.seatCount);
  let cursor = 0;

  for (let i = 0; i < count; i += 1) {
    const time = i * intervalMs;
    times[i] = time;
    while (cursor < columns.t_ms.length && columns.t_ms[cursor] <= time) {
      applyEvent(state, columns, cursor);
      cursor += 1;
    }
    data.set(state, i * target.seatCount);
  }

  return { times, data, seatCount: target.seatCount, intervalMs };
}

/**
 * 시각 t의 좌석 상태를 만든다. t 앞 체크포인트(같은 시각 포함)에서 시작해 (체크포인트, t] 사건만 적용한다.
 * t < 0이면 좌석 사건이 없으므로 빈 좌석 배열을 돌려준다.
 */
export function reconstructAt(checkpoints: Checkpoints, columns: EventColumns, tMs: number): Uint8Array {
  const state = new Uint8Array(checkpoints.seatCount);
  if (checkpoints.times.length === 0) return state;
  if (tMs < 0) {
    let cursor = 0;
    while (cursor < columns.t_ms.length && columns.t_ms[cursor] <= tMs) {
      applyEvent(state, columns, cursor);
      cursor += 1;
    }
    return state;
  }

  let index = Math.floor(tMs / checkpoints.intervalMs);
  if (index >= checkpoints.times.length) index = checkpoints.times.length - 1;
  if (index < 0) index = 0;
  const checkpointTime = checkpoints.times[index];
  state.set(checkpoints.data.subarray(index * checkpoints.seatCount, (index + 1) * checkpoints.seatCount));

  let cursor = firstAfter(columns.t_ms, checkpointTime);
  while (cursor < columns.t_ms.length && columns.t_ms[cursor] <= tMs) {
    applyEvent(state, columns, cursor);
    cursor += 1;
  }
  return state;
}
