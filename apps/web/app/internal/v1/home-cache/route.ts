/* eslint-disable peaket-web-boundaries/route-reexport-only -- ADR-0329 결정 5 예외: frozen 시험(home-cache.test.mjs)이 revalidateTag·내부 토큰 결합을 경로 파일의 POST 직접 수출로 검증한다 */
import { revalidateTag } from 'next/cache';
import { createHomeCacheHandler } from '@/_pages/home/api/home-cache';

export const POST = createHomeCacheHandler({
  revalidate: revalidateTag,
  token: process.env.PEAKET_INTERNAL_TOKEN,
});
