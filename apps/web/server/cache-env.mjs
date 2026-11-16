// 공유 캐시 환경 확인과 next.config 설정(docs/frontend.md §5.18 '공유 캐시 처리기 세부', BUILD_ORDER HOT-390).
// Redis 클라이언트를 불러오지 않는다: server/start.mjs가 맨 처음에, next.config.ts가 설정을 읽을 때 부른다. cache-store.mjs가 함께 내보낸다.
import { fileURLToPath } from 'node:url';

/** 캐시 주소 환경 값 이름 */
export const CACHE_URL_ENV = 'PEAKET_WEB_CACHE_REDIS_URL';
/** 주소 없이 뜰 수 있는 환경(닫힌 목록. 그 밖은 없음·빈 값·staging·prod·오타·대소문자 다름까지 모두 운영으로 본다) */
const NON_PROD_ENVS = new Set(['local', 'ci', 'demo']);

/** 캐시 주소. 없거나 빈칸뿐이면 undefined */
function cacheUrl(env) {
  const v = env[CACHE_URL_ENV];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** next.config.ts에 펼칠 캐시 설정. 주소가 있을 때만 두 처리기와 메모리 캐시 0, 없으면 빈 객체(Next.js 기본 처리기) */
export function cacheConfig(env = process.env) {
  if (!cacheUrl(env)) return {};
  return {
    cacheHandler: fileURLToPath(new URL('./cache-handler.mjs', import.meta.url)),
    cacheHandlers: { default: fileURLToPath(new URL('./use-cache-handler.mjs', import.meta.url)) },
    cacheMaxMemorySize: 0,
  };
}

/** PEAKET_ENV가 local·ci·demo가 아니면 주소가 없을 때 던진다(identity-svc 시작 파일과 같은 닫힌 규칙) */
export function assertCacheEnv(env = process.env) {
  if (NON_PROD_ENVS.has(env.PEAKET_ENV ?? '')) return;
  if (cacheUrl(env)) return;
  throw new Error(
    `${CACHE_URL_ENV}가 없다: PEAKET_ENV=${JSON.stringify(env.PEAKET_ENV ?? '')}는 운영으로 보므로 공유 캐시 주소가 있어야 시작한다(local·ci·demo만 주소 없이 뜬다, docs/frontend.md §5.18)`,
  );
}

// BAT-170 리뷰 R170-1·R170-2(계획 §12, docs/frontend.md §5.18 '공유 캐시 처리기 세부'): 시험 담당이 먼저 둔 빈 뼈대다(ADR-0270 결정 3).
// 동작과 환경 값 이름은 구현 담당이 쓴다.

/** start.mjs가 읽은 빌드 칸을 Next.js 프로세스에 넘기는 환경 값 이름(정본 값은 계획 §12) */
export const CACHE_BUILD_ENV = '아직 없음';

/** 산출 폴더의 required-server-files.json config가 두 처리기·메모리 캐시 0인지. 어긋나면 그 칸 이름을 실어 던진다 */
export function assertBuiltCacheConfig(distDir) {
  void distDir;
  throw new Error('아직 없음');
}

/** 빌드 칸: config.deploymentId, 없으면 BUILD_ID. [A-Za-z0-9_-] 1~64자가 아니거나 못 읽으면 던진다 */
export function readBuildTag(distDir) {
  void distDir;
  throw new Error('아직 없음');
}
