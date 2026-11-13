// CS 처리함 건의 PostgreSQL 구현. 열린 (kind, target_ref) 하나를 부분 유일 인덱스로 지킨다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { CsCase, CsCaseKind, CsCaseStore } from '../../domain/cs-case.js';

interface Row {
  id: string;
  kind: string;
  target_ref: string;
  status: string;
  created_at: Date | string;
}

const toCase = (r: Row): CsCase => ({ caseId: r.id, kind: r.kind as CsCaseKind, targetRef: r.target_ref, status: r.status as CsCase['status'], createdAtMs: new Date(r.created_at).getTime() });

@Injectable()
export class DrizzleCsCaseStore implements CsCaseStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async open(input: { caseId: string; kind: CsCaseKind; targetRef: string; nowMs: number }): Promise<CsCase> {
    await this.database.db.execute(sql`
      insert into cs_case (id, kind, target_ref, status, created_at, updated_at)
      values (${input.caseId}::uuid, ${input.kind}, ${input.targetRef}, 'OPEN', ${new Date(input.nowMs)}::timestamptz, ${new Date(input.nowMs)}::timestamptz)
      on conflict (kind, target_ref) where status <> 'RESOLVED' do nothing`);
    const rows = (await this.database.db.execute(sql`select * from cs_case where kind = ${input.kind} and target_ref = ${input.targetRef} and status <> 'RESOLVED' order by created_at limit 1`)).rows as unknown as Row[];
    return toCase(rows[0]!);
  }
}
