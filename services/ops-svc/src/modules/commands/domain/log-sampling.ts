// 온세일 구간 정상 로그 줄 표본 신호 LOG_SAMPLING의 생산(F-02-5 OPS-300, C-T75 ①④, ADR-0334 결정 1·3).
// 대형·중형 회차의 오픈 −10분부터 +60분까지 정상 로그를 100줄에 1줄만 남긴다. 여러 윈도우가 겹치면
// 가장 늦은 끝을 쓰고, 끝이 바뀔 때만 새 사건을 낸다. 같은 끝이면 같은 commandId·eventKey라 복제가 겹쳐도 한 번 적용된다.
import type { SettingChange } from './ports.js';
import { SYSTEM_ACTOR_REF } from './command.js';
import { deterministicUuidOf } from './setting-commands.js';

export const LOG_SAMPLING_ONE_IN = 100;
/** 온세일 윈도우 앞(오픈 −10분, POL-028) */
export const LOG_SAMPLING_BEFORE_MS = 10 * 60_000;
/** 온세일 윈도우 뒤(오픈 +60분) */
export const LOG_SAMPLING_AFTER_MS = 60 * 60_000;
/** 일정을 읽는 앞 구간(앞으로 2시간, 재시작한 복제도 지난 오픈을 본다) */
export const LOG_SAMPLING_LOOKAHEAD_MS = 120 * 60_000;

export type ShowScale = 'LARGE' | 'MEDIUM' | 'SMALL';

/** core-svc가 주는 오픈 하나. 규모가 없으면 소형으로 본다 */
export interface OnsaleOpen {
  readonly eventId: string;
  readonly opensAtMs: number;
  readonly scale: ShowScale | null;
}

/** 오픈 일정 읽기 포트(주소·토큰은 어댑터가 맡는다) */
export interface OnsaleScheduleSource {
  opensBetween(fromMs: number, untilMs: number): Promise<readonly OnsaleOpen[]>;
}

/** 설정 사건 쓰기 포트(MemoryCommandStore·Drizzle 저장소가 구현) */
export interface SettingsPublisher {
  setting(s: SettingChange): Promise<string>;
}

const APPLIES = (o: OnsaleOpen): boolean => o.scale === 'LARGE' || o.scale === 'MEDIUM';

/** now가 든 윈도우들의 가장 늦은 끝. 든 윈도우가 없으면 undefined */
export function logSamplingEndOf(opens: readonly OnsaleOpen[], nowMs: number): number | undefined {
  let end: number | undefined;
  for (const o of opens) {
    if (!APPLIES(o)) continue;
    const from = o.opensAtMs - LOG_SAMPLING_BEFORE_MS;
    const until = o.opensAtMs + LOG_SAMPLING_AFTER_MS;
    if (nowMs < from || nowMs >= until) continue;
    if (end === undefined || until > end) end = until;
  }
  return end;
}

/** 같은 끝이면 같은 commandId를 갖는 설정 사건(계약 LogSamplingValue) */
export function logSamplingSettingOf(endMs: number, nowMs: number): SettingChange {
  return {
    kind: 'LOG_SAMPLING',
    scope: 'PLATFORM',
    target: '*',
    value: { oneIn: LOG_SAMPLING_ONE_IN },
    expiresAtMs: endMs,
    occurredAtMs: nowMs,
    actorRef: SYSTEM_ACTOR_REF,
    commandId: deterministicUuidOf(`PEAKET-onsale-log-sampling-v1:${endMs}`),
  };
}

export type LogSamplingRound =
  | { readonly status: 'PUBLISHED'; readonly expiresAtMs: number }
  | { readonly status: 'UNCHANGED'; readonly expiresAtMs: number }
  | { readonly status: 'OUTSIDE' }
  | { readonly status: 'SCHEDULE_UNAVAILABLE' };

/** 정비 바퀴가 부르는 한 바퀴. 같은 끝이면 다시 내지 않고, 일정을 읽지 못하면 아무것도 바꾸지 않는다 */
export class PublishOnsaleLogSampling {
  #lastEndMs: number | undefined;
  constructor(
    private readonly deps: {
      readonly schedule: OnsaleScheduleSource;
      readonly publisher: SettingsPublisher;
      readonly clock: { now(): number };
    },
  ) {}

  async runOnce(): Promise<LogSamplingRound> {
    const now = this.deps.clock.now();
    let opens: readonly OnsaleOpen[];
    try {
      opens = await this.deps.schedule.opensBetween(now - LOG_SAMPLING_AFTER_MS, now + LOG_SAMPLING_LOOKAHEAD_MS);
    } catch {
      return { status: 'SCHEDULE_UNAVAILABLE' };
    }
    const end = logSamplingEndOf(opens, now);
    if (end === undefined) {
      this.#lastEndMs = undefined;
      return { status: 'OUTSIDE' };
    }
    if (this.#lastEndMs === end) return { status: 'UNCHANGED', expiresAtMs: end };
    await this.deps.publisher.setting(logSamplingSettingOf(end, now));
    this.#lastEndMs = end;
    return { status: 'PUBLISHED', expiresAtMs: end };
  }
}
