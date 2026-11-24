// 계정 병합 대응표 읽기·쓰기(docs/data.md §4 경계 9, asyncapi identity.accounts-merged, F-07-2 IR-02).
// identity-svc의 사건을 받아 merged_account에 흡수 계정 PK로 한 행만 쓴다(멱등). 주문·원장의 account_id는 고치지 않는다.
// '내 주문' 조회는 대표 계정과 흡수 계정 ID들을 함께 본다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { MergedAccounts, MergedAccountWriter } from '../../domain/ports.js';

export interface DrizzleMergedAccountsOptions {
  database: Database;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class DrizzleMergedAccounts implements MergedAccounts, MergedAccountWriter {
  constructor(private readonly o: DrizzleMergedAccountsOptions) {}

  async record(i: { mergeId: string; primaryAccountId: string; mergedAccountId: string; confirmedAt: Date }): Promise<void> {
    if (!UUID.test(i.mergeId) || !UUID.test(i.primaryAccountId) || !UUID.test(i.mergedAccountId)) throw new RangeError('계정 병합 사건의 ID가 소문자 UUID가 아니다');
    await this.o.database.db.execute(sql`
      insert into merged_account (absorbed_account_id, representative_account_id, merge_id, merged_at)
      values (${i.mergedAccountId}::uuid, ${i.primaryAccountId}::uuid, ${i.mergeId}::uuid, ${i.confirmedAt.toISOString()}::timestamptz)
      on conflict (absorbed_account_id) do nothing`);
  }

  async accountIdsOf(accountId: string): Promise<readonly string[]> {
    if (!UUID.test(accountId)) return [accountId];
    const rep = await this.o.database.db.execute(sql`
      select coalesce(
        (select representative_account_id from merged_account where absorbed_account_id = ${accountId}::uuid),
        ${accountId}::uuid
      ) as id`);
    const representative = (rep.rows[0] as { id: string } | undefined)?.id ?? accountId;
    const absorbed = await this.o.database.db.execute(sql`
      select absorbed_account_id as id from merged_account where representative_account_id = ${representative}::uuid order by absorbed_account_id`);
    return [representative, ...(absorbed.rows as unknown as { id: string }[]).map((r) => r.id)];
  }
}
