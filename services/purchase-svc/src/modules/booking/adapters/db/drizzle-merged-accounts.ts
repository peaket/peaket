// 계정 병합 대응표 읽기·쓰기(docs/data.md §4 경계 9·'계정 병합 사슬', asyncapi identity.accounts-merged, F-07-2 IR-02·IR-12).
// identity-svc의 사건을 받아 merged_account에 흡수 계정 PK로 한 행만 쓴다(멱등).
// 병합 사슬(A→B, B→C)은 정본대로 한 단계로 접는다: 새 대표가 이미 흡수된 계정이면 최종 대표를 따라가고,
// 기존 행의 대표도 최종 대표로 고친다. 조회도 사슬을 끝까지 따라가 방어한다. 주문·원장의 account_id는 고치지 않는다.
import type { Database, DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { MergedAccounts, MergedAccountWriter } from '../../domain/ports.js';

export interface DrizzleMergedAccountsOptions {
  database: Database;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 사슬 길이 상한(정상은 한 단계. 고리·깨진 데이터가 있어도 조회가 멈추게) */
const MAX_CHAIN = 10;

/** 질의 실행기(운영 DB의 drizzle 인스턴스 또는 트랜잭션) */
type Executor = Database['db'] | DbTransaction;

export class DrizzleMergedAccounts implements MergedAccounts, MergedAccountWriter {
  constructor(private readonly o: DrizzleMergedAccountsOptions) {}

  async record(i: { mergeId: string; primaryAccountId: string; mergedAccountId: string; confirmedAt: Date }): Promise<void> {
    if (!UUID.test(i.mergeId) || !UUID.test(i.primaryAccountId) || !UUID.test(i.mergedAccountId)) throw new RangeError('계정 병합 사건의 ID가 소문자 UUID가 아니다');
    await this.o.database.transaction(async (tx) => {
      // 새 대표가 이미 다른 계정에 흡수됐으면 최종 대표를 쓴다(B→C가 먼저 와 있던 경우)
      const final = await finalRepresentative(tx, i.primaryAccountId);
      await tx.execute(sql`
        insert into merged_account (absorbed_account_id, representative_account_id, merge_id, merged_at)
        values (${i.mergedAccountId}::uuid, ${final}::uuid, ${i.mergeId}::uuid, ${i.confirmedAt.toISOString()}::timestamptz)
        on conflict (absorbed_account_id) do update
          set representative_account_id = excluded.representative_account_id, merge_id = excluded.merge_id, merged_at = excluded.merged_at`);
      // 이번에 흡수된 계정을 대표로 가리키던 기존 행도 최종 대표로 접는다(A→B 행을 A→C로)
      await tx.execute(sql`
        update merged_account set representative_account_id = ${final}::uuid
        where representative_account_id = ${i.mergedAccountId}::uuid and absorbed_account_id <> ${i.mergedAccountId}::uuid`);
    });
  }

  async accountIdsOf(accountId: string): Promise<readonly string[]> {
    if (!UUID.test(accountId)) return [accountId];
    const representative = await finalRepresentative(this.o.database.db, accountId);
    const absorbed = await this.o.database.db.execute(sql`
      select absorbed_account_id as id from merged_account where representative_account_id = ${representative}::uuid order by absorbed_account_id`);
    return [representative, ...(absorbed.rows as unknown as { id: string }[]).map((r) => r.id)];
  }
}

/**
 * 계정이 지금 가리키는 최종 대표(사슬을 끝까지 따라간다).
 * 흡수 이력이 없으면 자기 자신이다. 깨진 데이터·고리에 대비해 깊이를 MAX_CHAIN에서 끊는다.
 */
async function finalRepresentative(exec: Executor, accountId: string): Promise<string> {
  const r = await exec.execute(sql`
    with recursive chain(id, depth) as (
      select ${accountId}::uuid, 0
      union
      select m.representative_account_id, c.depth + 1
      from merged_account m join chain c on m.absorbed_account_id = c.id
      where c.depth < ${MAX_CHAIN}
    )
    select id from chain order by depth desc limit 1`);
  return (r.rows[0] as { id: string } | undefined)?.id ?? accountId;
}
