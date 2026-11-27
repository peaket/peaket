// F-04-19 연구 내보내기 Drizzle 저장소(ops DB, 마이그레이션 0040). 바이트는 저장하지 않는다.
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, gte, lt, lte } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { ResearchExportRecord } from '../../domain/research-export.js';
import type { ResearchExportStore } from '../../domain/ports.js';
import { researchExport, researchExportDenial } from './schema.js';

const date = (n: number | null): Date | null => (n === null ? null : new Date(n));
const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());

type Row = typeof researchExport.$inferSelect;

const toRecord = (r: Row): ResearchExportRecord => ({
  exportId: r.id,
  eventId: r.eventId,
  createdBy: r.createdBy,
  createdBySessionId: r.createdBySessionId,
  createdByRole: r.createdByRole,
  fromMs: r.fromMs,
  toMs: r.toMs,
  reason: r.reason,
  allowlistVersion: r.allowlistVersion,
  keyVersion: r.keyVersion,
  status: r.status,
  createdAtMs: r.createdAt.getTime(),
  readyAtMs: ms(r.readyAt),
  expiresAtMs: r.expiresAt.getTime(),
  rowCount: r.rowCount,
  columns: r.columns as ResearchExportRecord['columns'],
  failureType: r.failureType,
  saleEndsAtMs: r.saleEndsAt,
});

export class DrizzleResearchExportStore implements ResearchExportStore {
  constructor(private readonly db: Database) {}

  async put(r: ResearchExportRecord): Promise<void> {
    await this.db.db.insert(researchExport).values({
      id: r.exportId,
      eventId: r.eventId,
      createdBy: r.createdBy,
      createdBySessionId: r.createdBySessionId,
      createdByRole: r.createdByRole,
      fromMs: r.fromMs,
      toMs: r.toMs,
      reason: r.reason,
      allowlistVersion: r.allowlistVersion,
      keyVersion: r.keyVersion,
      status: r.status,
      createdAt: new Date(r.createdAtMs),
      readyAt: date(r.readyAtMs),
      expiresAt: new Date(r.expiresAtMs),
      rowCount: r.rowCount,
      columns: [...r.columns],
      failureType: r.failureType,
      saleEndsAt: r.saleEndsAtMs,
    });
  }

  async get(exportId: string): Promise<ResearchExportRecord | null> {
    const [row] = await this.db.db.select().from(researchExport).where(eq(researchExport.id, exportId)).limit(1);
    return row ? toRecord(row) : null;
  }

  async update(r: ResearchExportRecord): Promise<void> {
    await this.db.db
      .update(researchExport)
      .set({
        status: r.status,
        readyAt: date(r.readyAtMs),
        expiresAt: new Date(r.expiresAtMs),
        rowCount: r.rowCount,
        columns: [...r.columns],
        failureType: r.failureType,
      })
      .where(eq(researchExport.id, r.exportId));
  }

  async delete(exportId: string): Promise<void> {
    await this.db.db.delete(researchExport).where(eq(researchExport.id, exportId));
  }

  async listPending(nowMs: number, limit: number): Promise<ResearchExportRecord[]> {
    const rows = await this.db.db
      .select()
      .from(researchExport)
      .where(and(eq(researchExport.status, 'PENDING'), gt(researchExport.expiresAt, new Date(nowMs))))
      .orderBy(asc(researchExport.createdAt))
      .limit(limit);
    return rows.map(toRecord);
  }

  async deleteExpired(nowMs: number): Promise<number> {
    const rows = await this.db.db
      .delete(researchExport)
      .where(lte(researchExport.expiresAt, new Date(nowMs)))
      .returning({ id: researchExport.id });
    return rows.length;
  }

  async countCreatedBetween(i: { accountId: string; fromMs: number; toMs: number }): Promise<number> {
    const rows = await this.db.db
      .select({ id: researchExport.id })
      .from(researchExport)
      .where(and(eq(researchExport.createdBy, i.accountId), gte(researchExport.createdAt, new Date(i.fromMs)), lt(researchExport.createdAt, new Date(i.toMs))));
    return rows.length;
  }

  async recordDenial(i: { accountId: string; atMs: number; problemType: string }): Promise<void> {
    await this.db.db.insert(researchExportDenial).values({
      id: randomUUID(),
      accountId: i.accountId,
      at: new Date(i.atMs),
      problemType: i.problemType,
    });
  }

  async countDeniedSince(i: { accountId: string; sinceMs: number }): Promise<number> {
    const rows = await this.db.db
      .select({ id: researchExportDenial.id })
      .from(researchExportDenial)
      .where(and(eq(researchExportDenial.accountId, i.accountId), gte(researchExportDenial.at, new Date(i.sinceMs))));
    return rows.length;
  }
}
