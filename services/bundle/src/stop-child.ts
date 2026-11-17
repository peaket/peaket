// 합본 자식 프로세스 멈추기(W9-fix2 계획 §9 보충, PRF-181). 시험 담당이 더한 빈 뼈대: 상수와 동작은 구현 담당이 넣는다.
import type { ChildProcess } from 'node:child_process';

/** 타이머(시험이 가짜 타이머를 넘긴다) */
export interface StopChildTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
}

/** 자식 이름별 SIGTERM → SIGKILL 대기(ms). 빈 뼈대 */
export function childStopWaitMs(_name: string): number {
  throw new Error('childStopWaitMs: 아직 구현하지 않았다');
}

/** 자식에 SIGTERM을 보내고 waitMs 안에 끝나지 않으면 SIGKILL한다. 빈 뼈대 */
export async function stopChildProcess(_child: Pick<ChildProcess, 'exitCode' | 'kill' | 'once'>, _waitMs: number, _timers?: StopChildTimers): Promise<'exited' | 'killed'> {
  throw new Error('stopChildProcess: 아직 구현하지 않았다');
}
