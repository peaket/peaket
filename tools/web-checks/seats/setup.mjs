// 5만 석 화면 시험의 준비(S-T21·S-T31 ⑥, BAT-182). Playwright globalSetup이 부른다.
// 1) seats/gen/에 5만 석 좌석맵 파일과 전체 스냅샷을 쓴다.
// 2) seats/page의 시험 페이지를 Vite로 묶어 seats/dist에 둔다(@peaket/seatmap의 Worker·엔진·연결 부품을 그대로 쓴다).
// 서버(seats/server.mjs)도 dist가 없으면 같은 준비를 부른다(직접 띄울 때).
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../lib/canon.mjs';
import { writeLayoutFiles } from './layout.mjs';

const GEN = new URL('./gen/', import.meta.url);
const DIST = new URL('./dist/', import.meta.url);

/** 시험 페이지를 묶는다. vite는 @peaket/seatmap의 개발 의존성이라 그 패키지로 실행한다(새 의존 없음) */
export function buildPage() {
  const config = fileURLToPath(new URL('./vite.config.mjs', import.meta.url));
  const args = ['--filter', '@peaket/seatmap', 'exec', 'vite', 'build', '--config', config];
  const r = spawnSync(['pnpm', ...args].join(' '), { cwd: repoRoot, stdio: 'inherit', shell: true, env: { ...process.env } });
  if (r.status !== 0) throw new Error(`좌석 화면 시험 페이지 빌드 실패(종료 코드 ${r.status})`);
}

export function prepare({ force = false } = {}) {
  mkdirSync(GEN, { recursive: true });
  const layout = writeLayoutFiles(GEN);
  if (force || !existsSync(new URL('index.html', DIST))) buildPage();
  return layout;
}

export default function setup() {
  const layout = prepare();
  console.log(`seats 준비: ${layout.seatCount.toLocaleString('en-US')}석 · ${layout.sections.length}구역`);
}
