// 추가 검증 컨텍스트의 포트: 대기열 Redis 저장소, 본인확인 재통과 확인(identity-svc), 사람 확인 검증(trust-svc VERIFICATION), 건 요청 발행, 지표.
import type { AppealDraft, CaseRequest, ResolveResult, StoredAppeal } from './verification.js';

export const VERIFICATION_STORE = Symbol('queue.VerificationStore');
export const VERIFICATION_SCHEDULES = Symbol('queue.VerificationSchedules');
export const VERIFICATION_OPTIONS = Symbol('queue.VerificationOptions');
export const REVERIFICATION = Symbol('queue.Reverification');
export const VERIFICATION_RISK = Symbol('queue.VerificationRisk');
export const CASE_REQUESTS = Symbol('queue.CaseRequests');
export const VERIFICATION_SIGNALS = Symbol('queue.VerificationSignals');

/** 회차 슬롯 Lua의 결과: APPLIED(VERIFYING이라 바꿨다, value는 새 값), CURRENT(VERIFYING이 아니라 그대로 둔 지금 값), GONE(칸이 없다). serving은 같은 Lua에서 읽은 값 */
export type SettleOutcome = { kind: 'APPLIED' | 'CURRENT'; value: string; serving: number } | { kind: 'GONE'; serving: number };

/** 결과 반영 시작(사람 슬롯): UNCHANGED(저장한 판 이상), OTHER_CASE(이 이의는 다른 건에 묶였다), PROCEED(retry: 같은 건·판·결과로 시작했다가 끊긴 호출의 다시 부름) */
export type ResolveBegin = { kind: 'NOT_FOUND' } | { kind: 'UNCHANGED' } | { kind: 'OTHER_CASE' } | { kind: 'PROCEED'; retry: boolean };

/**
 * 추가 검증의 대기열 Redis(docs/data.md §3). 사람 키(q:dup·q:vsub·q:appeal)는 pid 해시 태그, 회차 키(verify·serving)는 {event:E} 태그,
 * 이의 ID 색인(q:appealid)·건 ID 색인(q:appealcase)은 그 ID로 샤드 전체에 흩는다. 슬롯이 달라 한 Lua로 묶지 못한다(queue-admission §6 '순서').
 * 일시 장애는 QueueStoreUnavailable을 던진다
 */
export interface VerificationStore {
  /** 사람 키 q:dup:{pid}:E의 값(없으면 null) */
  readDup(pid: string, eventId: string): Promise<string | null>;
  readVerify(eventId: string, fieldHash: string): Promise<string | null>;
  /** 로비 셔플 결과 q:lobby:{참가 토큰 해시}의 번호(게시 전이면 null) */
  lobbySeq(tokenHash: string): Promise<number | null>;
  /** 리더가 쓰는 serving(없으면 0)과, 번호의 차례가 왔으면 그 차례 시각(serving_log에서 그 번호 이상인 첫 초 칸, 기록이 없으면 없다). 입장 확정의 차례 시각과 같은 읽기다 */
  turnOf(eventId: string, seq: number): Promise<{ serving: number; turnAtMs?: number }>;
  /** challengeToken 제출 하나를 센다(첫 제출이 창 수명으로 키를 만든다). 이번까지의 수와 남은 수명(ms) */
  countSubmit(pid: string, eventId: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
  /** 센 제출 하나를 되돌린다(trust-svc를 부르지 못한 503). 0 아래로 내리지 않고 수명은 그대로다 */
  uncountSubmit(pid: string, eventId: string): Promise<void>;
  /** 회차 슬롯 Lua: 칸이 VERIFYING일 때만 {target}:{서버 시각}:{사유}로 바꾼다. 빠진 번호 비트는 건드리지 않는다 */
  settleVerify(eventId: string, fieldHash: string, target: 'PASSED' | 'BLOCKED'): Promise<SettleOutcome>;
  /** 사람 슬롯 Lua(HSETNX): 이의가 없으면 draft로 처음 것을 두고 created true, 있으면 그대로 둔 처음 것 */
  openAppeal(pid: string, eventId: string, draft: AppealDraft): Promise<{ created: boolean; appeal: StoredAppeal }>;
  readAppeal(pid: string, eventId: string): Promise<StoredAppeal | null>;
  /** 이의 ID 색인 q:appealid:{appealId}(값 = 회차 ID와 pid, 수명은 이의와 같다) */
  indexAppeal(appealId: string, eventId: string, pid: string, expireAtMs: number): Promise<void>;
  findAppeal(appealId: string): Promise<{ eventId: string; pid: string } | null>;
  /** 건 요청 발행이 확인됐다(이의 ID가 같을 때만). 이 호출이 처음 표시했으면 true */
  markSent(pid: string, eventId: string, appealId: string): Promise<boolean>;
  /** 건 ID 색인 q:appealcase:{caseId}를 SET NX로 잡는다. 그 건에 묶인 이의 ID(처음 것)를 돌려준다 */
  claimCase(caseId: string, appealId: string, expireAtMs: number): Promise<string>;
  /** 결과 반영 시작(사람 슬롯 Lua): 판이 저장한 판보다 클 때만 진행 표지(건·판·결과)를 남기고 PROCEED */
  beginResolve(pid: string, eventId: string, appealId: string, r: { caseId: string; version: number; outcome: string }): Promise<ResolveBegin>;
  /** 결과 반영 끝(사람 슬롯 Lua): 회차 쓰기 뒤에 판 번호·결과를 올린다(판이 저장한 판보다 클 때만) */
  commitResolve(pid: string, eventId: string, appealId: string, r: { caseId: string; version: number; outcome: string; result: ResolveResult }): Promise<void>;
}

/** identity.proto ReverificationResult */
export type ReverificationResult = 'PASSED' | 'NOT_FOUND' | 'PERSON_MISMATCH';
/** identity-svc가 답하지 않았다(오류·데드라인 넘김·차단기 열림·모르는 응답). 통과로 보지 않는다(I-T56 ④) */
export class ReverificationUnavailable extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ReverificationUnavailable';
  }
}
/** identity-svc ReverificationCheckService.CheckReverification(데드라인 800ms [가정]). 받지 못하면 ReverificationUnavailable을 던진다 */
export interface ReverificationPort {
  check(i: { accountId: string; pid: string; notBeforeMs: number }): Promise<ReverificationResult>;
}

