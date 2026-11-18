// 재배치(reflow.spec)·초점 가림(keyboard.spec)이 같은 방법으로 화면을 연다(docs/frontend.md §5.17 '빈 결과').
// - 항목의 탭 저장소 값(좌석 화면의 입장 저장값)은 페이지 스크립트보다 먼저 넣는다(BAT-170 시험 뒤 정한 것, budgets/lighthouse.spec.mjs와 같은 방법)
// - 좌석 화면은 운영 빌드 그대로, 가짜 API(apps/web/scripts/mock-api.mjs)와 시험의 응답 대역으로 좌석맵 파일·스냅샷을 받아 지도를 그린다.
//   운영 빌드는 좌석맵 파일(www 출처 정적 파일, 운영은 CDN·S3)을 내지 않고, 브라우저의 팬 API는 빌드에 넣은 운영 기본 출처라 csp/pages.mjs의
//   stubFanApi가 503으로 답한다. 그대로 두면 화면이 '좌석맵을 불러오지 못했습니다'에 머물러 지도 상자를 그리지 않는다(BAT-171 F5, 첫 CI 실행 44345964869)
// - 좌석 화면은 좌석 경로에 남고 좌석맵 예외 상자가 보여야 잰 것으로 친다. 아니면 빈 결과다
// BAT-171 시험 담당(l2-bat171-test)이 썼다(계획 §3 T7, 시험 이의 1).
import { expect } from '@playwright/test';
import { SEATMAP_VERSIONS, seatmapLayoutV } from '../../../apps/web/scripts/mock-api/seatmap.mjs';
import { APPS, HOST, MOCK_API_ORIGIN, portOf } from '../seed-css/apps.mjs';
import { FAN_API_ORIGIN } from '../csp/pages.mjs';

export const BASE = Object.fromEntries(APPS.map((a) => [a.name, `http://${HOST}:${portOf(a, 'prod')}`]));

/** 좌석 화면(좌석맵 예외 상자가 있어야 잰 것으로 친다) */
export const SEATS = /^\/booking\/[^/]+\/seats(\?|$)/;

/**
 * 좌석 화면의 응답 대역. stubFanApi(page) 뒤에 부른다(나중에 단 page.route가 먼저 걸린다).
 * - 좌석맵 파일 `/v1/events/{회차}/seatmap-layouts/{판}.json`(소비자 웹 출처): 가짜 API의 실제 배치 판(seatmapLayoutV)을 낸다. 없는 판은 404
 * - 좌석 스냅샷 `{팬 API}/v1/events/{회차}/seatmap-snapshot`: 가짜 API로 넘긴다(입장 토큰·첫 사용 임시 공개키를 가짜 API가 본다).
 *   가짜 API의 CORS는 개발 서버 출처만 열어 두므로 응답의 CORS 머리는 소비자 웹 운영 빌드 출처로 바꾼다
 * @param {import('@playwright/test').Page} page
 */
export async function routeSeatDoubles(page) {
  const web = BASE.web;
  const cors = { 'access-control-allow-origin': web, 'access-control-allow-credentials': 'true', vary: 'Origin' };
  await page.route(`${web}/v1/events/*/seatmap-layouts/*.json`, (route) => {
    const v = Number(/\/seatmap-layouts\/(\d+)\.json$/.exec(new URL(route.request().url()).pathname)?.[1]);
    if (!SEATMAP_VERSIONS.includes(v)) return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }) });
    return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, body: JSON.stringify(seatmapLayoutV(v)) });
  });
  await page.route(`${FAN_API_ORIGIN}/v1/events/*/seatmap-snapshot`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '', 'access-control-max-age': '0' },
      });
    }
    // 출처의 규약이 달라(https → http) route.fetch로 주소를 바꾸지 못한다. 시험 쪽에서 가짜 API를 불러 그 응답을 그대로 돌려준다(입장 토큰·임시 공개키 머리는 넘긴다)
    const u = new URL(req.url());
    const headers = Object.fromEntries(Object.entries(req.headers()).filter(([k]) => k.startsWith('x-') || k === 'accept'));
    const res = await fetch(`${MOCK_API_ORIGIN}${u.pathname}${u.search}`, { headers });
    const passed = Object.fromEntries(['content-type', 'cache-control', 'retry-after'].flatMap((k) => (res.headers.get(k) ? [[k, res.headers.get(k)]] : [])));
    return route.fulfill({ status: res.status, headers: { ...passed, ...cors, 'access-control-expose-headers': 'retry-after' }, body: Buffer.from(await res.arrayBuffer()) });
  });
}

/**
 * 화면을 열고 도착 경로를 돌려준다. 좌석 화면은 좌석 경로에 남고 좌석맵 예외 상자가 보이는지까지 본다(아니면 빈 결과로 실패)
 * @param {import('@playwright/test').Page} page
 * @param {{ app: string, path: string, sessionStorage?: Record<string, string> }} p
 */
export async function openReflowPage(page, p) {
  if (p.sessionStorage) {
    await page.addInitScript((entries) => {
      try {
        for (const [k, v] of Object.entries(entries)) if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v);
      } catch {
        /* about:blank에는 저장소가 없다 */
      }
    }, p.sessionStorage);
  }
  if (SEATS.test(p.path)) await routeSeatDoubles(page);
  const res = await page.goto(`${BASE[p.app]}${p.path}`, { waitUntil: 'networkidle' });
  expect(res?.status(), `${p.app}${p.path}`).toBeLessThan(400);
  const u = new URL(page.url());
  const finalPath = `${u.pathname}${u.search}`;
  if (SEATS.test(p.path)) {
    // 좌석 화면은 좌석 경로에 남고 좌석맵 예외 상자가 보여야 한다. 아니면 빈 결과다(대기실로 옮겨 가거나 지도를 그리지 않음)
    expect(finalPath, `${p.path} 도착 경로가 좌석 경로가 아니다(빈 결과)`).toBe(p.path);
    await expect(page.locator('[data-reflow-exception]').first(), `${p.path} 좌석맵 예외 상자가 보이지 않는다(빈 결과)`).toBeVisible({ timeout: 15_000 });
    // 불러오는 중에도 지도 상자는 있다. 지도를 다 그린 뒤(준비 상태에만 [목록으로 보기]가 있다)에 잰다
    await expect(page.getByRole('button', { name: '목록으로 보기' }), `${p.path} 좌석맵을 다 그리지 못했다(빈 결과)`).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: '좌석맵을 불러오지 못했습니다' }), `${p.path} 좌석맵을 불러오지 못했다(빈 결과)`).toHaveCount(0);
  }
  return finalPath;
}
