// 정적 자산 올리기 목록·소스 맵 링크 검사·정적 자산 SBOM(docs/frontend.md §5.18 '정적 업로드 허용 확장자'·§5.14.5 'SBOM',
// FE-T21의 '소스 맵 링크·허용 확장자', ASVS 13.4.1·13.4.7·15.1.2, BUILD_ORDER BAS-220).
//   node static/assets.mjs --app <이름> --dir <빌드 폴더> --out <결과 폴더> [--package <앱 폴더>] [--external <출처>]... [--allow-simulator]
// --package: 앱이 기대는 작업 공간 패키지(@peaket/*, 설정 패키지 빼고)와 그 실행 의존성도 SBOM에 더한다. Vite는 CSS 소스 맵을 내지 않아
// CSS로만 실리는 패키지(@peaket/ds·@seed-design/css)가 소스 맵에서 빠지기 때문이다(구간 1 끝 정리).
// 결과: upload.json(올릴 파일과 뺀 파일·까닭), sbom.cdx.json(CycloneDX 1.6, 묶음에 실제로 든 패키지). 오류가 있으면 끝 코드 1.
// 묶음에 든 패키지는 링크 없는 숨김 소스 맵(.map, 올리지 않는다)의 원본 경로에서 읽는다. 맵이 없는 빌드(Next.js 앱)는 이 도구로
// SBOM을 만들지 않고 `pnpm --filter <앱> sbom --sbom-format cyclonedx --prod`(실행 의존성, 묶음보다 넓다)를 쓴다.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

