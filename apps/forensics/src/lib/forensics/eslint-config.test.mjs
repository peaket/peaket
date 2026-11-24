// F-04-9 생성기 린트 합침 시험(구현 리뷰 IR-01, FE-T21, ADR-0196·ADR-0199).
// `FORENSICS_GENERATOR_RULES`가 같은 이름 `no-restricted-syntax`로 앞 설정을 덮어도
// 목업 동적 import 금지와 시계·난수 금지가 다섯 파일에서 함께 살아 있는지 실제 `eslint --print-config`로 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const ESLINT_JS = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
const FILES = ['prng.ts', 'cdf.ts', 'scenario.ts', 'checkpoint.ts', 'math.ts'];

function printConfig(file) {
  const output = execFileSync(process.execPath, [ESLINT_JS, '--print-config', join(ROOT, 'apps/forensics/src/lib/forensics', file)], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(output);
}

test('FX-T1 ④ 생성기 다섯 파일에 목업 동적 import 금지와 시계 금지가 함께 적용된다', () => {
  for (const file of FILES) {
    const config = printConfig(file);
    const syntax = config.rules?.['no-restricted-syntax'];
    assert.ok(Array.isArray(syntax), `${file}: no-restricted-syntax 규칙이 없다`);
    const text = JSON.stringify(syntax);
    assert.match(text, /ImportExpression/, `${file}: 목업 동적 import 금지가 사라졌다`);
    assert.match(text, /Date/, `${file}: Date 금지가 사라졌다`);

    const imports = config.rules?.['no-restricted-imports'];
    assert.ok(Array.isArray(imports), `${file}: no-restricted-imports 규칙이 없다`);
    assert.match(JSON.stringify(imports), /msw/, `${file}: 정적 목업 import 금지가 사라졌다`);
  }
});
