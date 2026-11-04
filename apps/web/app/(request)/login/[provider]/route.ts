// 로그인 시작 POST /login/{provider}(SCR-004, docs/features/identity.md §2 '웹 앱 서버 경로'). 처리기는 features/social-login/server다.
import { socialLogin } from '@/features/social-login/server';


export async function POST(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  return socialLogin().start(request, (await ctx.params).provider);
}