/** 게이트웨이가 넘긴 요청 정보(trust.proto ClientSignals). 사람 확인 서버 검증의 remoteip에 쓴다 */
export interface VerificationClient {
  ip: string;
  userAgent?: string;
  asn: number;
  clientHints: Record<string, string>;
}
/** ALLOW 사람 확인 성공, CHALLENGE 실패, HELD trust-svc가 사람 확인을 검증하지 못함(degraded), UNAVAILABLE 판정을 받지 못함(차단기 열림·오류) */
export type HumanVerdict = 'ALLOW' | 'CHALLENGE' | 'HELD' | 'UNAVAILABLE';
/** trust-svc ScoreRisk(맥락 SCORE_CONTEXT_VERIFICATION: HumanCheck만, action verify). 던지지 않는다 */
export interface VerificationRiskPort {
  verify(i: { eventId: string; accountId: string; pid: string; deviceId?: string; humanCheckToken: string; client?: VerificationClient }): Promise<HumanVerdict>;
}

/** support.cases-requested에 VERIFICATION_APPEAL 건 요청을 낸다. 실패하면 던진다(기다리는 상한은 부르는 쪽이 건다) */
export interface CaseRequestPublisher {
  publish(c: CaseRequest): Promise<void>;
}

/** 지표(docs/features/bot-defense.md §15): queue_verification_submissions_total{result}·queue_verification_appeals_total{result} */
export type SubmissionResult = 'passed' | 'challenge_failed' | 'reverify_required' | 'person_mismatch' | 'unavailable' | 'rate_limited';
export type AppealResult = 'accepted' | 'duplicate' | 'publish_failed';
export interface VerificationSignals {
  submission(result: SubmissionResult): void;
  appeal(result: AppealResult): void;
}
export const noVerificationSignals: VerificationSignals = { submission: () => undefined, appeal: () => undefined };

/** 판정을 받을 수 없는 환경(주소가 없는 local·ci·demo)의 포트: 늘 503이다 */
export const unavailableReverification: ReverificationPort = {
  check: () => Promise.reject(new ReverificationUnavailable('identity-svc 주소가 없다')),
};
export const unavailableVerificationRisk: VerificationRiskPort = { verify: async () => 'UNAVAILABLE' };
export const unavailableCaseRequests: CaseRequestPublisher = {
  publish: () => Promise.reject(new Error('건 요청 생산자가 없다(PEAKET_KAFKA_BROKERS 없음)')),
};
