// payment-svc 마이그레이션 SQL 만들기(drizzle-kit generate)를 drizzle 생성 전용 tsconfig로 띄운다(core-svc·purchase-svc와 같은 방법, BUILD_ORDER PRF-180).
// - drizzle-kit의 TS 로더(tsx)는 기본으로 이 서비스의 tsconfig.json을 읽고, 그 paths로 @peaket/platform을 원본(TS)에 잇는다.
// - tsconfig.drizzle.json은 paths를 비워 @peaket/platform을 빌드된 패키지(dist)로 읽게 한다. 그 경로를 TSX_TSCONFIG_PATH로 넘긴다.
// - 윈도우·리눅스 모두 셸 문법(VAR=값 명령) 없이 되게 node로 띄운다. 받은 인자는 drizzle-kit generate에 그대로 넘긴다.
// 쓰는 법: pnpm --filter @peaket/payment-svc db:generate [--name <이름>]
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const service = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

try {
  require.resolve('@peaket/platform');
} catch {
  console.error('@peaket/platform의 빌드 결과(dist)가 없다. 먼저 pnpm --filter @peaket/platform build를 돌린다');
  process.exit(2);
}

// drizzle-kit은 package.json을 내보내지 않아 본체 파일 옆의 실행 파일(bin.cjs)을 찾는다
const bin = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs');
const r = spawnSync(process.execPath, [bin, 'generate', ...process.argv.slice(2)], {
  cwd: service,
  stdio: 'inherit',
  env: { ...process.env, TSX_TSCONFIG_PATH: join(service, 'tsconfig.drizzle.json') },
});
if (r.error) {
  console.error(`drizzle-kit을 띄우지 못했다: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
