// 탈퇴 계정의 사람 키 만료 당기기(docs/features/queue-admission.md §3 '탈퇴 계정의 사람 키', BUILD_ORDER BOT-037, I-T27).
// identity의 탈퇴 사건이 실은 pid(전환 기간이면 옛 pid도)마다, 진행 중인 회차의 q:dup·q:adm 만료를 purgeBy로 당긴다.
// 키를 바로 지우지 않으므로 기한까지는 같은 사람이 다시 가입해도 같은 회차에 또 순번을 받지 못한다(docs/features/identity.md §8).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { WITHDRAWN_KEYS, type WithdrawnKeys } from '../domain/ports.js';

/** Lua 한 번에 거는 회차 수 [가정]. 키는 회차마다 둘이다 */
export const PURGE_EVENTS_PER_CALL = 200;
/** pid는 키의 해시 태그에 들어간다. 진입 컨트롤러의 KEY_PART와 같은 모양만 받는다(다른 곳에서 불러도 태그를 깨지 않게) */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;

@Injectable()
export class PurgeWithdrawnKeys {
  constructor(
    @Inject(WITHDRAWN_KEYS) private readonly keys: WithdrawnKeys,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * @throws Error pid가 키 조각 모양이 아니거나 purgeBy가 수가 아님(키를 만들기 전에 막는다)
   * @throws QueueStoreUnavailable 대기열 Redis 일시 장애(처리기가 다시 하게 한다)
   */
  async run(i: { pids: readonly string[]; purgeBy: number }): Promise<{ events: number; keys: number }> {
    if (!i.pids.every((p) => KEY_PART.test(p))) throw new Error('pid가 키 조각 모양이 아니다');
    if (!Number.isFinite(i.purgeBy)) throw new Error('purgeBy가 수가 아니다');
    const events = await this.keys.activeEvents(this.clock.now());
    let n = 0;
    for (const pid of i.pids) {
      for (let k = 0; k < events.length; k += PURGE_EVENTS_PER_CALL) n += await this.keys.expireBy(pid, events.slice(k, k + PURGE_EVENTS_PER_CALL), i.purgeBy);
    }
    return { events: events.length, keys: n };
  }
}
