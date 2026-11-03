// 리더 컨텍스트의 포트: 대기열 Redis의 리더 쓰기(펜싱 Lua)와 Lease 세대(docs/features/queue-admission.md §5, ADR-0056·0182).

/** 회차 일정 사본(q:{event:E}:cfg)에서 리더가 쓰는 값 */
export interface EventPlan {
  opensAtMs: number;
  startsAtMs: number;
  lobbyShuffle: boolean;
  openBatch: boolean;
  /** 오픈 직후 묶음 구간 길이(없으면 2초 [가정]) */
  batchWindowMs?: number;
}

/** 리더 상태 q:{event:E}:ctl에서 이 단계가 읽는 값: 운영자 목표(수동 고정 만료 전), 입장 일시정지·판매 일시정지·판매 중지 가운데 하나라도 참인가 */
export interface Control {
  target?: number;
  paused: boolean;
}

export interface TickInput {
  eventId: string;
  /** 리더 세대 */
  gen: number;
  /** 동시 입장 목표 */
  target: number;
  /** max(입장 비율, 0.2) */
  p: number;
  /** 오는 중 창 W(ms) */
  windowMs: number;
  /** 이번 주기의 최대 전진 번호 수(초당 상한 × 0.2초, 일시정지면 0) */
  maxAdvance: number;
  /** 회차 키 수명(판매 종료 + 1일) */
  keepUntilMs: number;
  /** 판매 종료(전진 기록 calls의 수명, docs/data.md) */
  saleEndMs: number;
  lobbyShuffle: boolean;
  openBatch: boolean;
  /** 묶음 구간 끝(묶음을 끈 회차는 쓰지 않는다) */
  closeAtMs: number;
}

export type TickResult =
  | { kind: 'FENCED' }
  | {
      kind: 'OK';
      serving: number;
      /** 이번에 지난 유효 번호 수 */
      advanced: number;
      slots: number;
      soon: number;
      inFlight: number;
      /** 낡아서 뺀 곧 입장 항목 수 */
      dropped: number;
      lobbyMarked: 0 | 1;
      batchMarked: 0 | 1;
      batchPublished: 0 | 1;
      repair: 0 | 1;
    };

export interface CloseInput {
  eventId: string;
  gen: number;
  keepUntilMs: number;
  opensAtMs: number;
  closeAtMs: number;
  lobbyShuffle: boolean;
  openBatch: boolean;
}
export type CloseResult = 'OK' | 'NONE' | 'FENCED' | 'RB05' | 'EARLY';

/** queue-svc의 RB-05와 같은 입력(ADR-0181) */
export interface Rb05Input {
  eventId: string;
  expireAtMs: number;
  skippedExpireAtMs: number;
  skipBase: number;
  opensAtMs: number;
  closeAtMs?: number;
  lobbyShuffle: boolean;
  openBatch: boolean;
}
export type Rb05Result = { kind: 'SKIPPED'; start: number; end: number; gen: number } | { kind: 'DONE' };

export const LEADER_STORE = Symbol('admission.LeaderStore');
export interface LeaderStore {
  /** 진행 중인 회차 목록 q:{admission}:events(점수 = 판매 종료 + 1일). 점수가 지난 회차는 지운다 */
  activeEvents(nowMs: number): Promise<string[]>;
  schedule(eventId: string): Promise<EventPlan | null>;
  control(eventId: string, nowMs: number): Promise<Control>;
  /** 명세 acquire의 BUMP */
  bump(eventId: string, gen: number, keepUntilMs: number): Promise<'OK' | 'FENCED'>;
  /** 명세 plan·applyWrite의 ADVANCE(정리·빈자리·전진·기록을 Lua 하나로) */
  tick(i: TickInput): Promise<TickResult>;
  /** 명세 plan·applyWrite의 CLOSE(로비·묶음 표시) */
  close(i: CloseInput): Promise<CloseResult>;
  rb05(i: Rb05Input): Promise<Rb05Result>;
}

/** Lease 리더(플랫폼 LeaseElector). 리더가 아니면 세대가 없다 */
export const ELECTOR = Symbol('admission.Elector');
export interface Elector {
  generation(): number | undefined;
}

/** 묶음 게시(PublishBatchResults.run). 리더가 주기마다 부른다 */
export interface Publisher {
  run(i: { eventId: string }): Promise<{ status: string }>;
}
export const PUBLISHER = Symbol('admission.Publisher');
