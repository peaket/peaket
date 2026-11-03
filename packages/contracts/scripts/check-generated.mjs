// 생성물 차이 검사(design.md 결정 4): 임시 폴더에 다시 만들어 src/gen/과 견준다. 다르면 파일 이름을 적고 1로 끝난다.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEN, generateAll } from './generate.mjs';
import { diffTrees } from './tree-diff.mjs';

const fresh = mkdtempSync(join(tmpdir(), 'contracts-gen-'));
try {
  await generateAll(fresh);
  const d = diffTrees(GEN, fresh);
  const lines = [
    ...d.missing.map((f) => `빠짐(새로 만든 것에만 있음): ${f}`),
    ...d.extra.map((f) => `남음(커밋된 것에만 있음): ${f}`),
    ...d.changed.map((f) => `다름: ${f}`),
  ];
  if (lines.length) {
    console.error(`생성물이 계약과 다르다(${lines.length}건). pnpm --filter @peaket/contracts gen 으로 다시 만들어 커밋한다.`);
    for (const l of lines) console.error('  ' + l);
    process.exitCode = 1;
  } else {
    console.log('생성물이 계약과 같다');
  }
} finally {
  rmSync(fresh, { recursive: true, force: true });
}
