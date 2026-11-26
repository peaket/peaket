// F-04-15 support 포트. core DB appeal·화면용 사본·ops 내부 연결의 경계다.
import type { AppealKind, AppealRecord, FraudAppealViewRecord } from './appeal.js';

export interface IdempotentWrite {
  readonly accountRef: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: Uint8Array;
}

export type IdempotentLookup =
  | { readonly kind: 'none' }
  | { readonly kind: 'replay'; readonly result: unknown }
  | { readonly kind: 'reused' }
  | { readonly kind: 'in_progress' };

export interface SupportAppealStore {
  put(a: AppealRecord, o?: { idem?: IdempotentWrite; result?: unknown }): Promise<{ replayed: boolean; result?: unknown }>;
  get(appealId: string): Promise<AppealRecord | null>;
  listByAccount(accountId: string, q: { cursor?: string; limit: number }): Promise<{ items: AppealRecord[]; nextCursor: string | null }>;
  update(a: AppealRecord): Promise<boolean>;
  findIdempotent(idem: IdempotentWrite): Promise<IdempotentLookup>;
}

export interface FraudCaseAppeals {
  submit(i: { caseId: string; appealId: string; accountId: string; party: 'PAYER' | 'HOLDER'; submittedAt: string }): Promise<{ result: 'SUBMITTED' | 'OBJECTION_SUBMITTED' | 'EXPIRED' | 'INVALID' }>;
}

export interface AppealTargets {
  submit(i: { appealId: string; kind: AppealKind; targetId: string; accountId: string }): Promise<{ result: 'SUBMITTED' | 'UNAVAILABLE' }>;
}

export interface FraudAppealViews {
  set(v: FraudAppealViewRecord): Promise<void>;
  list(accountId: string): Promise<readonly FraudAppealViewRecord[]>;
}
