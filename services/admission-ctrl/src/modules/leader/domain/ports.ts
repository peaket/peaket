// 리더 컨텍스트의 포트: 대기열 Redis의 리더 쓰기(펜싱 Lua)와 Lease 세대(docs/features/queue-admission.md §5, ADR-0056·0182).

/** 회차 일정 사본(q:{event:E}:cfg)에서 리더가 쓰는 값 */
export interface EventPlan {
  opensAtMs: number;
  startsAtMs: number;
  lobbyShuffle: boolean;
  openBatch: boolean;
  /** 오픈 직후 묶음 구간 길이(없으면 2초 [가정]) */
  batchWindowMs?: number;
  /** 결제사 묶음 이름과 승인 상한(초당 건수). 둘 다 있을 때만 쓴다(ADR-0226 결정 9) */
  pgKey?: string;
  pgTps?: number;
  /** 묶음 구간의 공시 라운드(q:{event:E}:shuffle의 round:1). 있으면 결과 공개 예정 시각을 정하고, 없으면 구간 끝 + 11초 [가정](ADR-0231 결정 8) */
  batchRound?: number;
  /** 로비 구간의 공시 라운드(round:lobby). 있으면 로비 결과 공개 예정 시각을 정한다(없으면 늦었다고 보지 않는다, ADR-0232 결정 11) */
  lobbyRound?: number;
}

/** 리더 상태 q:{event:E}:ctl에서 읽는 값: 운영자 목표(고정 중일 때만 `target`), 일시정지 묶음, 운영자 칸과 자동 제어 기억(ADR-0226) */
export interface Control {
  target?: number;
  paused: boolean;
  /** 운영자 칸(값·고정 만료·복귀 확인). 없으면 없는 것으로 본다 */
  operator?: import('./aimd.js').OperatorState;
  /** 명령 6(대체 결제사 전환)이 쓴 결제사(둘 다 있을 때만 쓴다) */
  pgKey?: string;
  pgTps?: number;
  /** 자동 제어 칸의 원문(aimd.ts memoryFromFields가 읽는다) */
  memory?: Record<string, string | null>;
}

