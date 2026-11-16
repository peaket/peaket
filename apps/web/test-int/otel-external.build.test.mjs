// 운영 빌드 산출물로 앱 서버 텔레메트리의 OTel SDK가 서버 묶음 밖에 있는지 본다(W8-L1-ci-fix4 계획 §5 CF4-03·04,
// docs/frontend.md §5.18 '앱 서버 실행', BUILD_ORDER HOT-400·BAS-220 첫 JS 예산).
// 시험 담당(w8l1-cifix4-test)이 정본과 계획에서 썼다. 이름만 serverExternalPackages에 넣고 실제로는 묶이는 꼴(@peaket/platform이
// 작업 공간 패키지라 듣지 않은 2026-11-17 develop CI)을 산출물로 막는다. 소스 시험(server/server-external.test.mjs CF4-01·02)과 짝이다.
// 무거운 게이트 몫이다: 게이트의 운영 빌드(tools/web-checks에서 `node seed-css/build.mjs web`이 만든 apps/web/.next)가 있어야 한다.
// 산출물이 없으면 건너뛰지 않고 실패한다. Docker는 쓰지 않는다. 산출물을 읽기만 한다(복사·고침 없음).
// 실행: apps/web에서 node --test test-int/otel-external.build.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = '.next';
const BUILD_HINT = '(tools/web-checks에서 node seed-css/build.mjs web)';

/** 정본 docs/frontend.md §5.18 '앱 서버 실행'의 OTel SDK 여섯(계획 §2의 1). `@opentelemetry/` 뒤 이름 */
const OTEL_SIX = ['api', 'core', 'exporter-trace-otlp-proto', 'resources', 'sdk-node', 'sdk-trace'];

/**
 * 텔레메트리 서버 덩어리 크기 한도(계획 §5 CF4-03, [가정] 100kB). 2026-11-17 이 PC에서 SDK를 묶었을 때 606,251바이트,
 * 밖에 두었을 때 18,203바이트였다
 */
const CHUNK_LIMIT = 100 * 1000;

