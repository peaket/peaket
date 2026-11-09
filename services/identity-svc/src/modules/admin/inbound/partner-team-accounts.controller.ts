// 받는 층: 파트너 콘솔 팀 계정 목록(openapi GET /v1/partner/team-accounts, SCR-020 ⑨, docs/features/identity.md §6 '관리 계정 관리 gRPC의 첫 구현', BUILD_ORDER BOT-150).
// partner_admin만(가드). 요청 테넌트(promoter_id, ADR-0172)의 지우지 않은 계정을 마지막 접속이 늦은 순으로 준다. 계정 ID·이메일 원문은 싣지 않는다.
import { BadRequestException, Controller, ForbiddenException, Get, Res } from '@nestjs/common';
import { ContractQuery, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AdminAccountInputError, ManageAdminAccounts } from '../application/manage-admin-accounts.js';

/** 불투명 커서: base64url('o' + 위치) */
function decodeCursor(c: string): number {
  const m = /^o([1-9]\d{0,6})$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
  if (!m) throw new AdminAccountInputError('cursor가 틀렸다');
  return Number(m[1]);
}

const Query = z.object({ cursor: z.string().min(1).max(512).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();

@Controller('v1/partner/team-accounts')
export class PartnerTeamAccountsController {
  constructor(private readonly manage: ManageAdminAccounts) {}

  @Get()
  @Roles(['partner_admin'])
  async list(@ContractQuery(Query) q: z.output<typeof Query>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<object> {
    void reply.header('cache-control', 'no-store');
    // 요청 테넌트는 가드가 identity 판정(GetAdminAuthz)으로 채운다. 없으면 파트너 계정이 아니다
    if (!me.tenantId) throw new ForbiddenException();
    let page;
    try {
      // 커서는 계정 ID를 싣지 않는 불투명 값(앞에서부터 센 위치, 팀 계정은 몇십 명 [가정])이다(openapi '계정 ID는 싣지 않는다', 재검토 2026-11-05)
      page = await this.manage.list({ group: 'PARTNER', promoterId: me.tenantId, excludeRemoved: true, ...(q.cursor ? { offset: decodeCursor(q.cursor) } : {}), ...(q.limit ? { pageSize: q.limit } : {}) });
    } catch (e) {
      // 틀린 커서는 이름 없는 400(about:blank, guidelines §2)
      if (e instanceof AdminAccountInputError) throw new BadRequestException();
      throw e;
    }
    return {
      items: page.accounts.map((a) => ({
        displayName: a.displayName ?? '',
        emailMasked: a.emailMasked,
        role: a.role,
        status: a.status,
        locked: a.lockKind !== 'NONE' && (a.lockKind === 'PROTECT' || a.lockedUntil !== null),
        ...(a.lastLoginAt !== null ? { lastLoginAt: new Date(a.lastLoginAt).toISOString() } : {}),
      })),
      nextCursor: page.nextOffset === null ? null : Buffer.from(`o${page.nextOffset}`).toString('base64url'),
    };
  }
}
