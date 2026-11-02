// 팬 재인증 시작 POST /reauth/{provider}(docs/features/identity.md §7.1, CMP-064 fan-social).
import { socialLogin } from '@/features/social-login/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  return socialLogin().reauthStart(request, (await ctx.params).provider);
}
