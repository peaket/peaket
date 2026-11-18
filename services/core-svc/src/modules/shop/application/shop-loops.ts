// shop 리더 반복 셋(ADR-0300 결정 6·7, ADR-0301 결정 5): 재고 예약 만료(1초 [가정]), 결과 당기기와 승인 명령 다시 보내기(1초 [가정]),
// 미수령 환급 다시 부르기(60초 [정함]마다 다음 시각이 된 환급을 본다. 같은 환급은 10분 [가정]마다). 플랫폼 LeaderLoop 모양(name·start·stop)이다.
// 틱마다 리더인지 보고 리더일 때만 일한다. 틱이 던지면 경고 한 줄을 남기고 다음 틱에 다시 한다(반복을 멈추지 않는다).
import type { LeaderLoop, LeaderState } from '@peaket/platform';
import type { ShopLogger } from './shop-signals.js';

export interface IntervalLoopOptions {
  name: string;
  everyMs: number;
  leader: LeaderState;
  tick: () => Promise<unknown>;
  logger: ShopLogger;
}

/** 간격 반복 하나. start는 기다리지 않고, stop은 돌던 틱을 마친 뒤 끝난다 */
export function intervalLoop(o: IntervalLoopOptions): LeaderLoop {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const run = async (): Promise<void> => {
    if (stopped) return;
    if (o.leader.isLeader()) {
      try {
        await o.tick();
      } catch (err) {
        o.logger.warn({ kind: 'shop-loop', loop: o.name, err: err instanceof Error ? err.name : 'unknown' }, 'shop 리더 반복 한 바퀴가 실패했다(다음 바퀴에 다시 한다)');
      }
    }
    if (!stopped) timer = setTimeout(() => (running = run()), o.everyMs);
  };
  return {
    name: o.name,
    start: () => {
      stopped = false;
      timer = setTimeout(() => (running = run()), o.everyMs);
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

/** 만료 작업·결과 당기기 간격 1초 [가정](ADR-0300 결정 6·7) */
export const MERCH_LOOP_INTERVAL_MS = 1_000;
/** 환급 다시 부르기 반복 간격 60초 [정함] */
export const MERCH_REFUND_LOOP_INTERVAL_MS = 60_000;
