// 진입 컨텍스트의 포트: 토큰 코덱, 회차 일정 사본, 위험 판정, 진입 저장소(대기열 Redis).
import type { SeedSealer, ShuffleGroup } from '@peaket/shuffle';
import type { EventSchedule, HeldRecord, LobbyClaims, PreverifyClaims, ReasonCategory, TicketClaims } from './queue.js';

export const QUEUE_TOKENS = Symbol('queue.QueueTokens');
/** 사전 검증 토큰·대기표·참가 토큰의 HMAC 코덱. 읽기는 MAC·형식이 맞을 때만 클레임을 주고 아니면 null(만료는 부르는 쪽이 본다) */
export interface QueueTokens {
  preverify(c: PreverifyClaims): string;
  readPreverify(token: string): PreverifyClaims | null;
  ticket(c: TicketClaims): string;
  readTicket(token: string): TicketClaims | null;
  lobby(c: LobbyClaims): string;
  readLobby(token: string): LobbyClaims | null;
  /** 대기표 해시(q:adm 값, q:{event:E}:verify 필드): SHA-256 16진 */
  hash(token: string): string;
}

/** 도착 시각 쿠키에서 읽은 칸(ADR-0223 결정 3): 회차, 도착 시각, CloudFront 요청 ID, sid */
export interface ArrivalClaims {
  kid: string;
  e: string;
  /** 엣지가 찍은 도착 시각(밀리초) */
  t: number;
  rid: string;
  sid: string;
}
export const ARRIVAL_COOKIES = Symbol('queue.ArrivalCookies');
/** 도착 시각 쿠키 읽기. MAC·형식이 맞을 때만 칸을 주고 아니면 null(회차·시각·sid는 부르는 쪽이 본다) */
export interface ArrivalCookies {
  read(value: string): ArrivalClaims | null;
}

export const ARRIVAL_SIGNALS = Symbol('queue.ArrivalSignals');
/** 도착 시각 쿠키와 칸 번호의 결과를 센다(Q-T16의 장부, docs/observability.md §5) */
export interface ArrivalSignals {
  /** absent: 엣지가 Degraded인데 서명 없이 보냈다(키를 읽지 못함 등). unavailable: 요청 ID를 잡지 못해 503으로 다시 오게 했다 */
  cookie(result: 'ok' | 'invalid' | 'reused' | 'absent' | 'unavailable'): void;
  number(path: 'slot' | 'late' | 'overflow'): void;
}

export const WITHDRAWN_KEYS = Symbol('queue.WithdrawnKeys');
/** 탈퇴 계정의 사람 키(q:dup·q:adm) 만료 당기기(docs/features/queue-admission.md §3 '탈퇴 계정의 사람 키', BOT-037) */
export interface WithdrawnKeys {
  /** 진행 중인 회차(q:{admission}:events에서 점수가 now보다 큰 회차) ID. 키 조각 모양이 아닌 값은 거른다 */
  activeEvents(now: number): Promise<string[]>;
  /** 한 pid의 그 회차들 q:dup·q:adm에 만료 at(밀리초)을 건다(이미 더 이르면 그대로). 만료를 건 키 수 */
  expireBy(pid: string, eventIds: readonly string[], at: number): Promise<number>;
}

/** 처리를 마치지 못해 다시 나올 때마다 두 배로 느는 빌림의 상한 [가정] */
export const DUE_LEASE_MAX_MS = 3_600_000;

/** 처리할 때를 기다리는 탈퇴 사건(값에 pid가 있다, ADR-0214 결정 7) */
export interface DueWithdrawal {
  eventKey: string;
  pids: string[];
  purgeBy: number;
  dueAt: number;
}

