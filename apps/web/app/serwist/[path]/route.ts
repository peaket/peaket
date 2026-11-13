// Serwist 서비스 워커 빌드 경로(offline-gate §2·§4, docs/frontend.md §2.3, BAT-350).
// @serwist/turbopack은 Route Handler에서 esbuild로 `app/sw.ts`를 묶어 `/serwist/sw.js`로 낸다.
// cacheComponents가 켜져 있으면 createSerwistRoute의 dynamic·revalidate 내보내기가 사라지므로,
// 빌드를 `use cache`로 감싸 빌드 때 한 번만 돌리고 정적 경로로 낸다(Serwist Turbopack 문서의 Cache Components 대응).
import { createSerwistRoute } from '@serwist/turbopack';
import { cacheLife } from 'next/cache';

const revision = process.env.PEAKET_DEPLOYMENT_ID || process.env.GITHUB_SHA || 'wallet-dev';

const serwistRoute = createSerwistRoute({
  swSrc: 'app/sw.ts',
  useNativeEsbuild: true,
  additionalPrecacheEntries: [
    { url: '/~offline', revision },
    { url: '/my/tickets', revision },
  ],
});

export const generateStaticParams = serwistRoute.generateStaticParams;

async function buildSerwistFile(path: string) {
  'use cache';
  cacheLife('max');
  const response = await serwistRoute.GET(new Request(`https://serwist.invalid/${path}`), { params: Promise.resolve({ path }) });
  return {
    body: await response.text(),
    contentType: response.headers.get('Content-Type') ?? 'text/javascript; charset=utf-8',
  };
}

export async function GET(_request: Request, context: { params: Promise<{ path: string }> }) {
  const { path } = await context.params;
  const { body, contentType } = await buildSerwistFile(path);
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Service-Worker-Allowed': '/my/tickets',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
}
