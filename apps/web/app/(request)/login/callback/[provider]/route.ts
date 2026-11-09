// 로그인·재인증 공용 콜백 GET /login/callback/{provider}(docs/features/identity.md §2·§7.1). 제공자 앱에 등록하는 돌아올 주소다.
import { socialLogin } from '@/features/social-login/server';


export async function GET(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  return socialLogin().callback(request, (await ctx.params).provider);
}
