// F-04-12 조사 저장소 메모리 판(시험·로컬). DB 판과 같은 인터페이스를 쓴다.
import type {
  FraudCaseRecord,
  FraudCaseStatus,
  FraudClusterRecord,
  FraudRunRecord,
  FraudSnapshotRecord,
} from '../domain/investigation.js';
import type { InvestigationStore } from '../domain/ports.js';

const clone = <T>(v: T): T => structuredClone(v);
const OPEN: readonly FraudCaseStatus[] = ['INVESTIGATING', 'APPEAL_PENDING', 'DECISION_PENDING', 'ACTIONED', 'OBJECTED'];
const scoreRank = (b: FraudClusterRecord['scoreBand']): number => (b === 'HIGH' ? 0 : b === 'MEDIUM' ? 1 : 2);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class MemoryInvestigationStore implements InvestigationStore {
  readonly snapshots = new Map<string, FraudSnapshotRecord>();
  readonly runs = new Map<string, FraudRunRecord>();
  readonly clusters = new Map<string, FraudClusterRecord>();
  readonly clustersByRun = new Map<string, string[]>();
  readonly cases = new Map<string, FraudCaseRecord>();

  #snapshotKey(eventId: string, version: number): string {
    return `${eventId}:${version}`;
  }
  #runKey(eventId: string, generation: number, attempt: number): string {
    return `${eventId}:${generation}:${attempt}`;
  }

  async putSnapshot(s: FraudSnapshotRecord): Promise<void> {
    const k = this.#snapshotKey(s.eventId, s.version);
    if (this.snapshots.has(k)) throw new Error('fraud_snapshot 중복');
    this.snapshots.set(k, clone(s));
  }
  async latestSnapshot(eventId: string): Promise<FraudSnapshotRecord | null> {
    const rows = [...this.snapshots.values()].filter((s) => s.eventId === eventId).sort((a, b) => b.version - a.version);
    return rows[0] ? clone(rows[0]) : null;
  }
  async verifySnapshot(eventId: string, version: number, status: 'OK' | 'MISMATCH', nowMs: number): Promise<void> {
    const s = this.snapshots.get(this.#snapshotKey(eventId, version));
    if (!s) throw new Error('fraud_snapshot 없음');
    s.verifyStatus = status;
    s.verifiedAtMs = nowMs;
  }
  async isSnapshotExportBlocked(eventId: string, version: number): Promise<boolean> {
    return this.snapshots.get(this.#snapshotKey(eventId, version))?.verifyStatus === 'MISMATCH';
  }
  async putRun(run: FraudRunRecord): Promise<void> {
    const k = this.#runKey(run.eventId, run.generation, run.attempt);
    if (this.runs.has(k)) throw new Error('fraud_cluster_run 중복');
    this.runs.set(k, clone(run));
  }
  async latestRun(eventId: string): Promise<FraudRunRecord | null> {
    const rows = [...this.runs.values()]
      .filter((r) => r.eventId === eventId)
      .sort((a, b) => b.generation - a.generation || b.attempt - a.attempt);
    return rows[0] ? clone(rows[0]) : null;
  }
  async listRuns(eventId: string): Promise<FraudRunRecord[]> {
    return [...this.runs.values()]
      .filter((r) => r.eventId === eventId)
      .sort((a, b) => a.generation - b.generation || a.attempt - b.attempt)
      .map(clone);
  }
  async putClusters(eventId: string, generation: number, clusters: readonly FraudClusterRecord[]): Promise<void> {
    const key = `${eventId}:${generation}`;
    if ((this.clustersByRun.get(key) ?? []).length > 0) return; // 첫 결과가 이긴다
    const ids: string[] = [];
    for (const c of clusters) {
      if (this.clusters.has(c.clusterId)) continue;
      this.clusters.set(c.clusterId, clone(c));
      ids.push(c.clusterId);
    }
    this.clustersByRun.set(key, ids);
  }
  async listClusters(q: {
    eventId: string;
    generation: number;
    sort: 'SCORE_DESC' | 'PURCHASE_RATIO_DESC' | 'LATEST';
    cursor?: string;
    limit: number;
  }): Promise<{ items: FraudClusterRecord[]; nextCursor: string | null }> {
    const rows = [...this.clusters.values()].filter((c) => c.eventId === q.eventId && c.generation === q.generation);
    rows.sort((a, b) => {
      if (q.sort === 'LATEST') return b.createdAtMs - a.createdAtMs || cmp(a.clusterId, b.clusterId);
      if (q.sort === 'PURCHASE_RATIO_DESC') {
        const ratio = b.purchaseCount / b.limitPerPerson - a.purchaseCount / a.limitPerPerson;
        if (ratio !== 0) return ratio;
      }
      return scoreRank(a.scoreBand) - scoreRank(b.scoreBand) || b.purchaseCount - a.purchaseCount || cmp(a.clusterId, b.clusterId);
    });
    const after = q.cursor ? rows.filter((c) => c.clusterId > q.cursor!) : rows;
    const page = after.slice(0, q.limit);
    return { items: page.map(clone), nextCursor: after.length > q.limit ? (page.at(-1)?.clusterId ?? null) : null };
  }
  async getCluster(clusterId: string): Promise<FraudClusterRecord | null> {
    const c = this.clusters.get(clusterId);
    return c ? clone(c) : null;
  }
  async putCase(c: FraudCaseRecord): Promise<void> {
    if ([...this.cases.values()].some((x) => x.clusterId === c.clusterId)) throw new Error('fraud_case 묶음 중복');
    if (this.cases.has(c.caseId)) throw new Error('fraud_case 중복');
    this.cases.set(c.caseId, clone(c));
  }
  async getCase(caseId: string): Promise<FraudCaseRecord | null> {
    const c = this.cases.get(caseId);
    return c ? clone(c) : null;
  }
  async findCaseByCluster(clusterId: string): Promise<FraudCaseRecord | null> {
    const c = [...this.cases.values()].find((x) => x.clusterId === clusterId);
    return c ? clone(c) : null;
  }
  async listCases(q: {
    eventId?: string;
    status?: readonly FraudCaseStatus[];
    cursor?: string;
    limit: number;
  }): Promise<{ items: FraudCaseRecord[]; nextCursor: string | null }> {
    const rows = [...this.cases.values()]
      .filter((c) => (q.eventId === undefined ? true : c.eventId === q.eventId))
      .filter((c) => (q.status === undefined || q.status.length === 0 ? true : q.status.includes(c.status)))
      .sort((a, b) => a.createdAtMs - b.createdAtMs || cmp(a.caseId, b.caseId));
    const after = q.cursor ? rows.filter((c) => c.caseId > q.cursor!) : rows;
    const page = after.slice(0, q.limit);
    return { items: page.map(clone), nextCursor: after.length > q.limit ? (page.at(-1)?.caseId ?? null) : null };
  }
  async updateCase(c: FraudCaseRecord, expectedVersion: number, events: readonly FraudCaseRecord['events'][number][]): Promise<boolean> {
    const current = this.cases.get(c.caseId);
    if (!current || current.version !== expectedVersion) return false;
    const merged: FraudCaseRecord = { ...clone(c), events: [...current.events.map((e) => ({ ...e, detail: e.detail ? { ...e.detail } : null })), ...events.map((e) => ({ ...e, detail: e.detail ? { ...e.detail } : null }))] };
    this.cases.set(c.caseId, merged);
    return true;
  }
  async markAppealSubmitted(caseId: string, accountId: string, nowMs: number): Promise<boolean> {
    const c = this.cases.get(caseId);
    const m = c?.members.find((x) => x.accountId === accountId && x.removedAtMs === null);
    if (!c || !m || m.appealResult !== 'PENDING') return false;
    m.appealResult = 'SUBMITTED';
    void nowMs;
    return true;
  }
  async countCases(eventId: string): Promise<{ total: number; byStatus: Record<string, number> }> {
    const rows = [...this.cases.values()].filter((c) => c.eventId === eventId);
    const byStatus: Record<string, number> = {};
    for (const c of rows) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    return { total: rows.length, byStatus };
  }
  async hasOpenCase(eventId: string): Promise<boolean> {
    return [...this.cases.values()].some((c) => c.eventId === eventId && c.closedAtMs === null && OPEN.includes(c.status));
  }
  async openCaseEvents(): Promise<string[]> {
    return [...new Set([...this.cases.values()].filter((c) => c.closedAtMs === null && OPEN.includes(c.status)).map((c) => c.eventId))];
  }
}
