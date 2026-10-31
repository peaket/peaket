// 생성물 차이 검사: 커밋된 생성물 폴더와 새로 만든 폴더의 파일 목록과 내용을 견준다(design.md 결정 4).
// 줄바꿈은 LF로 맞춰 견준다(저장소는 LF, .gitattributes). 경로는 '/'로 잇고 이름순으로 돌려준다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function listFiles(root, prefix = '') {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

const read = (root, rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');

/**
 * @param {string} committedDir 커밋된 생성물 폴더(없어도 된다)
 * @param {string} freshDir 계약에서 방금 만든 폴더
 * @returns {{ missing: string[], extra: string[], changed: string[] }} missing: 새로 만든 것에만 있음, extra: 커밋된 것에만 있음, changed: 내용이 다름
 */
export function diffTrees(committedDir, freshDir) {
  const committed = new Set(listFiles(committedDir));
  const fresh = new Set(listFiles(freshDir));
  const sort = (a) => a.sort();
  return {
    missing: sort([...fresh].filter((f) => !committed.has(f))),
    extra: sort([...committed].filter((f) => !fresh.has(f))),
    changed: sort([...fresh].filter((f) => committed.has(f) && read(committedDir, f) !== read(freshDir, f))),
  };
}
