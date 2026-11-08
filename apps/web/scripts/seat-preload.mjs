// 좌석 화면 자산 목록 seat-preload.json을 만든다(BUILD_ORDER HOT-352, ADR-0216 결정 3·5, docs/frontend.md §5.1).
// 대기실이 차례 전에 받아 HTTP 캐시에 둘 자산이다: 공통 런타임과 좌석 경로의 첫 화면 JS·CSS. 늦게 가져오는 묶음(좌석맵 패키지·서명기·Worker)은 매니페스트에 이름이 없어 담지 못한다.
// next.config.ts compiler.runAfterProductionCompile에서 부른다. 결과 <distDir>/seat-preload.json을 배포가 www `/_q/seat-preload.json`으로 올린다(빌드마다 바뀌므로 CDN은 다시 확인, docs/devops.md).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const SEATS_ENTRY = /\/app\/\(request\)\/booking\/\[eventId\]\/seats\/page$/;
/** 대기실 preloadAssets가 받는 꼴(apps/web/queue-room/src/live/preload.ts) */
const ASSET = /^static\/[A-Za-z0-9._~/-]+\.(?:js|css)$/;

const entryOf = (table, what) => {
  const key = Object.keys(table).find((k) => SEATS_ENTRY.test(k));
  if (!key) throw new Error(`매니페스트 ${what}에서 좌석 화면 경로를 찾지 못했다(경로가 바뀌었으면 SEATS_ENTRY를 고친다)`);
  return table[key];
};

/** 매니페스트 → { v: 1, assets }. 파일 차례는 런타임 → JS → CSS, 겹치면 한 번만 */
export function seatPreloadFrom({ rootMainFiles, entryJSFiles, entryCSSFiles }) {
  const css = entryOf(entryCSSFiles, 'entryCSSFiles').filter((f) => !f.inlined).map((f) => f.path);
  const files = [...rootMainFiles, ...entryOf(entryJSFiles, 'entryJSFiles'), ...css];
  const ok = files.filter((f) => ASSET.test(f) && !f.split('/').includes('..'));
  return { v: 1, assets: [...new Set(ok)].map((f) => `/_next/${f}`) };
}

/** 빌드 폴더의 좌석 경로 매니페스트에서 목록을 만들어 쓴다 */
export function writeSeatPreload({ distDir }) {
  const dir = join(distDir, 'server', 'app', '(request)', 'booking', '[eventId]', 'seats');
  const { rootMainFiles } = JSON.parse(readFileSync(join(dir, 'page', 'build-manifest.json'), 'utf8'));
  // 빌드 산출물(자기 빌드가 만든 파일)을 빈 샌드박스에서 읽는다. 그 파일은 전역 표에 값을 넣기만 한다
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(join(dir, 'page_client-reference-manifest.js'), 'utf8'), sandbox);
  const manifest = Object.values(sandbox.__RSC_MANIFEST ?? {})[0];
  if (!manifest) throw new Error('좌석 화면 매니페스트가 비었다');
  const list = seatPreloadFrom({ rootMainFiles, entryJSFiles: manifest.entryJSFiles, entryCSSFiles: manifest.entryCSSFiles });
  writeFileSync(join(distDir, 'seat-preload.json'), `${JSON.stringify(list)}\n`);
  return { assets: list.assets.length };
}
