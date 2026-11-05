// 대기실 검사 빌드(ADR-0217 결정 1): 운영 빌드와 같은 설정에 대기열·대기열 파일·팬 API 출처만 검사용 가짜 API로 바꿔
// apps/web/queue-room/dist-check/에 낸다. 같은 출처 검사 틀(lib/same-origin.mjs)이 이 폴더를 낸다. 실행: node queue-room/build.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHECK_MOCK_ORIGIN } from './origins.mjs';

const cwd = fileURLToPath(new URL('../../../apps/web/queue-room/', import.meta.url));
const env = { ...process.env, VITE_PEAKET_QUEUE_ORIGIN: CHECK_MOCK_ORIGIN, VITE_PEAKET_QUEUE_FILES_ORIGIN: CHECK_MOCK_ORIGIN, VITE_PEAKET_API_ORIGIN: CHECK_MOCK_ORIGIN };
const r = spawnSync('pnpm exec vite build --outDir dist-check --emptyOutDir', { cwd, env, stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
