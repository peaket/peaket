// 소명 도메인(F-06-4, transfer-refund §7.1). 종류·상태·본문 정규화.
export const APPEAL_KINDS = ['RESTRICTION', 'FRAUD_CASE'] as const;
export type AppealKind = (typeof APPEAL_KINDS)[number];
export const isAppealKind = (v: string): v is AppealKind => (APPEAL_KINDS as readonly string[]).includes(v);

export const APPEAL_STATUSES = ['SUBMITTED', 'DECIDED', 'INVALID'] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];
export const APPEAL_RESULTS = ['LIFTED', 'KEPT', 'ACCEPTED', 'REJECTED'] as const;
export type AppealResult = (typeof APPEAL_RESULTS)[number];

export const APPEAL_BODY_MAX = 2_000;
export const DISPATCH_RETRY_BASE_MS = 60_000;
export const DISPATCH_RETRY_CAP_MS = 600_000;

export const normalizeBody = (v: string): string => v.normalize('NFC');
export const bodyLength = (v: string): number => [...normalizeBody(v)].length;
export const dispatchRetryDelayMs = (attempts: number): number => (attempts <= 1 ? DISPATCH_RETRY_BASE_MS : DISPATCH_RETRY_CAP_MS);

export interface AppealRow {
  readonly appealId: string;
  readonly accountId: string;
  readonly kind: AppealKind;
  readonly targetId: string;
  readonly body: string;
  readonly status: AppealStatus;
  readonly result: AppealResult | null;
  readonly resultNote: string | null;
  readonly caseId: string | null;
  readonly submittedAtMs: number;
  readonly decidedAtMs: number | null;
  readonly dispatchState: 'PENDING' | 'SENT' | 'RETRY' | 'FAILED';
  readonly dispatchAttempts: number;
  readonly nextDispatchAtMs: number | null;
  readonly dispatchedAtMs: number | null;
}

export interface CaseRequestedRow {
  readonly eventKey: string;
  readonly kind: 'APPEAL';
  readonly sourceId: string;
  readonly category: AppealKind;
  readonly createdAt: string;
}

export interface RestrictionViewRow {
  readonly accountId: string;
  readonly restrictionId: string;
  readonly state: 'ACTIVE' | 'LIFTED';
  readonly reasonCode: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number | null;
  readonly appealDueAtMs: number;
  readonly version: number;
}

export interface FraudAppealViewRow {
  readonly accountId: string;
  readonly caseId: string;
  readonly eventId: string;
  readonly party: 'PAYER' | 'HOLDER';
  readonly reasonCategories: string[];
  readonly dueAtMs: number;
  readonly heldTicketIds: string[];
  readonly excludedTicketIds: string[];
  readonly lockedTicketIds: string[];
  readonly state: 'OPEN' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
  readonly version: number;
  readonly objectionDueAtMs: number | null;
  readonly objectionStatus: 'NONE' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED';
  readonly objectionNote: string | null;
  readonly cancelledTicketIds: string[];
  readonly restrictedUntilMs: number | null;
  readonly lockExpiresAtMs: number | null;
  readonly lockActive: boolean;
  readonly priorityPurchases: Array<{ grantId: string; seatLabel: string; price: number; expiresAtMs: number; status: string }>;
  readonly actionResult: Record<string, unknown> | null;
}
