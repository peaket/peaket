// F-04-12 조사 모듈 포트. 저장소·외부 의존을 도메인에서 떼어 둔다.
import type {
  FraudCaseRecord,
  FraudCaseStatus,
  FraudClusterRecord,
  FraudRunRecord,
  FraudSnapshotRecord,
} from './investigation.js';

export interface InvestigationStore {
  putSnapshot(s: FraudSnapshotRecord): Promise<void>;
  latestSnapshot(eventId: string): Promise<FraudSnapshotRecord | null>;
  verifySnapshot(eventId: string, version: number, status: 'OK' | 'MISMATCH', nowMs: number): Promise<void>;
  isSnapshotExportBlocked(eventId: string, version: number): Promise<boolean>;
  putRun(run: FraudRunRecord): Promise<void>;
  latestRun(eventId: string): Promise<FraudRunRecord | null>;
  listRuns(eventId: string): Promise<FraudRunRecord[]>;
  putClusters(eventId: string, generation: number, clusters: readonly FraudClusterRecord[]): Promise<void>;
  listClusters(q: {
    eventId: string;
    generation: number;
    sort: 'SCORE_DESC' | 'PURCHASE_RATIO_DESC' | 'LATEST';
    cursor?: string;
    limit: number;
  }): Promise<{ items: FraudClusterRecord[]; nextCursor: string | null }>;
  getCluster(clusterId: string): Promise<FraudClusterRecord | null>;
  putCase(c: FraudCaseRecord): Promise<void>;
  getCase(caseId: string): Promise<FraudCaseRecord | null>;
  findCaseByCluster(clusterId: string): Promise<FraudCaseRecord | null>;
  listCases(q: {
    eventId?: string;
    status?: readonly FraudCaseStatus[];
    cursor?: string;
    limit: number;
  }): Promise<{ items: FraudCaseRecord[]; nextCursor: string | null }>;
  updateCase(c: FraudCaseRecord, expectedVersion: number, events: readonly FraudCaseRecord['events'][number][]): Promise<boolean>;
  markAppealSubmitted(caseId: string, accountId: string, nowMs: number): Promise<boolean>;
  countCases(eventId: string): Promise<{ total: number; byStatus: Record<string, number> }>;
  hasOpenCase(eventId: string): Promise<boolean>;
  openCaseEvents(): Promise<string[]>;
}

export interface TransferLocks {
  set(i: {
    caseId: string;
    eventId: string;
    accountIds: readonly string[];
    version: number;
    expiresAtMs: number;
    actedBy: string;
  }): Promise<{
    lockedTicketCount: number;
    withdrawnOfferCount: number;
    holders: readonly { accountId: string; ticketIds: readonly string[] }[];
  }>;
  release(i: { caseId: string; eventId: string; accountIds: readonly string[]; version: number; actedBy: string }): Promise<void>;
}

export interface FraudNotifier {
  holderNotice(i: { eventId: string; caseId: string; accountId: string; ticketIds: readonly string[]; dueAtMs: number }): Promise<void>;
}

export interface FraudLabels {
  apply(i: { eventId: string; caseId: string; accountIds: readonly string[]; label: 'HUMAN' | 'BOT' }): Promise<void>;
}

export interface FraudAlerts {
  raise(i: { eventId: string; version: number; severity: 'SEV2' | 'SEV3'; kind: string }): Promise<void>;
}

export interface InvestigationAccessLog {
  record(i: {
    accountId: string;
    role: string;
    action: string;
    eventId?: string;
    caseId?: string;
    clusterId?: string;
    rows?: number;
    outcome: 'ALLOWED' | 'DENIED';
  }): Promise<void>;
}

export interface FraudOpsEventSink {
  emit(i: {
    opsEvent: 'FRAUD_SNAPSHOT' | 'FRAUD_CLUSTER_RUN';
    stage: string;
    eventId: string;
    generation?: number;
    attempt?: number;
    trigger?: string;
    result?: string;
    clusterCount?: number | null;
  }): void;
}

export interface SnapshotVerifier {
  verify(s: FraudSnapshotRecord): Promise<{ ok: boolean; mismatchedTables: string[] }>;
}

export interface FraudForensicsRunner {
  run(i: { eventId: string; generation: number; attempt: number; snapshotVersion: number; ruleVersion: string }): Promise<
    { ok: true; resultFingerprint: string; clusterCount: number } | { ok: false; error: unknown }
  >;
}
