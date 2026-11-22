// admission-ctrl 리더의 제어 받기(F-02-1 OPS-300, ADR-0365 결정 5, ADR-0056, Q-T30). 제어 gRPC(ApplyControl)가 부른다.
// - 리더만 쓴다. 리더가 아닌 파드는 NOT_LEADER이고 아무것도 쓰지 않는다(받는 층이 UNAVAILABLE not-leader).
// - 리더는 쓰기 직전에 자기 리더 세대를 다시 보고, 리더 키와 세대를 견주는 Lua 하나로 쓴다. 세대가 낮으면 FENCED: 이 세대의 쓰기를 멈추고(대기 파드로
//   돌아간다, 루프의 FENCED와 같다) 받는 층이 UNAVAILABLE fenced로 답한다. 이미 FENCED를 본 세대도 같다.
// - 같은 Lua가 판이 그 종류의 판 칸보다 클 때만 쓰고 지금 판을 돌려준다(같거나 작은 판은 아무것도 바꾸지 않는다).
// - 리뷰 반영 RV-02: 회차 범위 쓰기는 먼저 회차와 무관한 세대 키(q:{admission}:leader)와 견준다(올리지 않는다). 새 리더는 서자마자 그 키를 올리므로(리더 루프),
//   옛 세대의 쓰기는 전체 범위·오픈 전 회차 범위 모두 FENCED다(Q-T30 '옛 리더의 쓰기는 모두 FENCED').
import { keepUntilOf } from '../domain/plan.js';
import { leaderControlOf, type LeaderControlKind } from '../domain/control.js';
import type { Elector, LeaderStore } from '../domain/ports.js';

export interface ApplyLeaderControlInput {
  readonly kind: LeaderControlKind;
  /** 소문자 회차 ID 또는 PLATFORM */
  readonly scope: string;
  readonly desiredStateJson: string;
  readonly commandId: string;
  /** 1 이상 안전 정수(받는 층이 먼저 본다) */
  readonly version: number;
}

export type ApplyLeaderControlResult = { readonly status: 'APPLIED'; readonly appliedVersion: number; readonly changed: boolean } | { readonly status: 'NOT_LEADER' } | { readonly status: 'FENCED' };

/** 리더 루프의 펜싱 표시(AdmissionLeader가 채운다) */
export interface LeaderFence {
  isFenced(gen: number): boolean;
  markFenced(gen: number, scope: string): void;
}

export class ApplyLeaderControl {
  constructor(
    private readonly store: Pick<LeaderStore, 'applyControl' | 'schedule' | 'checkPlatform'>,
    private readonly elector: Elector,
    private readonly fence: LeaderFence,
  ) {}

  /**
   * @throws LeaderControlRejected 범위·바라는 상태가 꼴에 맞지 않음(아무것도 쓰지 않았다)
   * @throws Error 저장소가 제어를 받지 않거나 Redis 장애
   */
  async run(input: ApplyLeaderControlInput): Promise<ApplyLeaderControlResult> {
    // 꼴 검사가 먼저다: 리더가 아니어도 틀린 값은 INVALID_ARGUMENT로 답한다(쓰기 0)
    const write = leaderControlOf(input.kind, input.scope, input.desiredStateJson);
    if (!this.store.applyControl) throw new Error('이 저장소는 제어 쓰기를 받지 않는다');
    if (this.elector.generation() === undefined) return { status: 'NOT_LEADER' };
    const plan = write.eventId !== undefined ? await this.store.schedule(write.eventId) : null;
    // 쓰기 직전에 세대를 다시 본다(일정 읽기 동안 리더를 잃었을 수 있다)
    const gen = this.elector.generation();
    if (gen === undefined) return { status: 'NOT_LEADER' };
    if (this.fence.isFenced(gen)) return { status: 'FENCED' };
    // 회차 범위는 회차와 무관한 세대 키를 먼저 견준다(RV-02, 견주기만): 새 리더가 그 키를 올렸으면, 아직 아무도 올리지 않은 회차 키(오픈 전)에도 옛 세대는 쓰지 못한다
    if (write.eventId !== undefined && this.store.checkPlatform && (await this.store.checkPlatform(gen)) === 'FENCED') {
      this.fence.markFenced(gen, input.scope);
      return { status: 'FENCED' };
    }
    const r = await this.store.applyControl({ ...write, gen, version: input.version, commandId: input.commandId, ...(plan ? { keepUntilMs: keepUntilOf(plan) } : {}) });
    if (r.kind === 'FENCED') {
      this.fence.markFenced(gen, input.scope);
      return { status: 'FENCED' };
    }
    return { status: 'APPLIED', appliedVersion: r.appliedVersion, changed: r.changed };
  }
}
