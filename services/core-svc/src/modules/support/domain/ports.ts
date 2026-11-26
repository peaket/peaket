// core-svc support 포트(F-06-4). 저장소·Outbox·ops 입구·알림·화면용 사본.
import type { AppealRow, AppealStatus, CaseRequestedRow, FraudAppealViewRow, RestrictionViewRow } from './appeal.js';

export interface AppealStore {
  /** 소명과 CS 건 요청(Outbox)을 한 트랜잭션으로 쓴다 */
  saveAppeal(row: AppealRow, caseRequest: CaseRequestedRow): Promise<void>;
  find(appealId: string): Promise<AppealRow | undefined>;
  listByAccount(accountId: string, limit: number): Promise<AppealRow[]>;
  /** 결과 기록(같은 본문 멱등은 유스케이스가 본다) */
  saveResult(appealId: string, patch: { status: AppealStatus; result?: string | null; resultNote?: string | null; decidedAtMs: number; caseId?: string | null }): Promise<void>;
  /** 보내기 상태 갱신 */
  saveDispatch(appealId: string, patch: { state: AppealRow['dispatchState']; attempts: number; nextAtMs: number | null; dispatchedAtMs: number | null }): Promise<void>;
  /** 보낼 때가 된 소명(내부 작업) */
  dueDispatch(nowMs: number, limit: number): Promise<AppealRow[]>;
  outboxRows(): Promise<CaseRequestedRow[]>;
}

export interface RestrictionViewStore {
  apply(i: RestrictionViewRow): Promise<{ changed: boolean }>;
  get(accountId: string, restrictionId: string): Promise<RestrictionViewRow | undefined>;
  list(accountId: string): Promise<RestrictionViewRow[]>;
  clear(): Promise<void>;
}

export interface FraudAppealViewStore {
  apply(i: FraudAppealViewRow): Promise<{ changed: boolean }>;
  get(accountId: string, caseId: string): Promise<FraudAppealViewRow | undefined>;
  list(accountId: string): Promise<FraudAppealViewRow[]>;
  clear(): Promise<void>;
}

export interface FraudAppealClient {
  /** 반환: 접수(OBJECTED/HOLDER 기록)·EXPIRED·대상 아님·다시 보내기 */
  send(i: { caseId: string; appealId: string; accountId: string; party: 'PAYER' | 'HOLDER'; submittedAtMs: number }): Promise<{ result: 'ACCEPTED' | 'EXPIRED' | 'NOT_TARGET' | 'RETRY' }>;
}

/** FRAUD_CASE 소명이 대상 아님·기한 경과로 닫힐 때 ops CS 건·보류를 닫게 알린다(IR-07) */
export interface AppealCaseSink {
  invalid(i: { appealId: string; reason: string }): Promise<void>;
}

export interface FanNotifier {
  send(i: { appealId: string; accountId: string; event: 'INVALID' | 'DECIDED'; result?: string }): Promise<void>;
}