/**
 * 탈퇴 사건의 '처리할 때' 집합(docs/data.md §3 q:{wdr}, ADR-0214 결정 7). 때가 안 된 사건을 Kafka 처리 줄에 두지 않고 여기 넣는다.
 * 값(pid·purgeBy)은 purgeBy까지만 둔다. 꺼내기는 빌리기(그동안 다른 파드가 집지 않는다)라, 처리를 마치지 못하면 빌림이 끝난 뒤 다시 나온다.
 * 대기열 Redis가 잠시 안 되면 QueueStoreUnavailable
 */
export interface WithdrawnDue {
  /** 같은 eventKey는 한 번만 넣는다(다시 받은 사건) */
  schedule(i: DueWithdrawal): Promise<void>;
  /**
   * 때가 됐고 빌린 사람이 없는 것을 limit개까지 빌려 꺼낸다. 빌린 항목은 훑는 범위에서 빠지고(뒤 항목이 굶지 않게), 빌림은 꺼낼 때마다 두 배로 는다(DUE_LEASE_MAX_MS까지).
   * 값이 수명(purgeBy)으로 사라진 항목만 지우고 expired로 센다. 값이 있으면 purgeBy가 지났어도 꺼낸다(지금 처리한다)
   */
  claim(i: { leaseMs: number; limit: number }): Promise<{ items: DueWithdrawal[]; expired: number }>;
  /** 처리를 마쳤다(항목과 값을 지운다) */
  done(eventKey: string): Promise<void>;
  /** 가장 이른 처리할 때(없으면 null). 때가 지난 지 오래된 항목은 경보다 */
  oldestDue(): Promise<number | null>;
}

export const EVENT_SCHEDULES = Symbol('queue.EventSchedules');
export interface EventSchedules {
  /** 사본이 없으면 null(그 회차의 대기열이 열리지 않음) */
  get(eventId: string): Promise<EventSchedule | null>;
}

/** 구간(로비·묶음 1)의 공시 기록(q:{event:E}:shuffle, ADR-0231 결정 6). 한 번 쓰면 바뀌지 않는다 */
export interface CommitRecord {
  commit: string;
  round: number;
  sealed: string;
  atMs: number;
}
export const SHUFFLE_COMMIT_STORE = Symbol('queue.ShuffleCommitStore');
export interface ShuffleCommitStore {
  read(eventId: string, group: ShuffleGroup): Promise<CommitRecord | null>;
  /** 칸이 비어 있을 때만 쓰고(Lua 한 번, 공시 시각은 저장소 시각), 있으면 그대로 둔 값을 돌려준다. 수명은 회차 키와 같게 늦은 쪽으로만 늘린다 */
  write(eventId: string, group: ShuffleGroup, rec: Omit<CommitRecord, 'atMs'>, expireAtMs: number): Promise<CommitRecord>;
}
export const SEED_SEALER = Symbol('queue.SeedSealer');
export type { SeedSealer, ShuffleGroup };
/** 지금 환경에 봉인이 없음(운영 KMS 어댑터 전, BUILD_ORDER HOT-041) */
export const noSealer: SeedSealer = {
  seal: () => Promise.reject(new Error('시드 봉인이 없다(운영 KMS 어댑터는 BUILD_ORDER HOT-041)')),
  open: () => Promise.reject(new Error('시드 봉인이 없다(운영 KMS 어댑터는 BUILD_ORDER HOT-041)')),
};

/** 커밋 공시 감사 기록(POL-005, ADR-0232 결정 10). 불변 감사 저장소에 잇는 일은 그 저장소 단계의 몫이다 */
export interface ShuffleDisclosure {
  eventId: string;
  group: ShuffleGroup;
  commit: string;
  chain: string;
  round: number;
  algorithm: string;
  atMs: number;
}
export const SHUFFLE_DISCLOSURES = Symbol('queue.ShuffleDisclosures');
export interface ShuffleDisclosures {
  committed(d: ShuffleDisclosure): void;
}

