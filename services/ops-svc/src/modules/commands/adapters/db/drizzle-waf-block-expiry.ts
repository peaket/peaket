// 읽기 전용 보기 waf_block_expiry_v(ops 0024, docs/data.md §4 6번) 읽기. 만료 차단 정리 작업의 DB 역할 waf_block_expirer는 이 보기의 SELECT만 갖는다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { BlockExpiryRow, BlockExpiryView } from '../../domain/block-expiry.js';

export class DrizzleWafBlockExpiryView implements BlockExpiryView {
  constructor(private readonly database: Database) {}

  async rows(): Promise<readonly BlockExpiryRow[]> {
    const rows = (await this.database.db.execute(sql`select command_id::text as command_id, cidr::text as cidr, expires_at, state from waf_block_expiry_v`)).rows as {
      command_id: string;
      cidr: string;
      expires_at: Date | string;
      state: string;
    }[];
    return rows.map((r) => ({ commandId: r.command_id, cidr: r.cidr, expiresAtMs: new Date(r.expires_at).getTime(), state: r.state }));
  }
}
