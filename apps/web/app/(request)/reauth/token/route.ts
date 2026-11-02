// 재인증 결과 받기 POST /reauth/token(docs/features/identity.md §7.1 ⑤, I-T72). 화면 스크립트가 같은 출처에서 한 번 부른다.
import { socialLogin } from '@/features/social-login/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return socialLogin().reauthToken(request);
}