export const LOBBY_SIGNALS = Symbol('queue.LobbySignals');
/** 로비 참가 지표(docs/observability.md §5) */
export interface LobbySignals {
  /** 그 기기의 입장 버튼이 열리는 시각보다 먼저 온 참가 */
  joinedBeforeUnlock(eventId: string): void;
  /** 공시 때가 지나서 그 자리에서 만든 커밋 */
  commitLate(): void;
}
export const noLobbySignals: LobbySignals = { joinedBeforeUnlock: () => undefined, commitLate: () => undefined };

export const LEAVE_SIGNALS = Symbol('queue.LeaveSignals');
/** 대기 취소 지표의 경로 라벨(URL 템플릿, docs/observability.md §8) */
export type LeaveRoute = '/v1/queues/{eventId}/lobby-participants/me' | '/v1/queues/{eventId}/entries/me';
/** 대기 취소 지표(docs/observability.md §5, ADR-0233). 기록을 실제로 취소한 요청만 센다 */
export interface LeaveSignals {
  left(route: LeaveRoute): void;
}
export const noLeaveSignals: LeaveSignals = { left: () => undefined };

export interface RiskInput {
  context: 'PREVERIFY' | 'LOBBY';
  eventId: string;
  accountId: string;
  pid: string;
  deviceId: string;
  journeyId: string;
  lobbyShuffle: boolean;
  humanCheckToken?: string;
  behaviorSummary?: Record<string, unknown>;
}
export type RiskVerdict = { kind: 'OK' } | { kind: 'VERIFY'; reason: ReasonCategory } | { kind: 'UNAVAILABLE' };

export const RISK = Symbol('queue.RiskPort');
/** trust-svc ScoreRisk(데드라인 800ms [가정]). 실패하면 던지거나 UNAVAILABLE을 준다(축소 운영) */
export interface RiskPort {
  score(i: RiskInput): Promise<RiskVerdict>;
}

/** 사람 슬롯에 기록한 진입. 같은 요청 ID의 재시도가 처음 대기표를 그대로 받게 여정 ID와 추가 검증 사유도 함께 둔다 */
export interface RecordedEntry {
  seq: number;
  gen: number;
  jny: string;
  vr?: ReasonCategory;
}
/** 사람 슬롯의 묶음 기록(OPEN[14]): 묶음에 넣은 사전 검증 토큰 해시와 처음 진입의 jny·vr */
export interface BatchedEntry {
  tokenHash: string;
  jny: string;
  vr?: ReasonCategory;
}
export type PreemptResult =
  | { kind: 'PROCEED' }
  | ({ kind: 'RECORDED' } & RecordedEntry)
  | ({ kind: 'BATCH' } & BatchedEntry)
  | { kind: 'ADMITTED' }
  | { kind: 'BUSY' }
  /** 이 요청 ID의 참가는 취소됐다(ADR-0233): 재전송에 새 번호를 주지 않는다 */
  | { kind: 'LEFT' };
export type RecordResult = { kind: 'RECORDED' } | ({ kind: 'SAME' } & RecordedEntry) | { kind: 'BATCH'; tokenHash: string } | { kind: 'ADMITTED' } | { kind: 'TAKEN' };
/** 묶음 결과: 번호, 게시 전, 참가자인데 결과 키가 없음(다시 쓰기를 청했다), 참가자 목록에 없음(batchMissing) */
export type BatchOutcome = { kind: 'RESULT'; seq: number; gen: number } | { kind: 'PENDING' } | { kind: 'REPAIRING' } | { kind: 'MISSING' };
/** ② 회차 슬롯의 결과: 번호, 묶음에 넣음(202), 묶음 구간이라 기다림(503), 서버 시각으로 아직 오픈 전 */
export type NumberResult =
  /** arrival: 쿠키가 있는 요청의 번호 길. slot = 칸 안의 번호, late = 칸이 닫혔거나 없어 카운터 끝, overflow = 구간이 차서 카운터 끝(ADR-0223 결정 6) */
  | { kind: 'NUMBERED'; seq: number; gen: number; arrival?: 'slot' | 'late' | 'overflow' }
  | { kind: 'BATCHING' }
  | { kind: 'WAIT'; retryAfterSeconds: number }
  | { kind: 'EARLY' }
  /** 세대 키의 주 노드 ID가 지금 노드 ID와 다르다: 장애 전환 뒤 RB-05 전이라 번호를 내지 않았다(ADR-0181) */
  | { kind: 'RECOVERING' }
  /** notice의 회차 판매 상태가 매진·판매 종료라 번호를 내지 않았다(HOT-010, ADR-0214) */
  | { kind: 'SOLD_OUT' }
  | { kind: 'ENDED' };

