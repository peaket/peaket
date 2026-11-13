// 대기실 빌드 산출물을 www 배포 S3 `/_q/`에 올릴 목록으로 만든다(docs/frontend.md §2.5·§5.1, docs/devops.md §6.6).
// 셸은 배포 때 무효화해야 하므로 `no-cache`(max-age=0, must-revalidate)이고, 해시 이름 자산만 1년 immutable이다.
// 숨김 소스 맵과 개발용 preview.html은 올리지 않는다. AWS 계정이 없어 실제 업로드는 HOT-012·BAT-185 몫이다.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** S3 키 앞부분(www 배포의 `/_q/`) */
export const KEY_PREFIX = '/_q/';

/** 파일 하나의 캐시 정책. null이면 올리지 않는다 */
export function cacheControlFor(path) {
  const p = path.replaceAll(sep, '/');
  if (p === 'preview.html' || p.endsWith('.map')) return null;
  if (/^shell\.(ko|en|ja|zh)\.html$/.test(p)) return 'public, max-age=0, must-revalidate';
  if (p.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  if (p.endsWith('.html')) return 'public, max-age=0, must-revalidate';
  return 'public, max-age=300';
}

function walk(root, dir = root, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(root, abs, out);
    else out.push(relative(root, abs).replaceAll(sep, '/'));
  }
  return out;
}

/** dist 폴더의 올릴 파일 목록. `{ key, path, cacheControl }` */
export function uploadManifest(dist) {
  return walk(dist).flatMap((path) => {
    const cacheControl = cacheControlFor(path);
    return cacheControl ? [{ key: `${KEY_PREFIX}${path}`, path, cacheControl }] : [];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = process.argv[2] ?? fileURLToPath(new URL('../dist', import.meta.url));
  process.stdout.write(`${JSON.stringify({ base: KEY_PREFIX, files: uploadManifest(dist) }, null, 2)}\n`);
}
