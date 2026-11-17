// 합본 자식 멈추기(W9-fix2 계획 §9 보충, PRF-181, 리뷰 R2). 정본: docs/devops.md §6.4 '일반 서비스', docs/features/payment.md §2 '잡기'.
// payment-svc 자식은 SIGTERM 뒤 95초 [가정](실행기 최악 87.5초 + 닫기 여유) 기다린 뒤 SIGKILL하고, 다른 자식은 5초다.
// 가짜 타이머와 가짜 자식으로 돈다(실제 프로세스를 띄우지 않는다). 대기 값은 코드 상수를 쓰지 않고 정본 값을 박는다.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { childStopWaitMs, stopChildProcess, type StopChildTimers } from '../src/stop-child.js';

/** SIGTERM을 받아도 스스로 끝나지 않는 가짜 자식. exit()로 끝난 것처럼 만든다 */
function fakeChild(exitCode: number | null = null) {
  const signals: string[] = [];
  const exits: Array<(code: number | null, signal: string | null) => void> = [];
  const child = {
    exitCode,
    kill(sig?: NodeJS.Signals | number) {
      signals.push(String(sig));
      return true;
    },
    once(event: string, cb: (code: number | null, signal: string | null) => void) {
      if (event === 'exit') exits.push(cb);
      return child;
    },
  };
  const exit = (code = 0) => {
    child.exitCode = code;
    for (const cb of exits.splice(0)) cb(code, null);
  };
  return { child: child as unknown as Parameters<typeof stopChildProcess>[0], signals, exit };
}
/** 지금(useFakeTimers 뒤)의 전역 타이머 = 가짜 타이머 */
const timers = (): StopChildTimers => ({ setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (t) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>) });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('childStopWaitMs', () => {
  test('PRF181_payment-svc 자식은 95,000ms, 다른 자식(purchase-svc·hold-worker)과 이름이 비슷한 것은 5,000ms다', () => {
    expect(childStopWaitMs('payment-svc')).toBe(95_000);
    for (const name of ['purchase-svc', 'hold-worker', 'payment', 'payment-svc-relay', 'admission-ctrl']) expect(childStopWaitMs(name), name).toBe(5_000);
  });
});

describe('stopChildProcess', () => {
  test('PRF181_합본은 payment-svc 자식이 SIGTERM 뒤 94초 동안 살아 있어도 SIGKILL하지 않고 95초에 한다', async () => {
    const f = fakeChild();
    const done = stopChildProcess(f.child, childStopWaitMs('payment-svc'), timers());
    let result: string | undefined;
    void done.then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(94_999);
    expect(f.signals).toEqual(['SIGTERM']);
    expect(result).toBeUndefined();
    // 95,000ms 정각
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await expect(done).resolves.toBe('killed');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('PRF181_payment-svc 자식이 90초에 스스로 끝나면 SIGKILL하지 않고 exited이며 타이머가 남지 않는다', async () => {
    const f = fakeChild();
    const done = stopChildProcess(f.child, childStopWaitMs('payment-svc'), timers());
    await vi.advanceTimersByTimeAsync(90_000);
    f.exit(0);
    await expect(done).resolves.toBe('exited');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.signals).toEqual(['SIGTERM']);
  });

  test.each(['purchase-svc', 'hold-worker'])('PRF181_다른 자식(%s)은 5,000ms에 SIGKILL한다(4,999ms까지는 SIGTERM뿐)', async (name) => {
    const f = fakeChild();
    const done = stopChildProcess(f.child, childStopWaitMs(name), timers());
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await expect(done).resolves.toBe('killed');
  });

  test('PRF181_이미 끝난 자식은 kill을 부르지 않고 exited이며 타이머를 걸지 않는다', async () => {
    const f = fakeChild(0);
    await expect(stopChildProcess(f.child, 95_000, timers())).resolves.toBe('exited');
    expect(f.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('main.ts 조립(소스 글 검사)', () => {
  // 약한 시험이다: 실제로 SIGTERM을 보내 보지 않고 소스 글만 본다(main.ts는 불러오면 합본이 켜진다). 동작은 위 stopChildProcess 시험이 본다
  test('PRF181_합본 main.ts는 stopChildProcess에 childStopWaitMs(이름)을 넘긴다', () => {
    const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/setTimeout\(resolve,\s*5_?000\)/);
    expect(src).toMatch(/from '\.\/stop-child\.js'/);
    expect(src).toMatch(/stopChildProcess\(/);
    expect(src).toMatch(/childStopWaitMs\(c\.name\)/);
    // 닫는 시간 주석의 옛 종료 유예(60초)를 고친다
    expect(src).not.toMatch(/v1-bundle\.yaml 60초/);
  });
});
