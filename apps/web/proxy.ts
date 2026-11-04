// 소비자 웹의 요청 가로채기(Next.js 16 proxy, 화면을 그리기 전에 요청을 먼저 본다).
// 지금은 본인확인 복귀 화면의 서버 처리기 하나다(docs/features/identity.md §5 '복귀 화면의 서버 처리기', BUILD_ORDER BOT-010).
// 화면 묶음 CSP(nonce)는 BUILD_ORDER HOT-290이 여기에 더한다.
import { NextResponse, type NextRequest } from 'next/server';
import { verifyReturnProxy } from './src/features/identity-verify/server/return-post.ts';

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const d = await verifyReturnProxy(req);
  if (d.kind === 'reject') {
    return new NextResponse(d.status === 405 ? 'POST·GET만 받습니다' : '본인확인 결과 값이 틀렸습니다', {
      status: d.status,
      headers: { ...d.responseHeaders, 'content-type': 'text/plain; charset=utf-8', ...(d.status === 405 ? { allow: 'GET, HEAD, POST' } : {}) },
    });
  }
  const res = NextResponse.next({ request: { headers: d.requestHeaders } });
  for (const [k, v] of Object.entries(d.responseHeaders)) res.headers.set(k, v);
  return res;
}

export const config = { matcher: ['/verify/return'] };
