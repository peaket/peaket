// 회원 코드 → 계정 ID 찾기(BUILD_ORDER GAT-050, ADR-0261 결정 6). 같은 DB의 account.member_code 색인을 쓴다.
// 가입을 마친 ACTIVE 계정만 답한다(정지·병합·탈퇴 계정의 코드는 빈 값이거나 답하지 않는다).
import type { Database } from '@peaket/platform';
import { and, eq, inArray } from 'drizzle-orm';
import type { MemberCodeResolver } from '../../inbound/member-code.grpc.js';
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
}
