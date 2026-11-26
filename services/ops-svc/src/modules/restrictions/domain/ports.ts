// 예매 제한 저장소·사본 포트(F-06-4). 시험은 앱 키트로, 시작 조립은 grpc-restriction-copies로 채운다.
import type { AuditRecord } from '../../audit/audit.js';
import type { RestrictionCopyInput, RestrictionRow } from './booking-restriction.js';

export interface BookingRestrictionStore {
  rows(): Promise<RestrictionRow[]>;
  find(restrictionId: string): Promise<RestrictionRow | undefined>;
  findByApproval(approvalId: string): Promise<RestrictionRow | undefined>;
  insert(row: RestrictionRow, audit?: AuditRecord): Promise<void>;
  update(row: RestrictionRow, audit?: AuditRecord): Promise<void>;
  /** 시험·합성에서 F-04-13이 만든 행을 그대로 넣는다 */
  seed(row: RestrictionRow): Promise<void>;
}

export interface RestrictionCopies {
  queue(i: RestrictionCopyInput): Promise<{ changed: boolean }>;
  purchase(i: RestrictionCopyInput): Promise<{ changed: boolean }>;
  /** 화면용 사본. 실패해도 승인 Done을 막지 않는다 */
  view(i: RestrictionCopyInput & { reasonCode: string; startsAtMs: number; appealDueAtMs: number }): Promise<{ changed: boolean }>;
}

export interface RestrictionClock {
  now(): number;
}

/** CS 소명 연결이 쓰는 제한 엔진 참조. RestrictionsModule이 시작 조립에서 채운다. */
export interface RestrictionEngine {
  find(restrictionId: string): Promise<RestrictionRow | undefined>;
  lift(restrictionId: string): Promise<RestrictionRow>;
}

export interface RestrictionEngineRef {
  current?: RestrictionEngine;
}

export interface AppealSourceRecord {
  readonly appealId: string;
  readonly accountId: string;
  readonly kind: 'RESTRICTION' | 'FRAUD_CASE';
  readonly targetId: string;
  readonly body: string;
  readonly submittedAtMs: number;
}

export interface AppealSource {
  read(appealId: string): Promise<AppealSourceRecord | undefined>;
  result(appealId: string, r: { status: 'DECIDED' | 'INVALID'; result?: string; resultNote?: string; reason?: string }): Promise<void>;
}

export interface FraudCaseDirectory {
  investigatorOf(caseId: string): Promise<{ assigneeId: string } | undefined>;
}

export interface AppealNotifier {
  send(i: { appealId: string; accountId: string; event: 'INVALID' | 'DECIDED'; result?: string }): Promise<void>;
}

export interface AppealHolds {
  set(i: { accountId: string; caseId: string; kind: 'APPEAL'; state: 'OPEN' | 'CLOSED'; version: number }): Promise<{ changed: boolean }>;
}

/** ops 시작 조립·시험이 CS 소명과 제한 엔진에 넘기는 포트 묶음 */
export interface OpsRestrictionsWiring {
  readonly store: BookingRestrictionStore;
  readonly engineRef: RestrictionEngineRef;
  readonly copies?: RestrictionCopies;
  readonly appeals?: AppealSource;
  readonly fraudCases?: FraudCaseDirectory;
  readonly notifier?: AppealNotifier;
  readonly holds?: AppealHolds;
}
