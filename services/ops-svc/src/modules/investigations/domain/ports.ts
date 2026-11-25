// F-04-12 조사 모듈 포트. 저장소·외부 의존을 도메인에서 떼어 둔다.
import type {
  FraudCaseRecord,
  FraudCaseStatus,
  FraudClusterRecord,
  FraudRunRecord,
  FraudSnapshotRecord,
} from './investigation.js';

export interface InvestigationStore {
  /** 사건·감사 기록이 같은 트랜잭션에 들어가는지. 메모리 판은 감사기를 받았을 때만 참이다 */
  readonly auditsWrites: boolean;
  putSnapshot(s: FraudSnapshotRecord): Promise<void>;
  latestSnapshot(eventId: string): Promise<FraudSnapshotRecord | null>;
  verifySnapshot(eventId: string, version: number, status: 'OK' | 'MISMATCH', nowMs: number): Promise<void>;
  isSnapshotExportBlocked(eventId: string, version: number): Promise<boolean>;
  putRun(run: FraudRunRecord): Promise<void>;
  latestRun(eventId: string): Promise<FraudRunRecord | null>;
  listRuns(eventId: string): Promise<FraudRunRecord[]>;
  putClusters(eventId: string, generation: number, clusters: readonly FraudClusterRecord[], ruleVersion: string): Promise<void>;
  listClusters(q: {
    eventId: string;
    generation: number;
    sort: 'SCORE_DESC' | 'PURCHASE_RATIO_DESC' | 'LATEST';
    cursor?: string;
    limit: number;
  }): Promise<{ items: FraudClusterRecord[]; nextCursor: string | null }>;
  getCluster(clusterId: string): Promise<FraudClusterRecord | null>;
  /** ticket-svc SetTransferLock.version. 사건 판과 분리한 단조 증가 값이다(IR-20) */
  nextLockVersion(): Promise<number>;
  putCase(c: FraudCaseRecord, o?: CaseWriteOptions): Promise<CaseWriteOutcome | undefined>;
  getCase(caseId: string): Promise<FraudCaseRecord | null>;
  findCaseByCluster(clusterId: string): Promise<FraudCaseRecord | null>;
  listCases(q: {
    eventId?: string;
    status?: readonly FraudCaseStatus[];
    cursor?: string;
    limit: number;
  }): Promise<{ items: FraudCaseRecord[]; nextCursor: string | null }>;
  updateCase(c: FraudCaseRecord, expectedVersion: number, events: readonly FraudCaseRecord['events'][number][], o?: CaseWriteOptions): Promise<CaseUpdateOutcome>;
  /** 같은 계정×작업×키의 커밋된 결과를 읽는다. 멱등 재생을 잠금·알림 같은 부수 효과보다 먼저 하기 위한 입구다 */
  findIdempotent(idem: IdempotentWrite): Promise<IdempotentLookup>;
  markAppealSubmitted(caseId: string, accountId: string, nowMs: number): Promise<boolean>;
  countCases(eventId: string): Promise<{ total: number; byStatus: Record<string, number> }>;
  hasOpenCase(eventId: string): Promise<boolean>;
  openCaseEvents(): Promise<string[]>;
}

/** 사건 변경과 같은 트랜잭션에 넣는 감사 기록 */
export interface CaseAuditRecord {
  readonly recordType: string;
  readonly recordId: string;
  readonly payload: Record<string, unknown>;
  readonly nowMs: number;
}

/** platform IdempotencyRequest와 같은 모양. 도메인은 프레임워크 타입을 모른다 */
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

export interface CaseWriteOptions {
  readonly audit?: CaseAuditRecord;
  readonly idem?: IdempotentWrite;
  /** 처음 요청이 커밋할 때 함께 저장할 응답. 재생은 이 값을 그대로 돌려준다 */
  readonly result?: unknown;
}

export interface CaseWriteOutcome {
  readonly replayed: boolean;
  readonly result?: unknown;
}

export interface CaseUpdateOutcome {
  readonly ok: boolean;
  readonly replayed?: boolean;
  readonly result?: unknown;
}

/** 같은 묶음에 사건이 이미 있다. DB unique 위반과 메모리 판이 같은 이름을 쓴다 */
export class CaseAlreadyExistsError extends Error {
  readonly code = 'CASE_EXISTS';
  constructor() {
    super('이 묶음으로 만든 사건이 이미 있습니다');
    this.name = 'CaseAlreadyExistsError';
  }
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
