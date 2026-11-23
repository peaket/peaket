// 관제 원격 위젯 화면 검사 준비(F-03-2 T18): 운영 빌드(dist/remotes.json)가 있는지 보고, 계약 패키지 판 범위만 바꾼 대체 queue 원격
// (PEAKET_REMOTE_CONTRACT_RANGE=^2.0.0, sha c0ffee000002)을 reports/console-remotes-alt/queue/에 빌드한다(호스트는 그대로 ^1.0.0을 내놓는다).
// 원격 하나만 빌드하는 공용 명령(webpack --config-name remote-<이름>, build-remote.yml과 같은 길)에 산출 폴더만 바꾼다.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ALT_DIST, DIST } from './forge.mjs';
import { repoRoot } from '../lib/canon.mjs';

export default function globalSetup() {
  if (!existsSync(path.join(DIST, 'remotes.json'))) throw new Error(`관제 운영 빌드가 없다: ${DIST}(뿌리에서 pnpm --filter @peaket/console-host build)`);
  rmSync(ALT_DIST, { recursive: true, force: true });
  const out = path.join(ALT_DIST, 'queue');
  // 인자는 이 파일이 정한 값뿐이라 명령 한 줄로 셸에 넘긴다(Windows에서 pnpm 실행 파일을 찾으려면 셸이 필요하다, seed-css/build.mjs와 같다)
  const r = spawnSync(`pnpm --filter @peaket/console-host exec webpack --mode production --config-name remote-queue --output-path "${out}"`, {
    cwd: repoRoot,
    env: { ...process.env, PEAKET_REMOTE_CONTRACT_RANGE: '^2.0.0', PEAKET_REMOTE_SHA: 'c0ffee000002' },
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: true,
  });
  if (r.status !== 0) throw new Error(`대체 원격 빌드 실패(종료 코드 ${r.status})`);
  if (!existsSync(path.join(out, 'c0ffee000002', 'remoteEntry.js'))) throw new Error(`대체 원격 산출물이 없다: ${out}`);
}
