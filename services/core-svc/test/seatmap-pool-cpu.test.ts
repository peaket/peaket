// 좌석맵 해석 작업 풀의 시간 상한 경계를 가짜 스레드·가짜 시계로 본다(BAT-174, docs/features/seat-hold.md S-T34 ④).
// 정본 값: 해석 하나는 CPU 5초 [가정]·힙 384MiB [가정]로 끊고, core-svc 데드라인은 10초 [가정]다(docs/verification.md §4.1 좌석맵 가져오기 해석 줄).
// 단언 값은 정본에서 적고 코드 상수(PARSE_TIMEOUT_MS 등)를 가져오지 않는다. 풀은 옵션 없이 만들어 기본 상한을 쓴다.
// 가짜 스레드(node:worker_threads의 Worker 대역)는 시험이 정한 CPU 사용량(사용자·커널, 마이크로초)을 cpuUsage로 돌려주고, 시계는 가짜라 벽시계 5·10초를 곧바로 넘긴다.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PoolOutcome } from '../src/seatmap-worker/pool.js';

interface Cpu {
  user: number;
  system: number;
}
interface FakeThread extends EventEmitter {
  options: { env?: unknown; execArgv?: unknown; resourceLimits?: { maxOldGenerationSizeMb?: number } };
  cpu: Cpu;
  posted: unknown[];
  terminateCalls: number;
  /** 정하면 terminate()가 이 약속이 풀릴 때까지 끝나지 않는다 */
  exitGate?: Promise<void>;
}

const h = vi.hoisted(() => ({ threads: [] as FakeThread[] }));

vi.mock('node:worker_threads', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class Worker extends Emitter {
    cpu: Cpu = { user: 0, system: 0 };
    posted: unknown[] = [];
    terminateCalls = 0;
    exitGate?: Promise<void>;
    constructor(
      readonly url: URL,
      readonly options: FakeThread['options'],
    ) {
      super();
      h.threads.push(this as unknown as FakeThread);
    }
    postMessage(m: unknown) {
      this.posted.push(m);
    }
    cpuUsage(prev?: Cpu): Promise<Cpu> {
      const now = { ...this.cpu };
      return Promise.resolve(prev ? { user: now.user - prev.user, system: now.system - prev.system } : now);
    }
    terminate(): Promise<number> {
      this.terminateCalls++;
      return (this.exitGate ?? Promise.resolve()).then(() => 1);
    }
  }
  return { Worker };
});

const { ParsePool } = await import('../src/seatmap-worker/pool.js');

const MS = 1_000; // 마이크로초
/** 'ready' 전(스레드가 실리는 동안)에 쓴 CPU: 해석 시간에 넣지 않는다 */
const STARTUP_CPU: Cpu = { user: 700 * MS, system: 300 * MS };
const RESULT = { kind: 'result', status: 'REJECTED', errors: [], ignored: [] } as const;

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** 기본 상한 풀에 해석 하나를 넣고, 가짜 스레드가 다 실려 'ready'를 보낸 뒤까지 진행한다 */
async function started(pool = new ParsePool({ threadUrl: new URL('file:///pool-test-thread.mjs') })) {
  let settled: PoolOutcome | undefined;
  const run = pool.run(new TextEncoder().encode('<svg/>'), 'SVG').then((o) => (settled = o));
  const w = h.threads.at(-1)!;
  w.cpu = { ...STARTUP_CPU };
  w.emit('message', { kind: 'ready' });
  await flush();
  /** 'ready' 뒤 쓴 CPU를 정한다(사용자 + 커널) */
  const used = (user: number, system = 0) => (w.cpu = { user: STARTUP_CPU.user + user, system: STARTUP_CPU.system + system });
  return { pool, w, run, used, outcome: () => settled };
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

beforeEach(() => {
  h.threads.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('좌석맵 해석 작업 풀: CPU 5초 상한의 경계', () => {
  test('BAT-174 S-T34 ④ 해석 CPU가 5초 직전(4,999.999ms)이면 벽시계가 5초를 넘어도 자르지 않고 결과를 돌려준다', async () => {
    const s = await started();
    expect(s.w.posted).toHaveLength(1); // 'ready' 뒤에 파일을 보냈다
    s.used(2_999_999, 2_000 * MS);
    await advance(6_000);
    expect(s.outcome()).toBeUndefined();
    expect(s.w.terminateCalls).toBe(0);
    s.w.emit('message', RESULT);
    await flush();
    expect(s.outcome()).toEqual({ kind: 'result', reply: RESULT });
  });

  test('BAT-174 S-T34 ④ 해석 CPU(사용자 + 커널)가 5초에 닿으면 cpu-limit이고 스레드를 끝낸다', async () => {
    const s = await started();
    // 벽시계는 아직 5초 전이다: 벽시계가 아니라 CPU로 자른다
    s.used(3_000 * MS, 2_000 * MS);
    await advance(100);
    expect(s.outcome()).toEqual({ kind: 'cpu-limit' });
    expect(s.w.terminateCalls).toBeGreaterThanOrEqual(1);
  });

  test("BAT-174 S-T34 ④ 'ready' 전에 쓴 CPU는 상한에 들지 않는다(실린 뒤 4,999.999ms면 합이 5초를 넘어도 자르지 않는다)", async () => {
    const s = await started();
    // 실리는 데 1초 + 해석 4,999.999ms = 5,999.999ms
    s.used(4_999_999);
    await advance(1_000);
    expect(s.outcome()).toBeUndefined();
    s.used(5_000 * MS);
    await advance(100);
    expect(s.outcome()).toEqual({ kind: 'cpu-limit' });
  });

  test('BAT-174 S-T34 ④ CPU를 거의 쓰지 않고 멈춘 스레드는 벽시계 10초(core-svc 데드라인)에 끝내고 cpu-limit이 아니라 failed다', async () => {
    const s = await started();
    s.used(10 * MS);
    await advance(10_000 - 1);
    expect(s.outcome()).toBeUndefined();
    await advance(1);
    expect(s.outcome()).toEqual({ kind: 'failed' });
    expect(s.w.terminateCalls).toBeGreaterThanOrEqual(1);
  });

  test('BAT-174 S-T34 ④ 잘린 스레드가 다 끝난 뒤에 답하고, 그때까지 다음 차례의 새 스레드를 띄우지 않는다', async () => {
    const pool = new ParsePool({ threadUrl: new URL('file:///pool-test-thread.mjs') });
    const s = await started(pool);
    let exited!: () => void;
    s.w.exitGate = new Promise<void>((r) => (exited = r));
    let second: PoolOutcome | undefined;
    void pool.run(new TextEncoder().encode('<svg/>'), 'SVG').then((o) => (second = o));
    s.used(5_000 * MS);
    await advance(100);
    expect(s.w.terminateCalls).toBeGreaterThanOrEqual(1);
    expect(s.outcome()).toBeUndefined();
    expect(h.threads).toHaveLength(1);
    exited();
    await flush();
    expect(s.outcome()).toEqual({ kind: 'cpu-limit' });
    expect(h.threads).toHaveLength(2);
    expect(second).toBeUndefined();
  });

  test('BAT-174 S-T34 ④ 기본 스레드는 힙 384MiB로 띄우고 환경 값·실행 인자를 넘기지 않는다', async () => {
    const s = await started();
    expect(s.w.options).toMatchObject({ env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 384 } });
  });
});
