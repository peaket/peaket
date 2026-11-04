// 소비자 웹 CSP 검사(csp/web.spec.mjs)가 여는 서버와 빌드 산출물 위치(BUILD_ORDER HOT-290).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS, BUILDS, HOST, portOf } from '../seed-css/apps.mjs';

export const WEB = APPS.find((a) => a.name === 'web');
/** 운영 빌드 서버(seed-css/apps.mjs의 web, 4101) */
export const WEB_BASE = `http://${HOST}:${portOf(WEB, 'prod')}`;
/** 운영 빌드 산출 폴더(사전 렌더 목록·빌드 셸 HTML). 컨테이너는 lib/docker.mjs csp가 읽기 전용으로 붙인다 */
export const WEB_BUILD_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), WEB.dir, BUILDS.prod.nextDist);