/** 정규식에 그대로 넣을 수 있게 특수 글자를 막는다 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 폴더 아래 .js·.cjs·.mjs 파일 경로(.map은 뺀다. 링크는 따라가지 않는다) */
function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) jsFiles(p, out);
    else if (/\.(c|m)?js$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * `startAppServerTelemetry`를 내보내는(정의한) 서버 덩어리들. Turbopack은 내보내기를 `"이름",()=>값`(다시 내보내기) 또는
 * `"이름",0,function(…){…}`(그 자리 정의) 꼴로 등록한다(2026-11-17 이 PC의 구현 뒤·구현 전 운영 빌드에서 본 꼴).
 * 이것을 부르기만 하는 instrumentation 덩어리(`{startAppServerTelemetry:o}=await …`)는 이 꼴이 아니라 들지 않는다
 */
function telemetryChunks() {
  const server = join(appDir, DIST, 'server');
  assert.ok(existsSync(server), `운영 빌드 서버 산출물이 없다: apps/web/${DIST}/server ${BUILD_HINT}`);
  const files = jsFiles(server);
  assert.ok(files.length > 0, '훑은 서버 덩어리 파일이 없다(빈 결과)');
  return files.filter((f) => /["']startAppServerTelemetry["']\s*,\s*(\(\)\s*=>|function|\d+\s*,\s*(function|\(|[\w$]+\s*=>))/.test(readFileSync(f, 'utf8')));
}

test('CF4-03 HOT-400·BAS-220 운영 빌드의 텔레메트리 서버 덩어리는 OTel SDK를 묶지 않고 밖 모듈로 부른다', () => {
  const chunks = telemetryChunks();
  assert.ok(chunks.length > 0, `.next/server 아래에 startAppServerTelemetry를 정의한 덩어리가 없다(텔레메트리 입구가 묶음에서 빠졌다) ${BUILD_HINT}`);
  for (const f of chunks) {
    const rel = relative(appDir, f);
    const src = readFileSync(f, 'utf8');
    // 밖 모듈 부르기 꼴: require("@opentelemetry/<이름>") 또는 Turbopack의 .y(…)·.x(…). 이름 뒤에 -<해시>가 붙을 수 있다
    const missing = OTEL_SIX.filter(
      (n) => !new RegExp(`(?:\\brequire|\\.y|\\.x)\\(\\s*["']@opentelemetry/${escapeRe(n)}(?:-[0-9a-f]+)?["']`).test(src),
    );
    assert.deepEqual(missing, [], `${rel}이 밖 모듈로 부르지 않는 OTel 패키지가 있다(서버 묶음에 들어갔다)`);
    const size = statSync(f).size;
    assert.ok(size < CHUNK_LIMIT, `${rel}이 ${size}바이트다(한도 ${CHUNK_LIMIT}. SDK가 묶이면 모듈 번호가 길어져 첫 JS가 는다, §5.18)`);
  }
});

/** 풀린 파일에서 위로 올라가며 처음 만나는 package.json의 name */
function packageNameOf(file) {
  for (let d = dirname(file); d !== dirname(d); d = dirname(d)) {
    const pj = join(d, 'package.json');
    if (existsSync(pj)) {
      const name = JSON.parse(readFileSync(pj, 'utf8')).name;
      if (name) return name;
    }
  }
  return undefined;
}

/**
 * `fromDir` 자리에서 이름들을 ESM(import 조건)으로 푼 실제 경로. Turbopack의 밖 모듈 `.y(…)`는 import()로 불러, standalone 추적이
 * import 조건의 파일(`dist/index.mjs` 같은 것)만 싣는 패키지가 있다(require 조건의 `.cjs`는 없을 수 있다). 자식 Node의 `--input-type=module -e`는
 * 현재 폴더를 부모로 삼아 푼다. 못 풀면 null
 */
function esmResolve(fromDir, specs) {
  const code = `const o={};for(const s of ${JSON.stringify(specs)}){try{o[s]=import.meta.resolve(s)}catch{o[s]=null}}process.stdout.write(JSON.stringify(o))`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fromDir, encoding: 'utf8' });
  assert.equal(r.status, 0, `ESM 해석 자식 Node가 실패했다: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v ? fileURLToPath(v) : null]));
}

test('CF4-04 HOT-400 standalone에 밖에 둔 OTel 패키지가 실린다', () => {
  const standalone = join(appDir, DIST, 'standalone');
  const app = join(standalone, 'apps', 'web');
  assert.ok(existsSync(join(app, 'server.js')), `운영 빌드 standalone 산출물이 없다: apps/web/${DIST}/standalone ${BUILD_HINT}`);
  // 서버 덩어리 자리에서 Node 해석으로 푼다. standalone은 apps/web/.next 아래라 위로 올라가면 개발 설치(apps/web/node_modules,
  // apps/web/.next/node_modules)까지 닿으므로, 풀린 실제 경로가 standalone 안이고 그 패키지 이름일 때만 실린 것으로 센다
  const chunkDir = join(app, DIST, 'server', 'chunks');
  assert.ok(existsSync(chunkDir), `standalone 서버 덩어리 폴더가 없다: ${relative(appDir, chunkDir)} ${BUILD_HINT}`);
  const fromChunk = createRequire(join(chunkDir, 'otel-probe.js'));
  const linkDir = join(app, DIST, 'node_modules', '@opentelemetry');
  const links = existsSync(linkDir) ? readdirSync(linkDir) : [];
  // 두 꼴 어느 것이든: Turbopack 밖 모듈 연결(.next/node_modules/@opentelemetry/<이름>-<해시>) 또는 node_modules의 이름 그대로
  const specsOf = (n) => [...links.filter((l) => new RegExp(`^${escapeRe(n)}-[0-9a-f]+$`).test(l)), n].map((x) => `@opentelemetry/${x}`);
  const esm = esmResolve(chunkDir, OTEL_SIX.flatMap(specsOf));
  const inside = (p, n) => typeof p === 'string' && p.startsWith(standalone + sep) && packageNameOf(p) === `@opentelemetry/${n}`;
  const report = OTEL_SIX.map((n) => {
    const found = [];
    for (const spec of specsOf(n)) {
      let cjs = null;
      try {
        cjs = fromChunk.resolve(spec);
      } catch {
        // require 조건으로 못 풀면 import 조건만 본다
      }
      for (const p of [cjs, esm[spec]]) if (inside(p, n)) found.push(relative(standalone, p));
    }
    return { name: `@opentelemetry/${n}`, found };
  });
  assert.deepEqual(
    report.filter((r) => r.found.length === 0).map((r) => r.name),
    [],
    'standalone 안에서 풀리지 않는 OTel 패키지가 있다(운영 서버가 텔레메트리를 띄우지 못한다)',
  );
});
