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
export type PreemptResult = { kind: 'PROCEED' } | ({ kind: 'RECORDED' } & RecordedEntry) | { kind: 'ADMITTED' } | { kind: 'BUSY' };
export type RecordResult = { kind: 'RECORDED' } | ({ kind: 'SAME' } & RecordedEntry) | { kind: 'ADMITTED' } | { kind: 'TAKEN' };

export const ENTRY_STORE = Symbol('queue.EntryStore');
/**
 * 진입 3단계(§3): ① 사람 슬롯 선점 → ② 회차 슬롯 번호 → ③ 사람 슬롯 기록. 사람 키(q:dup·q:adm)와 회차 키는 해시 슬롯이 달라 한 Lua로 묶지 못한다
 */
export interface EntryStore {
  /** ① q:adm이 있으면 ADMITTED. q:dup이 없으면 PENDING:{요청 ID}로 잡고 PROCEED. 같은 요청의 PENDING이면 PROCEED, 같은 요청의 기록이면 RECORDED(기록 값), 그 밖은 BUSY */
  preempt(i: { pid: string; eventId: string; requestId: string; pendingTtlMs: number }): Promise<PreemptResult>;
  /** ② INCR 카운터, 세대 = 건너뛴 구간 줄 수 + 1 */
  number(i: { eventId: string; expireAtMs: number }): Promise<{ seq: number; gen: number }>;
  /** ③ q:adm이 있으면 ADMITTED. 값이 내 PENDING이거나 비었으면 {번호}:{세대}:{요청 ID}:{jny}:{vr}로 기록(수명 = 판매 종료). 같은 요청의 다른 기록이면 SAME(먼저 기록된 값), 그 밖은 TAKEN */
  record(i: { pid: string; eventId: string; requestId: string; seq: number; gen: number; jny: string; vr?: ReasonCategory; expireAtMs: number }): Promise<RecordResult>;
  /** 번호를 빠진 번호 비트맵에 켠다. 회차 키의 수명은 부를 때마다 더 늦은 쪽으로만 늘린다 */
  markRemoved(i: { eventId: string; seq: number; expireAtMs: number }): Promise<void>;
  /** 고위험 진입: 빠진 번호 비트를 켜고 q:{event:E}:verify에 대기표 해시를 VERIFYING으로 쓴다(이미 있으면 그대로). 비트맵 수명은 expireAtMs, verify는 verifyExpireAtMs(판매 종료) */
  markVerifying(i: { eventId: string; seq: number; ticketHash: string; atMs: number; reason: ReasonCategory; expireAtMs: number; verifyExpireAtMs: number }): Promise<void>;
}