/** RB-05(ADR-0181): 세대 키가 지금 노드 ID와 다를 때만 건너뛰고 skipped에 한 줄을 더한 뒤 세대 키를 바꾼다 */
export interface Rb05Input {
  eventId: string;
  /** 회차 키의 만료 시각(판매 종료 + 1일) */
  expireAtMs: number;
  /** 건너뛴 구간 목록의 만료 시각(q:dup과 같은 판매 종료) */
  skippedExpireAtMs: number;
  /** 건너뛰는 양의 바탕 값. 로비·묶음 표시가 없으면 그 인원을 더한다 */
  skipBase: number;
  opensAtMs: number;
  closeAtMs?: number;
  lobbyShuffle: boolean;
  openBatch: boolean;
}
/** SKIPPED: 이번에 건너뜀(확인 전), PENDING: 이미 건너뛰었고 복제 확인 전, DONE: 할 것 없음(ADR-0186) */
export type Rb05Result = { kind: 'SKIPPED'; start: number; end: number; gen: number } | { kind: 'PENDING' } | { kind: 'DONE' };
/** RB-05 복제 확인: CONFIRMED(붙은 복제본이 다 받아 표시를 지움), WAITING(받지 못함, 다음에 다시), NONE(확인할 것이 없음) */
export type Rb05Confirm = 'CONFIRMED' | 'WAITING' | 'NONE';

export interface NumberInput {
  eventId: string;
  /** 회차 키의 만료 시각(판매 종료 + 1일) */
  expireAtMs: number;
  opensAtMs?: number;
  /** 묶음 구간 끝(오픈 + N). 묶음을 끈 회차는 쓰지 않는다 */
  closeAtMs?: number;
  lobbyShuffle?: boolean;
  openBatch?: boolean;
  /** 사전 검증 토큰의 최초 발급 시각이 오픈 전인가(묶음 대상, ADR-0041) */
  eligible?: boolean;
  /** 묶음 참가자로 넣을 사전 검증 토큰 해시 */
  tokenHash?: string;
  /** 묶음 참가자 목록의 만료 시각(판매 종료). 없으면 expireAtMs */
  batchExpireAtMs?: number;
  /** 진입 Degraded의 도착 시각 칸(쿠키를 받은 요청만, ADR-0223 결정 6) */
  arrivalSlot?: number;
  /** 도착 시각 칸의 첫 크기 */
  arrivalInitial?: number;
}

/** ② 파드별 묶음의 요청 하나(ADR-0179) */
export interface NumberItem {
  eligible?: boolean;
  tokenHash?: string;
  /** 쿠키를 받은 요청의 도착 시각 칸(없으면 일반 번호) */
  arrivalSlot?: number;
}
/** ② 파드별 묶음: 회차 공통 값과 요청들(묶음 안 순서대로 번호를 나눠 준다) */
export type NumberBatchInput = Omit<NumberInput, 'eligible' | 'tokenHash' | 'arrivalSlot'> & { items: NumberItem[] };

export const ENTRY_STORE = Symbol('queue.EntryStore');
/**
 * 진입 3단계(§3): ① 사람 슬롯 선점 → ② 회차 슬롯 번호(또는 묶음) → ③ 사람 슬롯 기록(또는 묶음 기록). 사람 키(q:dup·q:adm)와
 * 회차 키는 해시 슬롯이 달라 한 Lua로 묶지 못한다. 이름은 명세 specs/queue.qnt의 동작 이름을 따른다
 */
