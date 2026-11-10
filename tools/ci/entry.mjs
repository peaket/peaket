// 판정 도구의 직접 실행 판별(docs/devops.md §4.4 '리뷰 뒤 더한 규칙' ⑦, ADR-0263 결정 13). 명령줄에서 바로 실행됐는지를 실제 경로(링크를 푼 것)로
// 견준다. 판별이 틀려 본문을 건너뛰면 아무것도 하지 않고 0으로 끝나 판정이 통과로 보이므로, 같은 이름의 파일인데 경로가 맞지 않으면 실패로 끝낸다.
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const canonical = (p) => {
  let r;
  try {
    r = realpathSync(p);
  } catch {
    r = resolve(p);
  }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/**
 * 이 모듈(metaUrl)이 명령줄의 첫 스크립트(argv1)인가. 다른 파일이면 거짓, 이름은 같은데 실제 경로가 다르면(판별 실패) 던진다
 * @param {string} metaUrl import.meta.url
 * @param {string | undefined} [argv1]
 */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const self = fileURLToPath(metaUrl);
  if (canonical(argv1) === canonical(self)) return true;
  if (basename(argv1).toLowerCase() === basename(self).toLowerCase()) throw new Error(`직접 실행 판별이 맞지 않는다(명령줄 ${argv1}, 모듈 ${self}). 통과로 끝내지 않는다`);
  return false;
}

/**
 * 직접 실행됐으면 fn(종료 코드를 돌려주거나 약속)을 돌려 그 코드로 끝낸다. 판별이 틀리면 종료 코드 1이다
 * @param {string} metaUrl
 * @param {() => number | Promise<number>} fn
 */
export async function runIfMain(metaUrl, fn) {
  let main;
  try {
    main = isMain(metaUrl);
  } catch (e) {
    console.log(process.env.GITHUB_ACTIONS === 'true' ? `::error::${e.message}` : `실패: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (main) process.exitCode = await fn();
}
