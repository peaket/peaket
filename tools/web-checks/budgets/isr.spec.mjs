// 캐시 화면이 실제로 ISR 항목(한 번 그려 저장해 두고 다시 쓰는 화면)으로 저장되는지 본다(docs/frontend.md §5.8 '홈·공연 상세·굿즈(ISR)' 행, ADR-0200).
// 화면을 그리는 중에 시계·난수를 읽는 코드가 Suspense 밖에 있으면 Next.js가 미리 그리기를 끝내지 못해 항목을 저장하지 않고, 요청마다 뒤에서 다시 그리다가 실패한다.
// 응답은 그래도 200이고 오류는 서버 로그에만 나와서 첫 JS·Lighthouse 검사로는 보이지 않는다. 브라우저를 띄우지 않는다.
import { test, expect } from '@playwright/test';
import { APPS, HOST, portOf } from '../seed-css/apps.mjs';

const web = APPS.find((a) => a.name === 'web');
if (!web) throw new Error('앱 web이 seed-css/apps.mjs에 없다');
const origin = `http://${HOST}:${portOf(web, 'prod')}`;

for (const page of web.pages.filter((p) => p.row.includes('(ISR)'))) {
  test(`캐시 화면 ${page.path}: 다시 열면 저장해 둔 화면이 나간다(x-nextjs-cache: HIT)`, async ({ request }) => {
    // 첫 요청이 저장을 일으키고, 저장은 응답 뒤에 끝날 수 있어 잠깐 되풀이해 본다
    await expect
      .poll(async () => (await request.get(origin + page.path, { maxRedirects: 0 })).headers()['x-nextjs-cache'], {
        message: `${page.path}가 캐시에 저장되지 않는다: 서버 로그의 'Error revalidating the page in the background'를 보라`,
        timeout: 20_000,
        intervals: [500],
      })
      .toBe('HIT');
  });
}
