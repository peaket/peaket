// 입장 확정 컨텍스트의 포트: 입장 저장소(대기열 Redis), 입장 토큰 서명, 지표.
import type { AdmitResult, Claim, Precheck } from './admission.js';

export const ADMISSION_STORE = Symbol('queue.AdmissionStore');
/**
 * 입장 확정(§6, ADR-0183): ① 회차 슬롯 확인 → ② 사람 슬롯 q:adm → ③ 회차 슬롯 입장 → ④ 사람 슬롯 마무리.
 * 사람 키(q:adm·q:dup)와 회차 키는 해시 슬롯이 달라 한 Lua로 묶지 못한다. 이름은 명세 specs/queue.qnt의 admit을 나눈 것이다
 */
export interface AdmissionStore {
  /** ① 읽기만: 판매 상태, 빠진 번호·추가 검증, 건너뛴 구간 세대, 차례 전, 차례 시각과 15분(곧 입장 대기열에 있으면 세지 않음) */
  precheck(i: { eventId: string; seq: number; gen: number; ticketHash: string }): Promise<Precheck>;
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
  }): Promise<AdmitResult>;
  /** ④ ADMITTED: q:adm이 없거나 같은 대기표면 이 요청의 표지로 다시 쓰고(없으면 수명 = 판매 종료) q:dup을 지운다. RELEASE: 값이 이 요청이 채운 그대로일 때만 지운다 */
  settle(i: { pid: string; eventId: string; ticketHash: string; outcome: 'ADMITTED' | 'RELEASE'; nonce: string; expireAtMs: number }): Promise<void>;
  /** 15분 만료: q:dup 값이 이 대기표의 {번호}:{세대}:로 시작하면 지운다. 이 회차에 입장한 적이 있는지(q:adm이 있는지)를 준다 */
  expire(i: { pid: string; eventId: string; seq: number; gen: number }): Promise<{ admittedBefore: boolean }>;
  /** 1인 1순번 위반으로 거절한 번호를 빠진 번호 비트맵에 켠다 */
  markRemoved(i: { eventId: string; seq: number; expireAtMs: number }): Promise<void>;
  /** 구매 세션 시작: jti 자리가 남아 있을 때만 점수를 최대 체류 시각으로 올린다(ZADD XX GT). 바꿨으면 true */
  sessionStarted(i: { eventId: string; jti: string; maxStayUntilMs: number }): Promise<boolean>;
  /** 구매 세션 종료: 자리를 뺀다. 뺐으면 true */
  sessionEnded(i: { eventId: string; jti: string }): Promise<boolean>;
}

export const ADMISSION_TOKENS = Symbol('queue.AdmissionTokens');
/** 입장 토큰 서명(ES256, typ admission+jwt, aud purchase). exp = iat + 최대 체류 */
export interface AdmissionTokens {
  /** firstIssuedAtMs: 같은 jti를 다시 줄 때 첫 발급 시각. exp를 그 시각 + 최대 체류로 둔다(없으면 nowMs 기준). iat는 늘 nowMs다 */
  sign(c: { jti: string; accountId: string; sessionId: string; eventId: string; jny: string; nowMs: number; firstIssuedAtMs?: number }): { token: string; expiresAtMs: number };
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
