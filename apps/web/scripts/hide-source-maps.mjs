// 브라우저 소스 맵을 링크 없이 숨긴다(docs/frontend.md §5.18 '숨김 소스 맵', BUILD_ORDER HOT-291).
// Turbopack에는 숨김 맵 설정이 없어 productionBrowserSourceMaps를 켜면 JS·CSS 끝에 sourceMappingURL 링크가 붙는다. 소비자 웹은 SRI를
// 켜(외부 스크립트 integrity, ADR-0193 결정 6) 빌드 뒤 링크를 지우면 integrity가 틀어진다. 그래서 Next.js의 컴파일 직후 훅
// (next.config.ts compiler.runAfterProductionCompile, 정적 화면을 만들기 전)에서:
//   ① static/의 JS·CSS 끝 링크 줄을 지우고 ② 지운 파일의 새 SHA-256으로 server/의 SRI 표(전체·화면별 .json·.js)의 옛 값을 바꾸며
//   ③ .map 파일을 static/ 밖(<distDir>/browser-source-maps/, 배포·올리기 대상 아님)으로 옮긴다.
// 뒤이어 만드는 정적 화면 HTML과 요청 때 그리는 화면은 고친 표에서 integrity를 읽는다. 맵을 오류 도구에 올리는 일은 그 도구를 붙이는 단계에서 한다.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const JS_LINK = /\n\/\/# sourceMappingURL=[^\n]*\s*$/;
const CSS_LINK = /\n\/\*# sourceMappingURL=[^*]*\*\/\s*$/;
const sri = (buf) => `sha256-${createHash('sha256').update(buf).digest('base64')}`;

function* walk(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/**
 * @param {{ distDir: string }} o distDir: Next.js 산출 폴더(절대 경로)
 * @returns {{ stripped: number, maps: number, manifests: number }}
 */
export function hideSourceMaps({ distDir }) {
  const staticDir = join(distDir, 'static');
  const mapsDir = join(distDir, 'browser-source-maps');
  /** 옛 integrity → 새 integrity */
  const swap = new Map();
  let stripped = 0;
  let maps = 0;
  for (const file of walk(staticDir)) {
    if (file.endsWith('.map')) {
      const to = join(mapsDir, relative(staticDir, file));
      mkdirSync(dirname(to), { recursive: true });
      renameSync(file, to);
      maps++;
      continue;
    }
    const isJs = /\.m?js$/.test(file);
    if (!isJs && !file.endsWith('.css')) continue;
    const before = readFileSync(file);
    const text = before.toString('utf8');
    const after = text.replace(isJs ? JS_LINK : CSS_LINK, '\n');
    if (after === text) continue;
    const buf = Buffer.from(after, 'utf8');
    writeFileSync(file, buf);
    stripped++;
    // Next.js는 지금 스타일시트에 integrity를 달지 않지만, 달게 되어도 맞게 CSS도 바꾼다(HOT-291 리뷰)
    swap.set(sri(before), sri(buf));
  }
  let manifests = 0;
  if (swap.size) {
    for (const file of walk(join(distDir, 'server'))) {
      if (!/subresource-integrity-manifest\.(json|js)$/.test(file)) continue;
      let s = readFileSync(file, 'utf8');
      const orig = s;
      for (const [a, b] of swap) s = s.split(a).join(b);
      if (s !== orig) {
        writeFileSync(file, s);
        manifests++;
      }
    }
  }
  return { stripped, maps, manifests };
}
