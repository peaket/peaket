// 소비자 웹 CSP 검사(csp/web.spec.mjs)가 여는 서버와 빌드 산출물 위치(BUILD_ORDER HOT-290).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS, BUILDS, HOST, portOf } from '../seed-css/apps.mjs';

export const WEB = APPS.find((a) => a.name === 'web');
/** 운영 빌드 서버(seed-css/apps.mjs의 web, 4101) */
export const WEB_BASE = `http://${HOST}:${portOf(WEB, 'prod')}`;
/** 운영 빌드 산출 폴더(사전 렌더 목록·빌드 셸 HTML). 컨테이너는 lib/docker.mjs csp가 읽기 전용으로 붙인다 */
/** 운영 빌드의 팬 API 출처(apps/web/src/shared/config/origins.ts의 기본값. 검사 빌드는 NEXT_PUBLIC_API_ORIGIN을 주지 않는다) */
export const FAN_API_ORIGIN = 'https://api.peaket.example';

/**
 * 화면 스크립트가 부르는 팬 API(계정 요약·토큰 갱신·찜·알림)에 일시 장애(503)로 답한다. HOT-321부터 모든 화면이 계정 요약을 부르는데,
 * 없는 주소로 나간 요청의 실패를 엔진마다 다르게 보고해서다(Firefox BiDi는 페이지 오류로 올린다).
 * 닿지 않는 API와 같은 길(로그인 상태 모름)을 그린다. 비로그인(401)으로 답하면 개인 화면(/my/…)이 로그인 화면으로 보내 검사가 바뀐다
 * @param {import('@playwright/test').Page} page
 */
export async function stubFanApi(page) {
  const cors = { 'access-control-allow-origin': new URL(WEB_BASE).origin, 'access-control-allow-credentials': 'true', vary: 'Origin' };
  await page.route(`${FAN_API_ORIGIN}/**`, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST, PUT, DELETE', 'access-control-allow-headers': 'accept, content-type' } })
      : route.fulfill({
          status: 503,
          headers: { ...cors, 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
          body: JSON.stringify({ type: 'about:blank', title: 'Service Unavailable', status: 503 }),
        }),
  );
}
export const WEB_BUILD_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), WEB.dir, BUILDS.prod.nextDist);
