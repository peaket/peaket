// 가입 때 연결 제안 조회 GET /v1/identity/link-proposals/{proposalId}(docs/features/identity.md §2.1 '가입 때 연결 제안의 첫 구현', openapi). 연결 제안 쿠키로만 읽는다.
import { socialLogin } from '@/features/social-login/server';


export async function GET(request: Request, ctx: { params: Promise<{ proposalId: string }> }) {
  return socialLogin().linkProposal(request, (await ctx.params).proposalId);
}
