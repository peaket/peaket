// 월렛 서비스 워커를 빌드 때 한 번 묶어 파일로 둔다(offline-gate §2·§4, docs/frontend.md §2.3·§5.4, BAT-350·HOT-390, BAT-171 시험 이의 6).
// 전에는 app/serwist/[path]/route.ts가 요청 때 `'use cache'` 안에서 @serwist/turbopack으로 app/sw.ts를 esbuild로 묶었다. 운영 standalone 서버는
// 빌드 때 미리 그린 결과를 공유 캐시 처리기에서 찾지 못하면(처음 뜬 서버, 캐시 비움) 다시 묶으려 했고, standalone 폴더에는 원본(app/sw.ts)이 없어
// `Could not resolve …/standalone/apps/web/app/sw.ts`로 실패해 워커 등록이 거절됐다(3차 CI). 그래서:
// - next.config.ts compiler.runAfterProductionCompile에서(숨김 소스 맵 뒤, 정적 화면을 만들기 전) 워커를 묶어 <distDir>/serwist/sw.js로 쓴다.
//   미리 저장 목록(precache manifest)은 이때의 static/·public/에서 만든다. 숨김 소스 맵이 고친 뒤의 파일이라 판(revision)이 배포 파일과 맞다.
// - 워커 소스 맵은 쓰지 않고 끝의 sourceMappingURL 줄을 지운다(숨김 소스 맵과 같은 규칙, docs/frontend.md §5.18).
// - 경로 처리기는 그 파일만 읽는다(요청 때 다시 묶지 않는다). server/standalone.mjs가 <dist>/serwist를 standalone 폴더로 복사한다.
// - 내는 주소(ADR-0363 결정 5·6·7): 월렛 워커 /my/tickets/sw.js(범위 /my/tickets, 실행 값 PEAKET_WALLET_SW_MODE=kill이면 킬 스위치 sw-kill.js),
//   웹 푸시 워커 /push/sw.js(push-sw.js). 옛 주소 /serwist/*는 없앴다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 워커 산출 폴더 이름(<distDir> 아래. 내는 주소와 상관없는 빌드 폴더 이름이다) */
export const SW_DIR = 'serwist';
/** Serwist로 묶는 보통 월렛 워커 파일(경로 처리기 app/my/tickets/sw.js/route.ts가 낸다, ADR-0363 결정 5) */
export const SW_FILES = ['sw.js'];
/** 월렛 킬 스위치 워커 파일(PEAKET_WALLET_SW_MODE=kill일 때 같은 주소 /my/tickets/sw.js가 낸다, ADR-0363 결정 6) */
export const SW_KILL_FILE = 'sw-kill.js';
/** 웹 푸시 전용 워커 파일(app/push/sw.js/route.ts가 /push/sw.js로 낸다, ADR-0363 결정 7) */
export const PUSH_SW_FILE = 'push-sw.js';
/** esbuild로 따로 묶는 워커(원본 → 산출 파일). Serwist 미리 저장 목록을 넣지 않는다 */
export const PLAIN_WORKERS = [
  { src: 'app/sw-kill.ts', file: SW_KILL_FILE },
  { src: 'app/push-sw.ts', file: PUSH_SW_FILE },
];
/** 월렛 워커 실행 모드 환경 값(웹 앱 서버 실행 환경, 빌드 값이 아니다) */
export const WALLET_SW_MODE_ENV = 'PEAKET_WALLET_SW_MODE';

/** 지금 실행 환경의 월렛 워커 파일: `kill`이면 킬 스위치, 그 밖(없음 포함)은 보통 워커 */
export function walletWorkerFile(env = process.env) {
  return (env[WALLET_SW_MODE_ENV] ?? '').trim().toLowerCase() === 'kill' ? SW_KILL_FILE : SW_FILES[0];
}

const JS_LINK = /\n?\/\/# sourceMappingURL=[^\n]*\s*$/;

/** 판 꼴: 공유 캐시의 빌드 칸과 같다(docs/frontend.md §5.18 '공유 캐시 처리기 세부'). 워커 쪽 같은 꼴은 src/features/wallet-device-key/sw-rules.ts */
const REVISION = /^[A-Za-z0-9_-]{1,64}$/;

/** 워커 묶음에 판을 넣는 이름(app/sw.ts의 `declare const __WALLET_CACHE_VERSION__`). 런타임 캐시 이름 `wallet-shell-{판}`에 쓴다 */
export const WALLET_CACHE_VERSION_DEFINE = '__WALLET_CACHE_VERSION__';

/**
 * 미리 저장에 더하는 문서 판이자 런타임 캐시 판: 배포 ID, 없으면 커밋, 둘 다 없으면 개발 값(빈 값은 없는 것으로 본다).
 * 꼴 밖이면 던져 워커 빌드를 멈춘다(docs/frontend.md §5.4 런타임 캐시 판, ADR-0336 결정 5)
 */
export function swRevision(env = process.env) {
  const revision = env.PEAKET_DEPLOYMENT_ID || env.GITHUB_SHA || 'wallet-dev';
  if (!REVISION.test(revision)) throw new Error(`월렛 워커 판이 꼴([A-Za-z0-9_-]{1,64}) 밖이다: ${JSON.stringify(revision)}`);
  return revision;
}

/** @serwist/turbopack createSerwistRoute에 넘기는 값(빌드 때만 쓴다). 미리 저장 판과 런타임 캐시 판은 같은 값 하나다 */
export function serwistOptions(env = process.env) {
  const revision = swRevision(env);
  return {
    swSrc: 'app/sw.ts',
    useNativeEsbuild: true,
    additionalPrecacheEntries: [
      { url: '/~offline', revision },
      { url: '/my/tickets', revision },
    ],
    esbuildOptions: { define: { [WALLET_CACHE_VERSION_DEFINE]: JSON.stringify(revision) } },
  };
}

/** 묶은 워커 글에서 끝의 소스 맵 링크 줄을 지운다 */
export function stripSourceMapLink(text) {
  return `${text.replace(JS_LINK, '')}\n`;
}

/**
 * 워커를 묶어 <distDir>/serwist/sw.js로 쓴다. 묶기에 실패하면 던져 빌드를 멈춘다(워커 없는 배포를 내지 않는다).
 * @param {{ distDir: string }} o
 */
export async function writeServiceWorker({ distDir }) {
  const { createSerwistRoute } = await import('@serwist/turbopack');
  const route = createSerwistRoute(serwistOptions());
  const outDir = join(distDir, SW_DIR);
  mkdirSync(outDir, { recursive: true });
  for (const path of SW_FILES) {
    const res = await route.GET(new Request(`https://serwist.invalid/${path}`), { params: Promise.resolve({ path }) });
    const text = await res.text();
    if (!res.ok || text.trim() === '') throw new Error(`서비스 워커 ${path}를 묶지 못했다(상태 ${res.status})`);
    writeFileSync(join(outDir, path), stripSourceMapLink(text));
  }
  // 킬 스위치·웹 푸시 워커는 미리 저장 목록 없이 esbuild로 묶는다(소스 맵 없음)
  const { build } = await import('esbuild');
  for (const w of PLAIN_WORKERS) {
    const r = await build({
      entryPoints: [w.src],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      sourcemap: false,
      write: false,
      legalComments: 'none',
    });
    const text = r.outputFiles?.[0]?.text ?? '';
    if (text.trim() === '') throw new Error(`서비스 워커 ${w.file}를 묶지 못했다`);
    writeFileSync(join(outDir, w.file), stripSourceMapLink(text));
  }
  return { files: SW_FILES.length + PLAIN_WORKERS.length };
}
