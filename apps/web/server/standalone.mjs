// Next.js standalone 산출물 준비(docs/frontend.md §5.18, ASVS 13.4.1, HOT-390).
// `next build`의 standalone 폴더에는 server.js와 최소 node_modules만 들어간다. 정적 자산과 public은
// 배포 문서대로 직접 복사해야 한다. start.mjs가 시작할 때 한 번 복사한다(운영 이미지에도 같은 일을 한다).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** standalone 앱 폴더. Next.js가 `<dist>/standalone/apps/web`에 만든다 */
export function standaloneAppDir(appDir, dist) {
  return join(appDir, dist, 'standalone', 'apps', 'web');
}

/** standalone server.js 경로 */
export function standaloneServerPath(appDir, dist) {
  return join(standaloneAppDir(appDir, dist), 'server.js');
}

/**
 * standalone 폴더에 `.next/static`과 `public`을 복사한다.
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
  const publicSrc = join(appDir, 'public');
  if (existsSync(publicSrc)) cpSync(publicSrc, join(app, 'public'), { recursive: true });
  return true;
}
