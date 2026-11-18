// Next.js standalone 산출물 준비(docs/frontend.md §5.18, ASVS 13.4.1, HOT-390).
// `next build`의 standalone 폴더에는 server.js와 최소 node_modules만 들어간다. 정적 자산과 public은
// 배포 문서대로 직접 복사해야 한다. start.mjs가 시작할 때 한 번 복사한다(운영 이미지에도 같은 일을 한다).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** 빌드 때 묶은 월렛 서비스 워커 폴더(<dist> 아래, scripts/service-worker.mjs의 SW_DIR와 같다. 이 파일은 노드 기본 모듈만 쓴다) */
export const SW_DIR = 'serwist';

/** standalone 앱 폴더. Next.js가 `<dist>/standalone/apps/web`에 만든다 */
export function standaloneAppDir(appDir, dist) {
  return join(appDir, dist, 'standalone', 'apps', 'web');
}

/** standalone server.js 경로 */
export function standaloneServerPath(appDir, dist) {
  return join(standaloneAppDir(appDir, dist), 'server.js');
}

/** public 아래 경로의 어느 칸이든 점으로 시작하는지(.git·.svn·.hg·.env·.DS_Store 등, ASVS 13.4.1) */
function hiddenUnder(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel.split(sep).some((part) => part.startsWith('.'));
}

/**
 * standalone 폴더에 `.next/static`·`.next/serwist`(빌드 때 묶은 월렛 서비스 워커, scripts/service-worker.mjs)와 `public`을 복사한다. public은 점으로 시작하는 파일·폴더를 빼고 복사한다
 * (소스 관리 메타데이터·환경 파일이 배포물에 들지 않게, docs/frontend.md §5.18 '앱 서버 실행', ASVS 13.4.1, BAT-170 계획 §13).
 * standalone server.js가 없으면 false(개발용 `next start` 길).
 */
export function prepareStandalone(appDir, dist) {
  const app = standaloneAppDir(appDir, dist);
  if (!existsSync(join(app, 'server.js'))) return false;
  const staticSrc = join(appDir, dist, 'static');
  if (existsSync(staticSrc)) {
    // standalone server는 빌드 때 쓴 distDir 이름(.next 또는 .next-poc) 아래에서 static을 찾는다.
    const staticDest = join(app, dist, 'static');
    mkdirSync(dirname(staticDest), { recursive: true });
    cpSync(staticSrc, staticDest, { recursive: true });
  }
  // 월렛 서비스 워커 경로(app/serwist/[path]/route.ts)는 이 파일만 읽는다. 요청 때 다시 묶지 않는다(BAT-171 시험 이의 6)
  const swSrc = join(appDir, dist, SW_DIR);
  if (existsSync(swSrc)) cpSync(swSrc, join(app, dist, SW_DIR), { recursive: true });
  const publicSrc = join(appDir, 'public');
  if (existsSync(publicSrc)) cpSync(publicSrc, join(app, 'public'), { recursive: true, filter: (src) => !hiddenUnder(publicSrc, src) });
  return true;
}