/** 정본 §5.18의 허용 확장자(static/assets.test.mjs가 정본과 같은지 본다) */
export const ALLOWED_EXTENSIONS = ['js', 'mjs', 'css', 'woff2', 'avif', 'webp', 'png', 'svg', 'ico', 'json', 'webmanifest', 'wasm', 'html'];
/** 앱마다 정적 배포에 함께 싣는 제3자 고지 파일(ADR-0040 결정 7, BUILD_ORDER HOT-390). `.txt` 예외는 이 이름 하나뿐이다 */
export const NOTICE_FILE = 'THIRD-PARTY-NOTICES.txt';
/** 글자로 읽어 소스 맵 링크를 찾는 확장자 */
const TEXT_EXTENSIONS = new Set(['js', 'mjs', 'css', 'html', 'json', 'webmanifest', 'svg']);
// 소스 맵 링크: JS의 `//# sourceMappingURL=`와 CSS의 블록 주석 꼴(예전 꼴 `//@`도 본다)
const SOURCE_MAP_LINK = /[#@]\s*sourceMappingURL\s*=/;
/** MSW(목업 처리기)가 묶음에 든 흔적: 서비스 워커 이름, 로그 머리, 진입점 이름(FE-T21 '개발 도구·MSW', ADR-0199 결정 2) */
export const MSW_MARKERS = /mockServiceWorker|\[MSW\]|msw\/(?:browser|node)/;
/** 데모 결제창이 묶음에 든 흔적: 데모 전용 경로 이름(FE-T21 '시뮬레이터', ADR-0253). 데모 빌드만 allowSimulator로 지나간다 */
export const SIMULATOR_MARKERS = /\/demo\/pg-simulator\/authenticate/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const extOf = (path) => {
  const base = path.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
};

/**
 * 빌드 폴더에서 올릴 파일을 고른다. 허용 확장자 밖(.map·.env·.txt 등)과 숨은 파일·폴더(.git·.env…)는 빼고 까닭을 적는다.
 * 올릴 글자 파일에 소스 맵 링크가 있으면 오류다(링크가 있으면 맵 주소가 드러난다, FE-T21).
 * @param {string} dir
 */
export function planUpload(dir, { allowSimulator = false } = {}) {
  const upload = [];
  const excluded = [];
  const errors = [];
  for (const abs of walk(dir).sort()) {
    const rel = relative(dir, abs).split(sep).join('/');
    const ext = extOf(rel);
    if (rel.split('/').some((seg) => seg.startsWith('.'))) {
      excluded.push({ path: rel, reason: '숨은 파일·폴더(.git·.env 등)' });
      continue;
    }
    const notice = rel.split('/').pop() === NOTICE_FILE;
    if (!notice && !ALLOWED_EXTENSIONS.includes(ext)) {
      excluded.push({ path: rel, reason: ext === 'map' ? '소스 맵(오류 도구에만 올린다)' : `허용 확장자 밖(.${ext || '없음'})` });
      continue;
    }
    const bytes = readFileSync(abs);
    const text = TEXT_EXTENSIONS.has(ext) ? bytes.toString('utf8') : '';
    if (text && SOURCE_MAP_LINK.test(text)) errors.push(`${rel}: 소스 맵 링크가 있다(숨김 소스 맵으로 빌드한다)`);
    if ((ext === 'js' || ext === 'mjs' || ext === 'html') && MSW_MARKERS.test(text)) errors.push(`${rel}: MSW 목업 처리기 글자가 있다(운영 묶음에 넣지 않는다, FE-T21)`);
    if (!allowSimulator && (ext === 'js' || ext === 'mjs' || ext === 'html') && SIMULATOR_MARKERS.test(text)) errors.push(`${rel}: 데모 결제창이 묶음에 있다(운영 묶음에 넣지 않는다, FE-T21, ADR-0253)`);
    upload.push({ path: rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { upload, excluded, errors };
}

/**
 * 소스 맵의 원본 경로에서 묶음에 든 패키지(이름@판)를 모은다. pnpm 저장 경로(node_modules/.pnpm/<이름>@<판>…/node_modules/<이름>/)와
 * 작업 공간 패키지(packages/<폴더>/)를 알아본다.
 * @param {string} dir 빌드 폴더
 * @param {string} repoRoot 저장소 뿌리(작업 공간 패키지의 package.json을 읽는다)
 */
export function bundledPackages(dir, repoRoot) {
  const found = new Map();
  for (const abs of walk(dir).filter((p) => p.endsWith('.map'))) {
    const map = JSON.parse(readFileSync(abs, 'utf8'));
    for (const src of map.sources ?? []) {
      const s = String(src).replaceAll('\\', '/');
      // pnpm 저장 폴더 이름은 '<이름의 /를 +로>@<판>[_<동료 의존성>]'이다(예: react-dom@19.3.1_react@19.3.1)
      const pnpm = /node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(s);
      if (pnpm) {
        const [, folder, name] = pnpm;
        const prefix = `${name.replace('/', '+')}@`;
        if (folder.startsWith(prefix)) {
          const version = folder.slice(prefix.length).split('_')[0];
          found.set(`${name}@${version}`, { name, version });
        }
        continue;
      }
      const ws = /(?:^|\/)packages\/([^/]+)\//.exec(s);
      if (ws) {
        const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'packages', ws[1], 'package.json'), 'utf8'));
        found.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, workspace: true });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 작업 공간 패키지 이름 → 폴더(packages/*, apps/*) */
function workspaceDirs(repoRoot) {
  const out = new Map();
  for (const top of ['packages', 'apps']) {
    let names = [];
    try {
      names = readdirSync(join(repoRoot, top));
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        const pkg = JSON.parse(readFileSync(join(repoRoot, top, n, 'package.json'), 'utf8'));
        out.set(pkg.name, join(repoRoot, top, n));
      } catch {
        // package.json이 없는 폴더
      }
    }
  }
  return out;
}

/** 설치된 패키지의 판(그 패키지 폴더의 node_modules에서, pnpm은 연결로 둔다) */
function installedVersion(fromDir, name) {
  try {
    return JSON.parse(readFileSync(join(fromDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

/**
 * 앱이 기대는 작업 공간 패키지(dependencies·devDependencies의 workspace:, @peaket/config 빼고)와 그 패키지들의 실행 의존성(dependencies)을 판과 함께 모은다
 * @param {string} appDir 앱 폴더
 * @param {string} repoRoot
 */
export function workspaceDeps(appDir, repoRoot) {
  const dirs = workspaceDirs(repoRoot);
  const found = new Map();
  const seen = new Set();
  const visit = (dir, includeDev) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(includeDev ? (pkg.devDependencies ?? {}) : {}) };
    for (const [name, spec] of Object.entries(deps)) {
      if (String(spec).startsWith('workspace:')) {
        if (name === '@peaket/config' || seen.has(name) || !dirs.has(name)) continue;
        seen.add(name);
        const wdir = dirs.get(name);
        const wpkg = JSON.parse(readFileSync(join(wdir, 'package.json'), 'utf8'));
        found.set(`${name}@${wpkg.version}`, { name, version: wpkg.version, workspace: true, declared: true });
        visit(wdir, false);
      } else if (!includeDev) {
        const version = installedVersion(dir, name);
        if (version) found.set(`${name}@${version}`, { name, version, declared: true });
      }
    }
  };
  visit(appDir, true);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const purl = (name, version) => `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;

/**
 * 앱 하나의 정적 자산 SBOM(CycloneDX 1.6 JSON). 실행 중에 밖에서 받아 오는 스크립트(결제사·사람 확인)는 비고(properties)에 적는다(ADR-0079 결정 22)
 * @param {{ app: string, packages: Array<{ name: string, version: string, workspace?: boolean }>, external?: string[], upload: Array<{ path: string, sha256: string }> }} o
 */
export function cycloneDx(o) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: { type: 'application', name: o.app, 'bom-ref': `app:${o.app}` },
      properties: [
        { name: 'peaket:sbom-kind', value: 'static-assets' },
        ...(o.external ?? []).map((url) => ({ name: 'peaket:external-script', value: url })),
      ],
    },
    components: o.packages.map((p) => ({
      type: 'library',
      name: p.name,
      version: p.version,
      'bom-ref': purl(p.name, p.version),
      ...(p.workspace ? {} : { purl: purl(p.name, p.version) }),
      // 출처: source-map = 숨김 소스 맵에서 읽은 묶음에 든 패키지, declared = 앱이 기대는 작업 공간 패키지의 실행 의존성(CSS로만 실리는 것 포함, 묶음에 없을 수 있다)
      properties: [
        ...(p.workspace ? [{ name: 'peaket:workspace', value: 'true' }] : []),
        { name: 'peaket:source', value: p.declared ? 'declared' : 'source-map' },
      ],
    })),
    // 올린 파일 수(파일마다 크기·SHA-256은 upload.json에 있다)
    properties: [{ name: 'peaket:upload-files', value: String(o.upload.length) }],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { app: { type: 'string' }, dir: { type: 'string' }, out: { type: 'string' }, package: { type: 'string' }, external: { type: 'string', multiple: true }, 'allow-simulator': { type: 'boolean' } } });
  if (!values.app || !values.dir || !values.out) {
    console.error('쓰는 법: node static/assets.mjs --app <이름> --dir <빌드 폴더> --out <결과 폴더> [--external <출처>]...');
    process.exit(2);
  }
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  // 데모 오버레이 빌드만 데모 결제창을 허용한다(FE-T21, ADR-0253)
  const plan = planUpload(resolve(values.dir), { allowSimulator: values['allow-simulator'] === true });
  const fromMaps = bundledPackages(resolve(values.dir), repoRoot);
  const fromPkg = values.package ? workspaceDeps(resolve(values.package), repoRoot) : [];
  // 소스 맵에서 읽은 패키지(묶음에 실제로 든 것)가 이긴다. --package로 더한 것은 '선언한 의존성'(묶음에 들 수 있는 것)으로 표시한다
  const merged = new Map(fromPkg.map((p) => [`${p.name}@${p.version}`, p]));
  for (const p of fromMaps) merged.set(`${p.name}@${p.version}`, p);
  const packages = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, 'upload.json'), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(join(values.out, 'sbom.cdx.json'), `${JSON.stringify(cycloneDx({ app: values.app, packages, external: values.external, upload: plan.upload }), null, 2)}\n`);
  console.log(`${values.app}: 올릴 파일 ${plan.upload.length}, 뺀 파일 ${plan.excluded.length}, 묶음에 든 패키지 ${packages.length}`);
  for (const e of plan.errors) console.error(`오류: ${e}`);
  process.exit(plan.errors.length ? 1 : 0);
}
