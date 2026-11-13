// 입장 확정 컨텍스트의 포트: 입장 저장소(대기열 Redis), 우선 구매 권리 사본, 입장 토큰 서명, 지표.
import type { AdmitResult, Claim, LobbySeat, Precheck } from './admission.js';
import type { PriorityGrantCopy, PriorityGrantSetInput } from './priority-grant.js';

export const ADMISSION_STORE = Symbol('queue.AdmissionStore');
/**
 * 입장 확정(§6, ADR-0183): ① 회차 슬롯 확인 → ② 사람 슬롯 q:adm → ③ 회차 슬롯 입장 → ④ 사람 슬롯 마무리.
 * 사람 키(q:adm·q:dup)와 회차 키는 해시 슬롯이 달라 한 Lua로 묶지 못한다. 이름은 명세 specs/queue.qnt의 admit을 나눈 것이다
 */
export interface AdmissionStore {
  /**
   * ① 읽기만: 판매 상태, 빠진 번호·추가 검증(VERIFYING이면 VERIFYING, PASSED면 받음, BLOCKED면 removeReason을 단 REMOVED), 건너뛴 구간 세대, 차례 전,
   * 차례 시각과 유예 graceMs(차례와 통과 가운데 늦은 때부터, 곧 입장 대기열에 있거나 이 대기표의 자리가 살아 있으면 세지 않음)
   */
  precheck(i: { eventId: string; seq: number; gen: number; ticketHash: string; graceMs: number }): Promise<Precheck>;
  /** ② q:adm이 비었으면 {해시}:{요청 표지}로 채운다(수명 = 판매 종료). 같은 대기표면 SAME, 다른 대기표면 DUP */
  claim(i: { pid: string; eventId: string; ticketHash: string; nonce: string; expireAtMs: number }): Promise<Claim>;
  /**
   * ③ 이 대기표의 살아 있는 자리(slot_of)가 있으면 같은 jti를 다시 준다(again, 첫 사용 기한을 지금부터로 올림). 아니면 빈자리(지금 목표 − 만료 전 자리) >
   * soon에서 내 앞 번호 수일 때 freshJti로 자리를 잡고, 아니면 곧 입장 대기열에 넣는다. 처음 요청은 번호마다 한 번(req 비트) 그 번호를 부른 전진에 센다
   */
  admit(i: {
    eventId: string;
    seq: number;
    ticketHash: string;
    freshJti: string;
    /** 처음 요청을 셀 전진을 고르는 차례 시각 칸(없으면 세지 않음) */
    turnAtMs?: number;
    /** 건너뛴 구간 안의 옛 세대 번호(처음 요청을 세지 않는다) */
    skipped: boolean;
    /** 회차 키 수명(판매 종료 + 1일)과 곧 입장 키 수명(판매 종료) */
    keepUntilMs: number;
    soonExpireAtMs: number;
    /** 입장 토큰 `lst`의 후보 명단 키와 계정 ID(설정이 틀리면 넘기지 않는다). ADMITTED일 때 그 계정이 든 키만 돌려준다 */
    eligibility?: { accountId: string; listKeys: readonly string[] };
  }): Promise<AdmitResult>;
  /** ④ ADMITTED: q:adm이 없거나 같은 대기표면 이 요청의 표지로 다시 쓰고(없으면 수명 = 판매 종료) q:dup을 지운다. RELEASE: 값이 이 요청이 채운 그대로일 때만 지운다 */
  settle(i: { pid: string; eventId: string; ticketHash: string; outcome: 'ADMITTED' | 'RELEASE'; nonce: string; expireAtMs: number }): Promise<void>;
  /** 15분 만료: q:dup 값이 이 대기표의 {번호}:{세대}:로 시작하면 지운다(참가 토큰이면 dupPrefix로 준 LOBBY:{토큰 해시}:로). 이 회차에 입장한 적이 있는지(q:adm이 있는지)를 준다 */
  expire(i: { pid: string; eventId: string; seq: number; gen: number; dupPrefix?: string }): Promise<{ admittedBefore: boolean }>;
  /** 로비 셔플 결과 q:lobby:{토큰 해시}. 없으면 회차 슬롯의 pub:lobby와 참가자 목록을 본다. 게시 전 PENDING, 참가자인데 결과가 없으면 repair:lobby를 쓰고 REPAIRING, 참가자가 아니면 GONE */
  lobbySeat(i: { eventId: string; tokenHash: string; nowMs: number }): Promise<LobbySeat>;
  /**
   * 1인 1순번 위반으로 거절한 번호를 빠진 번호 비트맵에 켜고, 그 대기표의 verify 칸이 PASSED·VERIFYING이면 지운다(queue-admission §7, docs/data.md §5 경합 ④).
   * BLOCKED·ORPHAN과 다른 대기표의 칸은 두며, 지운 칸이 있으면 verifyCleared
   */
  markRemoved(i: { eventId: string; seq: number; ticketHash: string; expireAtMs: number }): Promise<{ verifyCleared: boolean }>;
  /** 구매 세션 시작: jti 자리가 남아 있을 때만 점수를 최대 체류 시각으로 올린다(ZADD XX GT). 바꿨으면 true */
  sessionStarted(i: { eventId: string; jti: string; maxStayUntilMs: number }): Promise<boolean>;
  /** 구매 세션 종료: 자리를 뺀다. 뺐으면 true */
  sessionEnded(i: { eventId: string; jti: string }): Promise<boolean>;
}

