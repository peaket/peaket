// 생성물 차이 검사: 임시 폴더에 다시 만들어 src/gen/과 견준다. 다르면 파일 이름을 적고 1로 끝난다.
// api-client 생성물은 OpenAPI 계약에서만 나오므로 proto 변경은 이 검사에 닿지 않는다(contracts gen:check가 본다).
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { GEN, generateAll } from './generate.mjs';

const PKG = join(import.meta.dirname, '..');

function files(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(p, base));
    else out.push(relative(base, p).replaceAll('\\', '/'));
  }
  return out.sort();
}

const work = mkdtempSync(join(tmpdir(), 'api-client-check-'));
try {
  cpSync(join(PKG, 'src', 'orval-fetch.ts'), join(work, 'src', 'orval-fetch.ts'));
  await generateAll(work);
  const fresh = join(work, 'src', 'gen');
  const have = new Set(files(GEN));
  const made = new Set(files(fresh));
  const lines = [
    ...[...made].filter((f) => !have.has(f)).map((f) => `빠짐(새로 만든 것에만 있음): ${f}`),
    ...[...have].filter((f) => !made.has(f)).map((f) => `남음(커밋된 것에만 있음): ${f}`),
    ...[...have]
      .filter((f) => made.has(f))
      .filter((f) => {
        const a = join(GEN, f);
        const b = join(fresh, f);
        return statSync(a).size !== statSync(b).size || readFileSync(a, 'utf8') !== readFileSync(b, 'utf8');
      })
      .map((f) => `다름: ${f}`),
  ];
  if (lines.length) {
    console.error(`생성물이 계약과 다르다(${lines.length}건). pnpm --filter @peaket/api-client gen 으로 다시 만들어 커밋한다.`);
    for (const l of lines) console.error('  ' + l);
    process.exitCode = 1;
  } else {
    console.log('생성물이 계약과 같다');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
