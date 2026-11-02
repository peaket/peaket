// 로그아웃 POST /logout(docs/features/identity.md §2·§3 '로그아웃 응답의 쿠키 지우기').
import { socialLogin } from '@/features/social-login/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return socialLogin().logout(request);
}