export interface TickInput {
  eventId: string;
  /** 리더 세대 */
  gen: number;
  /** 동시 입장 목표 */
  target: number;
  /** 입장 비율 하한(0.2). 비율은 Lua가 전진 기록으로 센다(PRF-100) */
  ratioFloor: number;
  /** 판매 상태 칸이 없을 때 쓸 값: 리더가 그 회차에서 마지막으로 본 상태(처음은 ON_SALE, ADR-0122) */
  saleStateFallback: string;
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
  /** ctl에 함께 쓸 자동 제어 칸(바뀐 칸만, 세대 확인 안에서 쓴다, ADR-0226 결정 2) */
  fields?: Record<string, string>;
  /** 묶음 결과 공개 예정 = 구간 끝 + 이 값(ms). 공시 라운드에서 정한다(없으면 11초 [가정], ADR-0231 결정 8) */
  batchResultDelayMs?: number;
  /** 로비 결과 공개 예정 시각(ms, 공시 라운드 예정 + 5초 [가정]). 없으면 로비 게시를 늦었다고 보지 않는다(ADR-0232 결정 11) */
  lobbyResultAtMs?: number;
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
      /** 발급된 번호 − serving(줄 선 사람의 어림, 수요 판단에 쓴다) */
      waiting: number;
      /** 낡아서 뺀 곧 입장 항목 수 */
      dropped: number;
      lobbyMarked: 0 | 1;
      batchMarked: 0 | 1;
      batchPublished: 0 | 1;
      repair: 0 | 1;
      /** 로비 결과를 게시했는가(pub:lobby)와 다시 쓰기 표시(repair:lobby) */
      lobbyPublished?: 0 | 1;
      lobbyRepair?: 0 | 1;
      /** 첫 전진 문이 닫혀 이번 주기에 부를 번호가 없다(발급한 번호는 있는데 serving이 문까지 왔다, ADR-0231 결정 14) */
      gated?: 0 | 1;
      /** 이번 주기의 입장 비율(0~1, 표본이 없으면 1) */
      ratio: number;
      /** 이번 주기에 쓴 판매 상태 */
      saleState: string;
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
/** queue-svc와 같다: SKIPPED(이번에 건너뜀, 확인 전), PENDING(이미 건너뛰었고 복제 확인 전), DONE(ADR-0186) */
export type Rb05Result = { kind: 'SKIPPED'; start: number; end: number; gen: number } | { kind: 'PENDING' } | { kind: 'DONE' };
/** RB-05 복제 확인(queue-svc와 같다) */
export type Rb05Confirm = 'CONFIRMED' | 'WAITING' | 'NONE';

export const LEADER_STORE = Symbol('admission.LeaderStore');
export interface LeaderStore {
  /** 진행 중인 회차 목록 q:{admission}:events(점수 = 판매 종료 + 1일). 점수가 지난 회차는 지운다 */
  activeEvents(nowMs: number): Promise<string[]>;
  schedule(eventId: string): Promise<EventPlan | null>;
  control(eventId: string, nowMs: number): Promise<Control>;
  /** q:{admission}:ctl의 명령 11(자동화 정지) */
  platformControl(): Promise<{ autoStopped: boolean }>;
  /** 명세 acquire의 BUMP */
  bump(eventId: string, gen: number, keepUntilMs: number): Promise<'OK' | 'FENCED'>;
  /** 명세 plan·applyWrite의 ADVANCE(정리·빈자리·전진·기록을 Lua 하나로) */
  tick(i: TickInput): Promise<TickResult>;
  /** 명세 plan·applyWrite의 CLOSE(로비·묶음 표시) */
  close(i: CloseInput): Promise<CloseResult>;
  /** 진입 Degraded의 도착 시각 칸 닫기: 칸 끝 + 20초 [가정]이 지난 칸을 닫고 쓰지 않은 번호를 빠진 번호로 돌린다(ADR-0223 결정 7) */
  closeArrivalSlots(i: ArrivalCloseInput): Promise<ArrivalCloseResult>;
  rb05(i: Rb05Input): Promise<Rb05Result>;
  /** RB-05 복제 확인(ADR-0186): 표시 → 붙은 온라인 복제본 수만큼 WAIT → 지우기. queue-svc 진입 저장소와 같은 순서다 */
  confirmRb05(i: { eventId: string }): Promise<Rb05Confirm>;
}

export interface ArrivalCloseInput {
  eventId: string;
  gen: number;
  /** 회차 키의 수명(빠진 번호 비트맵·리더 키) */
  keepUntilMs: number;
}
/** slots: 이번에 닫은 칸 수, returned: 빠진 번호로 돌린 번호 수. RB05: 장애 전환 뒤 RB-05 전이거나 복제 확인 전이라 쓰지 않았다(다음 주기에 다시) */
export interface ArrivalCloseResult {
  kind: 'OK' | 'NONE' | 'FENCED' | 'RB05';
  slots: number;
  returned: number;
}

/** Lease 리더(플랫폼 LeaseElector). 리더가 아니면 세대가 없다 */
/** 자동 제어의 판단 입력(ADR-0226 결정 4). 한 번 읽은 결과에서 회차별 입력을 꺼낸다 */
export const CONTROL_INPUTS = Symbol('admission.ControlInputsReader');
export interface ControlInputsReader {
  read(): Promise<ControlSnapshot>;
}
export interface ControlSnapshot {
  forEvent(eventId: string): import('./aimd.js').EventInputs;
}

export const ELECTOR = Symbol('admission.Elector');
export interface Elector {
  generation(): number | undefined;
}

/** 게시(PublishBatchResults.run). 리더가 구간(묶음·로비)마다 부른다 */
export interface Publisher {
  run(i: { eventId: string; group?: 'lobby' | number }): Promise<{ status: string; reason?: string; first?: boolean }>;
  /** 리더를 잃으면 들고 있던 큰 목록을 비운다 */
  forget?(): void;
}
export const PUBLISHER = Symbol('admission.Publisher');

/** 시드 공개(RevealShuffleSeeds.run, 오픈 60분 뒤, ADR-0232 결정 7) */
export interface SeedRevealer {
  run(i: { eventId: string; group: 'lobby' | number; opensAtMs: number; expireAtMs: number }): Promise<{ status: string }>;
}
export const SEED_REVEALER = Symbol('admission.SeedRevealer');
