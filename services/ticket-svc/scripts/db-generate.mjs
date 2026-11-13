// ticket-svc 마이그레이션 SQL 만들기(drizzle-kit generate)를 drizzle 설정용 tsconfig로 실행한다.
// 사용: pnpm --filter @peaket/ticket-svc db:generate [--name <이름>]
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const service = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
try {
  require.resolve('@peaket/platform');
} catch {
  console.error('@peaket/platform의 빌드 결과(dist)가 없다. 먼저 pnpm --filter @peaket/platform build를 실행한다');
  process.exit(2);
}
const bin = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs');
const r = spawnSync(process.execPath, [bin, 'generate', ...process.argv.slice(2)], {
  cwd: service,
  stdio: 'inherit',
  env: { ...process.env, TSX_TSCONFIG_PATH: join(service, 'tsconfig.drizzle.json') },
});
if (r.error) {
  console.error(`drizzle-kit을 부르지 못했다: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
