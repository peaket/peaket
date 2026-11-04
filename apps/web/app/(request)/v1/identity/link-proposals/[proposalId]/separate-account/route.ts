// 연결하지 않고 새 계정 만들기 POST /v1/identity/link-proposals/{proposalId}/separate-account(docs/features/identity.md §2.1, FR-048, openapi). 연결 제안 쿠키로만 받는다.
import { socialLogin } from '@/features/social-login/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ proposalId: string }> }) {
  return socialLogin().separateAccount(request, (await ctx.params).proposalId);
}
