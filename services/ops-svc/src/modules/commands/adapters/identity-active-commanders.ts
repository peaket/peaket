// 활성 commander 목록(사후 검토의 1인 기간 판정, ADR-0349 결정 7, ADR-0062). identity AdminAccountService.ListAdminAccounts를
// 관제 무리(OPS)·활성(ACTIVE)으로 끝까지 넘겨 읽고 역할이 commander인 계정 ID만 돌려준다. 어느 쪽이든 실패하면 던진다(1인 기간으로 보지 않는다).
import type { AdminIdentity } from '../../admin-accounts/index.js';
import { ActiveCommandersUnavailable, type ActiveCommanders } from '../domain/ports.js';

/** 한 번에 읽는 쪽 크기와 쪽 수 상한(관제 계정은 수십 명 [가정]) */
const PAGE = 100;
const MAX_PAGES = 20;

export class IdentityActiveCommanders implements ActiveCommanders {
  constructor(private readonly identity: Pick<AdminIdentity, 'list'>) {}

  async list(): Promise<readonly string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const r = await this.identity.list({ group: 'OPS', status: 'ACTIVE', limit: PAGE, ...(cursor !== undefined ? { cursor } : {}) });
        for (const a of r.items) if (a.role === 'commander' && a.status === 'ACTIVE') out.push(a.adminAccountId);
        if (!r.nextCursor) return out;
        cursor = r.nextCursor;
      }
    } catch (e) {
      throw new ActiveCommandersUnavailable(e instanceof Error ? e.name : 'error');
    }
    // 쪽이 끝나지 않으면 목록을 다 읽지 못한 것이다(1인 기간으로 보지 않는다)
    throw new ActiveCommandersUnavailable('too-many-pages');
  }
}
