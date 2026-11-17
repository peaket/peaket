// 합본 자식 프로세스 멈추기(W9-fix2 계획 §9 보충, PRF-181).
// SIGTERM을 보내고 대기 안에 안 끝나면 SIGKILL한다. payment-svc 자식은 승인 실행기가 돌던 결제사 호출과 결과 쓰기를 기다려야 하므로 더 길게 기다린다.
import type { ChildProcess } from 'node:child_process';

/** 일반 자식(purchase-svc·hold-worker 등)의 SIGTERM → SIGKILL 대기(ms) */
export const BUNDLE_CHILD_STOP_MS = 5_000;
/** payment-svc 자식 대기(ms) [가정]: 실행기 최악 87.5초 + 닫기 여유 7.5초(자식의 drain보다 길고 합본 파드 유예보다 짧게) */
export const BUNDLE_PAYMENT_CHILD_STOP_MS = 95_000;

/** 타이머(시험이 가짜 타이머를 넘긴다) */
export interface StopChildTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
}

const REAL_TIMERS: StopChildTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
};

/** 자식 이름별 SIGTERM → SIGKILL 대기(ms) */
export function childStopWaitMs(name: string): number {
  return name === 'payment-svc' ? BUNDLE_PAYMENT_CHILD_STOP_MS : BUNDLE_CHILD_STOP_MS;
}

/** 자식에 SIGTERM을 보내고 waitMs 안에 끝나지 않으면 SIGKILL한다. 끝나면 타이머를 지운다 */
export async function stopChildProcess(
  child: Pick<ChildProcess, 'exitCode' | 'kill' | 'once'>,
  waitMs: number,
  timers: StopChildTimers = REAL_TIMERS,
): Promise<'exited' | 'killed'> {
  if (child.exitCode !== null) return 'exited';
  let timer: unknown;
  const exited = new Promise<'exited'>((resolve) => child.once('exit', () => resolve('exited')));
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = timers.setTimeout(() => resolve('timeout'), waitMs);
  });
  child.kill('SIGTERM');
  const result = await Promise.race([exited, timedOut]);
  timers.clearTimeout(timer);
  if (result === 'exited') return 'exited';
  child.kill('SIGKILL');
  return 'killed';
}