export interface EntryStore {
  /** ① enterPreempt: q:adm이 있으면 ADMITTED. q:dup이 없으면 PENDING:{요청 ID}로 잡고 PROCEED. 같은 요청의 PENDING이면 PROCEED,
   * 같은 요청의 번호 기록이면 RECORDED, 같은 요청의 묶음 기록이면 BATCH, 그 밖은 BUSY. 진입 시도는 요청 ID로만 가른다(화면이 그 값을 둔다) */
  preempt(i: { pid: string; eventId: string; requestId: string; pendingTtlMs: number }): Promise<PreemptResult>;
  /** ②가 번호를 주지 않았으면(EARLY·WAIT) 값이 아직 내 PENDING일 때만 지운다 */
  release(i: { pid: string; eventId: string; requestId: string }): Promise<void>;
  /** ② enterNumber(파드별 묶음, ADR-0179): 서버 시각으로 로비·묶음 표시를 한 번 보고(없으면 먼저 쓰고) 요청마다 구간 안의 묶음 대상은 SADD,
   * 오픈 뒤 토큰은 WAIT, 그 밖은 번호를 받을 요청 수만큼 INCRBY해 묶음 안 순서대로 나눠 준다. 서버 시각으로 오픈 전이면 모두 EARLY. 세대 = 건너뛴 구간 줄 수 + 1 */
  numberBatch(i: NumberBatchInput): Promise<NumberResult[]>;
  /** 요청 하나짜리 ②(numberBatch를 1건으로 부른다) */
  number(i: NumberInput): Promise<NumberResult>;
  /** RB-05: 진입 ②가 RECOVERING을 받은 파드가 부른다. 다른 파드가 먼저 했거나 장애 전환이 아니면 DONE, 먼저 건너뛰었지만 복제 확인 전이면 PENDING */
  rb05(i: Rb05Input): Promise<Rb05Result>;
  /**
   * RB-05 복제 확인(ADR-0186): 세대 키가 지금 노드 표지이고 확인 전(pend)이면, 같은 연결로 표시를 쓰고 그 주 노드에 붙은 온라인 복제본 수만큼
   * WAIT로 받은 것을 확인한 뒤 표시를 지운다. 붙은 복제본이 없으면 바로 지운다
   */
  confirmRb05(i: { eventId: string }): Promise<Rb05Confirm>;
  /** ③ enterRecord: q:adm이 있으면 ADMITTED. 값이 내 PENDING이거나 비었으면 {번호}:{세대}:{요청 ID}:{jny}:{vr}:{대기표 해시}로 기록(수명 = 판매 종료). 같은 요청의 다른 기록이면 SAME(먼저 기록된 값),
   * 같은 요청의 묶음 기록이면 BATCH(그 토큰 해시), 그 밖은 TAKEN. ticketHash는 대기 취소가 soon·verify의 칸을 찾는 값이다(ADR-0233) */
  record(i: { pid: string; eventId: string; requestId: string; seq: number; gen: number; jny: string; vr?: ReasonCategory; expireAtMs: number; ticketHash?: string }): Promise<RecordResult>;
  /** ③ enterBatchRecord(OPEN[14]): q:adm이 있으면 ADMITTED. 값이 내 PENDING이거나 비었으면 BATCH:1:{토큰 해시}:{요청 ID}:{jny}:{vr}(수명 = 판매 종료).
   * 같은 요청의 묶음 기록이 이미 있으면 그대로 둔다. 둘 다 BATCHED와 기록된 토큰 해시. 같은 요청의 번호 기록이 먼저 있으면 SAME(그 기록), 그 밖은 TAKEN */
  batchRecord(i: {
    pid: string;
    eventId: string;
    requestId: string;
    tokenHash: string;
    jny: string;
    vr?: ReasonCategory;
    expireAtMs: number;
  }): Promise<{ kind: 'BATCHED'; tokenHash: string } | ({ kind: 'SAME' } & RecordedEntry) | { kind: 'ADMITTED' } | { kind: 'TAKEN' }>;
  /** 묶음 결과: q:batch:{토큰 해시}가 있으면 그 번호(게시는 결과를 다 쓴 뒤 pub:1을 쓰고, 입력이 같으면 같은 결과다). 없으면 회차 슬롯에서 pub:1과 참가자 목록을 본다.
   * 참가자인데 결과가 없으면 결과 키를 장애 전환으로 잃은 것이라 batch_done의 repair:1(처음 청한 시각)을 쓴다 */
  batchResult(i: { eventId: string; tokenHash: string }): Promise<BatchOutcome>;
  /** 게시 뒤 같은 요청의 묶음 기록을 번호 기록으로 바꾼다. 이미 바뀌었으면 그 기록, 다른 값이면 GONE */
  convertBatch(i: { pid: string; eventId: string; requestId: string; tokenHash: string; seq: number; gen: number; expireAtMs: number; ticketHash?: string }): Promise<({ kind: 'RECORDED' } & RecordedEntry) | { kind: 'GONE' }>;
  /** batchMissing: 결과에 없는 같은 요청의 묶음 기록을 지운다 */
  dropBatch(i: { pid: string; eventId: string; requestId: string; tokenHash: string }): Promise<void>;
  /**
   * pid 키 전환(§3 'pid 키 전환 기간'의 첫 구현): 앞 키(from)의 이 요청 값(번호 기록·묶음 기록)과 수명을 다른 키(to)에 옮겨 쓴다.
   * to가 비었거나 이 요청의 값(선점 포함)일 때만 쓰고 COPIED, 다른 요청의 값이면 TAKEN, to에 입장 키가 있으면 ADMITTED다.
   * from에 이 요청의 값이 없으면(장애 전환으로 잃음) 아무것도 하지 않고 COPIED다
   */
  mirror(i: { from: string; to: string; eventId: string; requestId: string }): Promise<'COPIED' | 'TAKEN' | 'ADMITTED'>;
  /** 값이 이 요청의 것(선점·번호 기록·묶음 기록)이면 지운다. 옮겨 쓰기가 막혔을 때 앞 키를 되돌린다 */
  dropOwn(i: { pid: string; eventId: string; requestId: string }): Promise<void>;
  /** 도착 시각 쿠키의 요청 ID를 잡는다(q:arr:{reqId}:E, 값은 진입 요청 ID, 수명 ttlMs). 같은 진입 요청 ID면 다시 받고, 다른 진입 요청이면 false(ADR-0223 결정 5) */
  claimArrival(i: { eventId: string; reqId: string; requestId: string; ttlMs: number }): Promise<boolean>;
  /** 번호를 빠진 번호 비트맵에 켠다. 회차 키의 수명은 부를 때마다 더 늦은 쪽으로만 늘린다 */
  markRemoved(i: { eventId: string; seq: number; expireAtMs: number }): Promise<void>;
  /** 고위험 진입: 빠진 번호 비트를 켜고 q:{event:E}:verify에 대기표 해시를 VERIFYING으로 쓴다(이미 있으면 그대로). 비트맵 수명은 expireAtMs, verify는 verifyExpireAtMs(판매 종료) */
  markVerifying(i: { eventId: string; seq: number; ticketHash: string; atMs: number; reason: ReasonCategory; expireAtMs: number; verifyExpireAtMs: number }): Promise<void>;
  /** 로비 참가 ③: 서버 시각과 로비 표시를 같은 Lua에서 본 뒤 참가자에 넣는다(추가 검증이면 verify에 값을 쓴다). 표시가 섰거나 오픈이 지났으면 CLOSED, 로비 개방 전이면 NOT_OPEN */
  addLobbyMember(i: { eventId: string; tokenHash: string; opensAtMs: number; lobbyOpensAtMs: number; expireAtMs: number; verify?: { value: string; expireAtMs: number } }): Promise<'ADDED' | 'NOT_OPEN' | 'CLOSED'>;
  /** 로비 창 보기(읽기만): 서버 시각과 로비 표시로 OPEN·NOT_OPEN·CLOSED를 준다. 공시 기록·위험 판정 전에 부른다 */
  lobbyWindow(i: { eventId: string; opensAtMs: number; lobbyOpensAtMs: number }): Promise<'OPEN' | 'NOT_OPEN' | 'CLOSED'>;
  /** 로비 참가 되돌리기: 참가자와 verify 기록을 뺀다. 로비 표시가 선 뒤에는 목록을 바꾸지 않고 verify에 ORPHAN을 적어 게시 때 빠진 번호가 되게 한다(수명 = 판매 종료) */
  removeLobbyMember(i: { eventId: string; tokenHash: string; expireAtMs: number }): Promise<void>;
  /** 로비 참가 ④: q:dup이 내 PENDING이거나 비었으면 LOBBY:{토큰 해시}:{요청 ID}로 바꾸고 수명을 판매 종료로. 다른 요청의 값이면 TAKEN, q:adm이 있으면 ADMITTED */
  recordLobby(i: { pid: string; eventId: string; requestId: string; tokenHash: string; expireAtMs: number }): Promise<'RECORDED' | 'ADMITTED' | 'TAKEN'>;
  /** 값이 이 요청의 LOBBY 기록일 때만 지운다(두 키 처리의 되돌리기) */
  dropLobbyRecord(i: { pid: string; eventId: string; requestId: string; tokenHash: string }): Promise<void>;
  /** 대기 취소가 읽는 사람 키의 기록. 비었거나 선점 값·취소 끝 표지면 null. 취소 중 표지면 원래 기록을 준다 */
  readHeld(i: { pid: string; eventId: string }): Promise<HeldRecord | null>;
  /** 사람 키의 값이 from일 때만 to로 바꾼다(수명은 그대로). 바꿨으면 true. 취소가 기록을 잡고, 끝내고, 되돌릴 때 쓴다(ADR-0233) */
  swapHeld(i: { pid: string; eventId: string; from: string; to: string }): Promise<boolean>;
  /**
   * 대기 취소의 번호 돌리기(명세 leave, ADR-0233): Lua 하나로 빠진 번호 비트를 켜고, 해시가 있으면 곧 입장 대기열 셋에서 빼고 verify의 VERIFYING·PASSED를 지운다.
   * expireAtMs는 비트맵 수명(판매 종료 + 1일)
   */
  leaveNumber(i: { eventId: string; seq: number; ticketHash?: string; expireAtMs: number }): Promise<void>;
  /**
   * 로비·묶음 참가의 취소: 표시(batch_done의 lobby·1)가 서기 전이면 목록에서 빼고 verify 칸을 지운다(REMOVED). 선 뒤면 목록을 바꾸지 않고 verify에 ORPHAN을 적고(BLOCKED는 그대로 둔다) batch_done에 orphan:{구간}을 남긴다(FIXED).
   * closesAtMs를 주면 서버 시각이 그 값을 지났거나 표시가 섰을 때 아무것도 바꾸지 않고 CLOSED다(로비 참가 취소의 창). 목록 고정 확인과 쓰기가 한 Lua다
   */
  leaveMember(i: { eventId: string; group: ShuffleGroup; tokenHash: string; closesAtMs?: number; verifyExpireAtMs: number }): Promise<'REMOVED' | 'FIXED' | 'CLOSED'>;
  /** 셔플 결과 키(q:lobby·q:batch)의 번호. 없으면 null */
  resultSeat(i: { group: ShuffleGroup; tokenHash: string }): Promise<{ seq: number; gen: number } | null>;
}
