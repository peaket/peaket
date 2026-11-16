// 공유 캐시 환경 확인과 next.config 설정(docs/frontend.md §5.18 '공유 캐시 처리기 세부', BUILD_ORDER HOT-390).
// Redis 클라이언트를 불러오지 않는다: server/start.mjs가 맨 처음에, next.config.ts가 설정을 읽을 때 부른다. cache-store.mjs가 함께 내보낸다.
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
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

/** 미리 그린 화면 처리기·'use cache' 처리기 파일(절대 경로) */
const ISR_HANDLER = fileURLToPath(new URL('./cache-handler.mjs', import.meta.url));
const USE_CACHE_HANDLER = fileURLToPath(new URL('./use-cache-handler.mjs', import.meta.url));

/**
 * next.config.ts에 펼칠 캐시 설정. 환경 값과 관계없이 늘 두 처리기와 메모리 캐시 0을 건다(BAT-170 리뷰 R170-1).
 * standalone server.js는 빌드 때의 설정을 품고 실행 때 next.config를 읽지 않으므로, 걸지 말지를 빌드 때 환경으로 정하면
 * 주소 없이 빌드한 이미지를 운영 주소와 함께 띄웠을 때 처리기가 조용히 빠진다. 저장소(Redis·메모리)는 처리기가 실행 때 고른다
 */
export function cacheConfig(env = process.env) {
  void env;
  return { cacheHandler: ISR_HANDLER, cacheHandlers: { default: USE_CACHE_HANDLER }, cacheMaxMemorySize: 0 };
}

/** PEAKET_ENV가 local·ci·demo가 아니면 주소가 없을 때 던진다(identity-svc 시작 파일과 같은 닫힌 규칙) */
export function assertCacheEnv(env = process.env) {
  if (NON_PROD_ENVS.has(env.PEAKET_ENV ?? '')) return;
  if (cacheUrl(env)) return;
  throw new Error(
    `${CACHE_URL_ENV}가 없다: PEAKET_ENV=${JSON.stringify(env.PEAKET_ENV ?? '')}는 운영으로 보므로 공유 캐시 주소가 있어야 시작한다(local·ci·demo만 주소 없이 뜬다, docs/frontend.md §5.18)`,
  );
}

/** start.mjs가 읽은 빌드 칸을 Next.js 프로세스(두 처리기)에 넘기는 환경 값 이름(docs/frontend.md §5.18, BAT-170 리뷰 R170-2) */
export const CACHE_BUILD_ENV = 'PEAKET_WEB_CACHE_BUILD';
/** 빌드 칸 꼴: [A-Za-z0-9_-] 1~64자 */
export const BUILD_TAG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 빌드 칸 꼴을 확인한다. 꼴 밖이면 던진다 */
export function assertBuildTag(tag, where = '빌드 칸') {
  if (typeof tag !== 'string' || !BUILD_TAG_PATTERN.test(tag)) throw new Error(`${where}이 [A-Za-z0-9_-] 1~64자가 아니다: ${JSON.stringify(tag)}`);
  return tag;
}

/** 산출 폴더의 required-server-files.json config */
function builtConfig(distDir) {
  const file = resolve(distDir, 'required-server-files.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`산출 폴더의 required-server-files.json을 읽지 못했다(${file}): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed.config !== 'object' || parsed.config === null) throw new Error(`required-server-files.json에 config가 없다(${file})`);
  return parsed.config;
}

/** 빌드 설정의 처리기 경로(Next.js는 산출 폴더 기준 상대 경로로 쓴다)가 그 파일인지. 경로 구분자·대소문자(Windows)는 가려 본다 */
function samePath(distDir, value, expected) {
  if (typeof value !== 'string' || value === '') return false;
  const got = isAbsolute(value) ? value : resolve(distDir, value);
  return relative(resolve(got), resolve(expected)) === '';
}

/**
 * 산출 폴더의 빌드 설정이 두 처리기와 메모리 캐시 0인지(BAT-170 리뷰 R170-1, docs/frontend.md §5.18). 어긋나면 그 칸 이름을 실어 던진다.
 * 두 처리기 파일은 산출 폴더와 같은 앱의 server/ 아래 것이어야 한다(standalone도 같은 꼴로 추적해 싣는다)
 */
export function assertBuiltCacheConfig(distDir) {
  const config = builtConfig(distDir);
  const bad = [];
  if (!samePath(distDir, config.cacheHandler, ISR_HANDLER)) bad.push(`cacheHandler(${JSON.stringify(config.cacheHandler ?? null)})`);
  if (!samePath(distDir, config.cacheHandlers?.default, USE_CACHE_HANDLER)) bad.push(`cacheHandlers.default(${JSON.stringify(config.cacheHandlers?.default ?? null)})`);
  if (config.cacheMaxMemorySize !== 0) bad.push(`cacheMaxMemorySize(${JSON.stringify(config.cacheMaxMemorySize ?? null)}, 0이어야 한다)`);
  if (bad.length > 0) throw new Error(`빌드 설정의 공유 캐시 처리기가 어긋나 시작하지 않는다: ${bad.join(', ')}. next.config.ts의 cacheConfig()로 다시 빌드한다(docs/frontend.md §5.18)`);
}

/** 빌드 칸: 산출물의 config.deploymentId, 없으면 BUILD_ID 파일의 내용. 꼴 밖이거나 못 읽으면 던진다 */
export function readBuildTag(distDir) {
  const { deploymentId } = builtConfig(distDir);
  if (deploymentId !== undefined && deploymentId !== null && deploymentId !== '') return assertBuildTag(deploymentId, '빌드 칸(deploymentId)');
  let id;
  try {
    id = readFileSync(resolve(distDir, 'BUILD_ID'), 'utf8').trim();
  } catch (e) {
    throw new Error(`빌드 칸을 읽지 못했다: deploymentId가 없고 BUILD_ID도 없다(${e instanceof Error ? e.message : String(e)})`);
  }
  return assertBuildTag(id, '빌드 칸(BUILD_ID)');
}