export const PRIORITY_GRANTS = Symbol('queue.PriorityGrantStore');
/** 우선 구매 권리 사본(`q:prio:{account}:E`, docs/data.md). 판 번호가 클 때만 바꾼다 */
export interface PriorityGrantStore {
  set(i: PriorityGrantSetInput): Promise<{ changed: boolean }>;
  /** 그 계정·회차의 사본. 권리 ID가 다르거나 망가졌으면 undefined */
  get(i: { accountId: string; eventId: string; grantId: string }): Promise<PriorityGrantCopy | undefined>;
}

/** 입장 확정 규칙 값(조립에서 바꿀 수 있다. 시험은 기본값과 다른 값으로도 돈다) */
export const ADMISSION_POLICY = Symbol('queue.AdmissionPolicy');
export interface AdmissionPolicy {
  /** 차례(또는 추가 검증 통과) 뒤 입장 확정을 받는 시간(기본 TURN_GRACE_MS) */
  turnGraceMs?: number;
}

export const ADMISSION_TOKENS = Symbol('queue.AdmissionTokens');
/** 입장 토큰 서명(ES256, typ admission+jwt, aud purchase). exp = iat + 최대 체류 */
export interface AdmissionTokens {
  /** firstIssuedAtMs: 같은 jti를 다시 줄 때 첫 발급 시각. exp를 그 시각 + 최대 체류로 둔다(없으면 nowMs 기준). iat는 늘 nowMs다.
   * lists: 판매 자격 명단 키(그 계정이 든 것만). 있으면 클레임 `lst`에 싣는다(ADR-0265 결정 7)
   * priorityGrantId: 우선 구매 입장이면 클레임 `prio`에 싣는다(GAT-135, ADR-0171) */
  sign(c: {
    jti: string;
    accountId: string;
    sessionId: string;
    eventId: string;
    jny: string;
    nowMs: number;
    firstIssuedAtMs?: number;
    lists?: string[];
    priorityGrantId?: string;
  }): { token: string; expiresAtMs: number };
  /** 입장 확정 응답의 서버 ECDH 공개키(설정이 없으면 undefined, BOT-100) */
  serverEcdhPublicKey(): Record<string, string> | undefined;
}

export const ADMISSION_SIGNALS = Symbol('queue.AdmissionSignals');
/** 입장 확정 지표(docs/observability.md §5 대기 순서 신호·입장 루프 신호) */
export interface AdmissionSignals {
  /** 차례 전 입장(0건 불변식) */
  admittedBeforeTurn(): void;
  /** 차례가 온 뒤 입장 실패(user: 15분 만료, system: 차례 확인 뒤 저장소 일시 장애) */
  turnEntryFailed(cause: 'user' | 'system'): void;
  arrivalDelay(seconds: number): void;
  soonWait(seconds: number): void;
  etaError(ratio: number): void;
}

/** 지표를 버리는 구현(시험·지표를 달지 않은 조립) */
export const noSignals: AdmissionSignals = {
  admittedBeforeTurn: () => undefined,
  turnEntryFailed: () => undefined,
  arrivalDelay: () => undefined,
  soonWait: () => undefined,
  etaError: () => undefined,
};
