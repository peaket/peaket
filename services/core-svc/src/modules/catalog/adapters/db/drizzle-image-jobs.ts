// F-10-2 이미지 작업 원장 저장소(계획 docs/review/plans/F-10-2.md §3·§5, docs/data.md §2 image_job).
// core_app으로 붙어 작업을 적고, 워커가 FOR UPDATE SKIP LOCKED로 집는다. 원본 키 UNIQUE가 멱등 키다.
import { randomUUID } from 'node:crypto';
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { ImageJobKind, ImageJobRecord } from '../../domain/image-job.js';

interface Row {
  id: string;
  source_key: string;
  kind: string;
  status: string;
  attempts: number;
  next_attempt_at: Date | string | null;
  lease_until: Date | string | null;
  result_status: string | null;
  width: number | null;
  height: number | null;
  derivative_keys: unknown;
  reject_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const date = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));
const map = (r: Row): ImageJobRecord => ({
  id: r.id,
  sourceKey: r.source_key,
  kind: r.kind as ImageJobKind,
  status: r.status as ImageJobRecord['status'],
  attempts: r.attempts,
  nextAttemptAt: date(r.next_attempt_at as Date | string | null),
  leaseUntil: date(r.lease_until as Date | string | null),
  resultStatus: r.result_status as ImageJobRecord['resultStatus'],
  width: r.width,
  height: r.height,
  derivativeKeys: Array.isArray(r.derivative_keys) ? (r.derivative_keys as string[]) : [],
  rejectReason: r.reject_reason,
  createdAt: date(r.created_at as Date | string)!,
  updatedAt: date(r.updated_at as Date | string)!,
});

/** 이미지 작업 표. 시험은 `enqueue({sourceKey, kind}, now)`로 작업을 만들고 `find`·`leaseDue`·`save`를 본다. */
export class DrizzleImageJobStore {
  constructor(private readonly database: Database) {}

  /** 같은 원본 키는 한 번만 적는다(멱등). */
  async enqueue(record: { sourceKey: string; kind: ImageJobKind; derivativeKeys?: string[] }, now: Date): Promise<ImageJobRecord | undefined> {
    await this.database.db.execute(sql`
      insert into image_job ("id", "source_key", "kind", "status", "attempts", "next_attempt_at", "derivative_keys", "created_at", "updated_at")
      values (${randomUUID()}::uuid, ${record.sourceKey}, ${record.kind}, 'PENDING', 0, ${now}, ${JSON.stringify(record.derivativeKeys ?? [])}::jsonb, clock_timestamp(), clock_timestamp())
      on conflict ("source_key") do nothing
    `);
    return this.find(record.sourceKey);
  }

  async find(sourceKey: string): Promise<ImageJobRecord | undefined> {
    const r = (await this.database.db.execute(sql`select * from image_job where source_key = ${sourceKey} limit 1`)) as unknown as { rows: Row[] };
    return r.rows[0] ? map(r.rows[0]) : undefined;
  }

  /** due(다음 시도 시각이 된) 작업을 lease를 걸어 집는다. 살아 있는 lease는 SKIP LOCKED가 건너뛴다. */
  async leaseDue(now: Date, limit: number, leaseMs: number): Promise<ImageJobRecord[]> {
    return this.database.transaction(async (tx) => {
      const r = (await tx.execute(sql`
        select * from image_job
        where status in ('PENDING', 'SCANNING', 'RETRYING')
          and next_attempt_at <= ${now}
          and (lease_until is null or lease_until < ${now})
        order by next_attempt_at, created_at, id
        limit ${limit}
        for update skip locked
      `)) as unknown as { rows: Row[] };
      const lease = new Date(now.getTime() + leaseMs);
      for (const row of r.rows) await tx.execute(sql`update image_job set lease_until = ${lease}, status = 'SCANNING', updated_at = ${now} where id = ${row.id}::uuid`);
      return r.rows.map((row) => map({ ...row, lease_until: lease, status: 'SCANNING' }));
    });
  }

  async save(record: ImageJobRecord): Promise<void> {
    await this.database.db.execute(sql`
      update image_job set
        "status" = ${record.status},
        "attempts" = ${record.attempts},
        "next_attempt_at" = ${record.nextAttemptAt},
        "lease_until" = ${record.leaseUntil},
        "result_status" = ${record.resultStatus},
        "width" = ${record.width},
        "height" = ${record.height},
        "derivative_keys" = ${JSON.stringify(record.derivativeKeys)}::jsonb,
        "reject_reason" = ${record.rejectReason},
        "updated_at" = ${record.updatedAt}
      where "id" = ${record.id}::uuid
    `);
  }
}
