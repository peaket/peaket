// 시작 파일 시험이 CI 앞 단계의 dist를 그대로 쓸 때(PEAKET_START_FILES_PREBUILT=1, .github/workflows/ci-node.yml, 코드 리뷰) 그 dist가 쓸 만한지 본다.
// dist/main.js가 없거나 src 아래 어느 .ts보다 낡았으면 그 까닭을 돌려준다(지난 빌드를 돌리지 않게).
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** src 아래 .ts 파일(재귀) */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 패키지 폴더의 dist/main.js가 src보다 새로우면 null, 아니면 까닭 */
export function distProblem(dir: string): string | null {
  let built: number;
  try {
    built = statSync(join(dir, 'dist', 'main.js')).mtimeMs;
  } catch {
    return `${dir}: dist/main.js가 없다(먼저 빌드한다)`;
  }
  for (const f of sources(join(dir, 'src'))) {
    if (statSync(f).mtimeMs > built) return `${dir}: dist/main.js가 ${relative(dir, f)}보다 낡았다(다시 빌드한다)`;
  }
  return null;
}
