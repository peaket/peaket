// 연구 내보내기 메모리 저장소(시험·로컬). 감사·이용 내역은 별도 포트가 맡는다.
import type { ResearchExportRecord } from '../domain/research-export.js';
import type { ResearchExportStore } from '../domain/ports.js';

export class MemoryResearchExportStore implements ResearchExportStore {
  readonly records = new Map<string, ResearchExportRecord>();
  readonly denials: Array<{ accountId: string; atMs: number; problemType: string }> = [];

  async put(r: ResearchExportRecord): Promise<void> {
    this.records.set(r.exportId, { ...r });
  }
  async get(exportId: string): Promise<ResearchExportRecord | null> {
    const r = this.records.get(exportId);
    return r ? { ...r } : null;
  }
  async update(r: ResearchExportRecord): Promise<void> {
    this.records.set(r.exportId, { ...r });
  }
  async delete(exportId: string): Promise<void> {
    this.records.delete(exportId);
  }
  async listPending(nowMs: number, limit: number): Promise<ResearchExportRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === 'PENDING' && r.expiresAtMs > nowMs)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async deleteExpired(nowMs: number): Promise<number> {
    let deleted = 0;
    for (const [id, r] of this.records) {
      if (r.expiresAtMs <= nowMs) {
        this.records.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
  async countCreatedBetween(i: { accountId: string; fromMs: number; toMs: number }): Promise<number> {
    return [...this.records.values()].filter(
      (r) => r.createdBy === i.accountId && r.createdAtMs >= i.fromMs && r.createdAtMs < i.toMs,
    ).length;
  }
  async recordDenial(i: { accountId: string; atMs: number; problemType: string }): Promise<void> {
    this.denials.push({ ...i });
  }
  async countDeniedSince(i: { accountId: string; sinceMs: number }): Promise<number> {
    return this.denials.filter((d) => d.accountId === i.accountId && d.atMs >= i.sinceMs).length;
  }
}
