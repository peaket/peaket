// 운영 코드(src/)가 불러오는 바깥 패키지는 모두 운영 의존성(dependencies)에 있어야 한다. 서비스 이미지는 운영 의존성만 넣어 만든다
// (pnpm deploy --prod). 2026-11-03 원격 CI: src/redis.ts가 개발 의존성에만 있던 redis를 불러와, 예제 서비스 이미지가 시작하자마자
// 'Cannot find package redis'로 죽었다
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
}

/** import·export from·동적 import의 바깥 패키지 이름(@scope/name 또는 name). 형만 가져오는 import type은 뺀다 */
function packagesOf(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?['"]([^'"./][^'"]*)['"]|import\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;
  for (const m of text.matchAll(re)) {
    const spec = (m[1] ?? m[2])!;
    if (spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0]!)) continue;
    out.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
  }
  return [...out];
}

test('운영코드가불러오는바깥패키지는_모두운영의존성이다', () => {
  const runtime = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
  const missing: string[] = [];
  for (const f of files(join(root, 'src'))) {
    for (const p of packagesOf(readFileSync(f, 'utf8'))) if (!runtime.has(p)) missing.push(`${f.slice(root.length)}: ${p}`);
  }
  expect(missing).toEqual([]);
});
