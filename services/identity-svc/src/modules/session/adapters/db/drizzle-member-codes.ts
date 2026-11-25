// 회원 코드 → 계정 ID 찾기(BUILD_ORDER GAT-050, ADR-0261 결정 6). 같은 DB의 account.member_code 색인을 쓴다.
// 가입을 마친 ACTIVE 계정만 답한다(정지·병합·탈퇴 계정의 코드는 빈 값이거나 답하지 않는다).
import type { Database } from '@peaket/platform';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { MemberCodeResolver } from '../../domain/member-code.js';
import { account } from './schema.js';

export class DrizzleMemberCodeResolver implements MemberCodeResolver {
  constructor(private readonly database: Database) {}

  async resolve(codes: readonly string[]): Promise<readonly { memberCode: string; accountId: string }[]> {
    if (codes.length === 0) return [];
    const rows = await this.database.db
      .select({ memberCode: account.memberCode, accountId: account.id })
      .from(account)
      .where(and(eq(account.status, 'ACTIVE'), inArray(account.memberCode, [...codes])));
    return rows.flatMap((r) => (r.memberCode === null ? [] : [{ memberCode: r.memberCode, accountId: r.accountId }]));
  }

  /** 숫자만 남긴 번호를 ACTIVE 계정의 phone과 같은 식(0040 식 인덱스)으로 정확히 맞춘다 */
  async resolvePhone(phoneDigits: string): Promise<{ accountId: string; nickname: string } | undefined> {
    const [row] = await this.database.db
      .select({ accountId: account.id, nickname: account.nickname })
      .from(account)
      .where(and(eq(account.status, 'ACTIVE'), sql`regexp_replace(${account.phone}, '[^0-9]', '', 'g') = ${phoneDigits}`))
      .limit(1);
    if (!row) return undefined;
    return { accountId: row.accountId, nickname: row.nickname ?? '' };
  }

  /** 계정 ID 여럿의 ACTIVE 닉네임만. 없는·탈퇴·병합 계정은 뺀다 */
  async resolveNicknames(accountIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(accountIds)].slice(0, 500);
    if (ids.length === 0) return new Map();
    const rows = await this.database.db
      .select({ accountId: account.id, nickname: account.nickname })
      .from(account)
      .where(and(eq(account.status, 'ACTIVE'), inArray(account.id, ids)));
    const out = new Map<string, string>();
    for (const r of rows) if (r.nickname !== null && r.nickname.trim() !== '') out.set(r.accountId, r.nickname);
    return out;
  }
}
