// 진입 컨텍스트의 포트: 토큰 코덱, 회차 일정 사본, 위험 판정, 진입 저장소(대기열 Redis).
import type { EventSchedule, PreverifyClaims, ReasonCategory, TicketClaims } from './queue.js';

export const QUEUE_TOKENS = Symbol('queue.QueueTokens');
/** 사전 검증 토큰·대기표의 HMAC 코덱. 읽기는 MAC·형식이 맞을 때만 클레임을 주고 아니면 null(만료는 부르는 쪽이 본다) */
export interface QueueTokens {
  preverify(c: PreverifyClaims): string;
  readPreverify(token: string): PreverifyClaims | null;
  ticket(c: TicketClaims): string;
  readTicket(token: string): TicketClaims | null;
  /** 대기표 해시(q:adm 값, q:{event:E}:verify 필드): SHA-256 16진 */
  hash(token: string): string;
}

export const EVENT_SCHEDULES = Symbol('queue.EventSchedules');
export interface EventSchedules {
  /** 사본이 없으면 null(그 회차의 대기열이 열리지 않음) */
  get(eventId: string): Promise<EventSchedule | null>;
}

export interface RiskInput {
  context: 'PREVERIFY';
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
  | { kind: 'BUSY' };
export type RecordResult = { kind: 'RECORDED' } | ({ kind: 'SAME' } & RecordedEntry) | { kind: 'BATCH'; tokenHash: string } | { kind: 'ADMITTED' } | { kind: 'TAKEN' };
/** 묶음 결과: 번호, 게시 전, 참가자인데 결과 키가 없음(다시 쓰기를 청했다), 참가자 목록에 없음(batchMissing) */
export type BatchOutcome = { kind: 'RESULT'; seq: number; gen: number } | { kind: 'PENDING' } | { kind: 'REPAIRING' } | { kind: 'MISSING' };
/** ② 회차 슬롯의 결과: 번호, 묶음에 넣음(202), 묶음 구간이라 기다림(503), 서버 시각으로 아직 오픈 전 */
export type NumberResult = { kind: 'NUMBERED'; seq: number; gen: number } | { kind: 'BATCHING' } | { kind: 'WAIT'; retryAfterSeconds: number } | { kind: 'EARLY' };

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
}

/** ② 파드별 묶음의 요청 하나(ADR-0179) */
export interface NumberItem {
  eligible?: boolean;
  tokenHash?: string;
}
/** ② 파드별 묶음: 회차 공통 값과 요청들(묶음 안 순서대로 번호를 나눠 준다) */
export type NumberBatchInput = Omit<NumberInput, 'eligible' | 'tokenHash'> & { items: NumberItem[] };

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
  /** ③ enterRecord: q:adm이 있으면 ADMITTED. 값이 내 PENDING이거나 비었으면 {번호}:{세대}:{요청 ID}:{jny}:{vr}로 기록(수명 = 판매 종료). 같은 요청의 다른 기록이면 SAME(먼저 기록된 값),
   * 같은 요청의 묶음 기록이면 BATCH(그 토큰 해시), 그 밖은 TAKEN */
  record(i: { pid: string; eventId: string; requestId: string; seq: number; gen: number; jny: string; vr?: ReasonCategory; expireAtMs: number }): Promise<RecordResult>;
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
  convertBatch(i: { pid: string; eventId: string; requestId: string; tokenHash: string; seq: number; gen: number; expireAtMs: number }): Promise<({ kind: 'RECORDED' } & RecordedEntry) | { kind: 'GONE' }>;
  /** batchMissing: 결과에 없는 같은 요청의 묶음 기록을 지운다 */
  dropBatch(i: { pid: string; eventId: string; requestId: string; tokenHash: string }): Promise<void>;
  /** 번호를 빠진 번호 비트맵에 켠다. 회차 키의 수명은 부를 때마다 더 늦은 쪽으로만 늘린다 */
  markRemoved(i: { eventId: string; seq: number; expireAtMs: number }): Promise<void>;
  /** 고위험 진입: 빠진 번호 비트를 켜고 q:{event:E}:verify에 대기표 해시를 VERIFYING으로 쓴다(이미 있으면 그대로). 비트맵 수명은 expireAtMs, verify는 verifyExpireAtMs(판매 종료) */
  markVerifying(i: { eventId: string; seq: number; ticketHash: string; atMs: number; reason: ReasonCategory; expireAtMs: number; verifyExpireAtMs: number }): Promise<void>;
}
