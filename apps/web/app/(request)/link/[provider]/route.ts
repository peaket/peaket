// 계정 설정의 로그인 수단 추가 시작 POST /link/{provider}(docs/features/identity.md §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041). 팬 세션과 재인증 토큰이 있어야 한다.
import { socialLogin } from '@/features/social-login/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  return socialLogin().linkStart(request, (await ctx.params).provider);
}
