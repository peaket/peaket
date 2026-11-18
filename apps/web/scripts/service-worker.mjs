// 월렛 서비스 워커를 빌드 때 한 번 묶어 파일로 둔다(offline-gate §2·§4, docs/frontend.md §2.3·§5.4, BAT-350·HOT-390, BAT-171 시험 이의 6).
// 전에는 app/serwist/[path]/route.ts가 요청 때 `'use cache'` 안에서 @serwist/turbopack으로 app/sw.ts를 esbuild로 묶었다. 운영 standalone 서버는
// 빌드 때 미리 그린 결과를 공유 캐시 처리기에서 찾지 못하면(처음 뜬 서버, 캐시 비움) 다시 묶으려 했고, standalone 폴더에는 원본(app/sw.ts)이 없어
// `Could not resolve …/standalone/apps/web/app/sw.ts`로 실패해 워커 등록이 거절됐다(3차 CI). 그래서:
// - next.config.ts compiler.runAfterProductionCompile에서(숨김 소스 맵 뒤, 정적 화면을 만들기 전) 워커를 묶어 <distDir>/serwist/sw.js로 쓴다.
//   미리 저장 목록(precache manifest)은 이때의 static/·public/에서 만든다. 숨김 소스 맵이 고친 뒤의 파일이라 판(revision)이 배포 파일과 맞다.
// - 워커 소스 맵은 쓰지 않고 끝의 sourceMappingURL 줄을 지운다(숨김 소스 맵과 같은 규칙, docs/frontend.md §5.18).
// - 경로 처리기는 그 파일만 읽는다(요청 때 다시 묶지 않는다). server/standalone.mjs가 <dist>/serwist를 standalone 폴더로 복사한다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 워커 산출 폴더 이름(<distDir> 아래) */
export const SW_DIR = 'serwist';
/** 내는 파일(경로 처리기 /serwist/[path]가 받는 이름) */
export const SW_FILES = ['sw.js'];

const JS_LINK = /\n?\/\/# sourceMappingURL=[^\n]*\s*$/;

/** 미리 저장에 더하는 문서 판: 배포 ID, 없으면 커밋, 둘 다 없으면 개발 값 */
export function swRevision(env = process.env) {
  return env.PEAKET_DEPLOYMENT_ID || env.GITHUB_SHA || 'wallet-dev';
}

/** @serwist/turbopack createSerwistRoute에 넘기는 값(빌드 때만 쓴다) */
export function serwistOptions(env = process.env) {
  const revision = swRevision(env);
  return {
    swSrc: 'app/sw.ts',
    useNativeEsbuild: true,
    additionalPrecacheEntries: [
      { url: '/~offline', revision },
      { url: '/my/tickets', revision },
    ],
  };
}

/** 묶은 워커 글에서 끝의 소스 맵 링크 줄을 지운다 */
export function stripSourceMapLink(text) {
  return `${text.replace(JS_LINK, '')}\n`;
}

/**
 * 워커를 묶어 <distDir>/serwist/sw.js로 쓴다. 묶기에 실패하면 던져 빌드를 멈춘다(워커 없는 배포를 내지 않는다).
 * @param {{ distDir: string }} o
 */
export async function writeServiceWorker({ distDir }) {
  const { createSerwistRoute } = await import('@serwist/turbopack');
  const route = createSerwistRoute(serwistOptions());
  const outDir = join(distDir, SW_DIR);
  mkdirSync(outDir, { recursive: true });
  for (const path of SW_FILES) {
    const res = await route.GET(new Request(`https://serwist.invalid/${path}`), { params: Promise.resolve({ path }) });
    const text = await res.text();
    if (!res.ok || text.trim() === '') throw new Error(`서비스 워커 ${path}를 묶지 못했다(상태 ${res.status})`);
    writeFileSync(join(outDir, path), stripSourceMapLink(text));
  }
  return { files: SW_FILES.length };
}
