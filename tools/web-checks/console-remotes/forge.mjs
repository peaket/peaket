// 관제 원격 위젯 화면 검사의 무대(F-03-2 OPS-350·360). 운영 빌드(apps/console-host/dist, 호스트 + 한 파일 원격 둘 + remotes.json)를 임시 폴더에 복사해
// 한 곳만 바꾼 뒤(원격 바이트 한 바이트, 목록 칸 하나, 원격 파일 지우기) 관제 미리보기 서버(createPreviewServer, staticAppHeaders('console'))로 띄운다.
// 위조 원격은 실제 빌드한 원격 바이트를 한 바이트 바꿔 만든다(계획 5 '위조 원격'). 바꾼 바이트도 올바른 자바스크립트라 무결성을 보지 않으면 실행된다.
// 무대마다 출처(포트)가 달라 브라우저 HTTP 캐시가 섞이지 않는다(원격 파일은 immutable). 이름이 *.spec.mjs가 아니라 시험 파일로 돌지 않는다.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewServer } from '../../../apps/console-host/scripts/preview-server.mjs';
import { manifestEntries } from '../../../apps/console-host/scripts/remotes-manifest.mjs';

export const APP_DIR = fileURLToPath(new URL('../../../apps/console-host/', import.meta.url));
export const DIST = path.join(APP_DIR, 'dist');
/** 대체 원격 빌드(계약 패키지 판 범위 ^2.0.0, T18) 자리: build.mjs가 만든다 */
export const ALT_DIST = fileURLToPath(new URL('../reports/console-remotes-alt/', import.meta.url));
export const REMOTES = ['queue', 'purchase'];

/** 빌드한 목록(dist/remotes.json) */
export function builtList(dist = DIST) {
  const p = path.join(dist, 'remotes.json');
  if (!existsSync(p)) throw new Error(`운영 빌드가 없다: ${p}(pnpm --filter @peaket/console-host build)`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** 목록의 원격 항목 하나 */
export const entryOf = (list, name) => {
  const e = list.find((x) => x.name === name);
  if (!e) throw new Error(`목록에 ${name}이 없다`);
  return e;
};

/** 원격 진입 파일의 디스크 경로 */
export const entryFile = (dist, e) => path.join(dist, ...e.entry.split('/').filter(Boolean));

/**
 * 운영 빌드를 복사해 바꾼 무대를 띄운다
 * @param {(dir: string, list: any[]) => void | Promise<void>} [mutate] 복사본 폴더와 목록을 받아 바꾼다(목록을 바꾸면 writeList로 쓴다)
 */
export async function stage(mutate) {
  const dir = mkdtempSync(path.join(tmpdir(), 'peaket-console-remotes-'));
  // 숨김 소스 맵은 올리지 않는 파일이라 뺀다
  cpSync(DIST, dir, { recursive: true, filter: (src) => !src.endsWith('.map') && path.basename(src) !== 'maps' });
  if (mutate) await mutate(dir, builtList(dir));
  // 바꾼 뒤의 목록(목록을 바꾼 시험은 그 값을 본다)
  const list = builtList(dir);
  const server = createPreviewServer({ dist: dir, env: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    dir,
    list,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 목록을 쓴다 */
export const writeList = (dir, list) => writeFileSync(path.join(dir, 'remotes.json'), `${JSON.stringify(list, null, 2)}\n`);

/**
 * 원격 바이트 한 바이트를 바꾼다(올바른 자바스크립트로 남는 자리: Grafana 주소 글자의 'g' → 'G'). 바꾼 자리가 없으면 멈춘다
 * @returns {{ before: Buffer, after: Buffer }}
 */
export function flipOneByte(dir, e) {
  const file = entryFile(dir, e);
  const before = readFileSync(file);
  const at = before.indexOf('grafana.ops.peaket.example');
  if (at < 0) throw new Error(`바꿀 글자를 원격에서 찾지 못했다: ${file}`);
  const after = Buffer.from(before);
  after[at] = 'G'.charCodeAt(0);
  writeFileSync(file, after);
  return { before, after };
}

/** 대체 원격(계약 판 범위 ^2.0.0)으로 queue를 바꾸고 목록을 다시 쓴다(T18) */
export function useAltQueue(dir) {
  const altQueue = path.join(ALT_DIST, 'queue');
  if (!existsSync(altQueue)) throw new Error(`대체 원격 빌드가 없다: ${altQueue}(node console-remotes/build.mjs)`);
  rmSync(path.join(dir, 'remotes/queue'), { recursive: true, force: true });
  cpSync(altQueue, path.join(dir, 'remotes/queue'), { recursive: true, filter: (src) => !src.endsWith('.map') && path.basename(src) !== 'maps' });
  const list = manifestEntries({ dist: dir });
  writeList(dir, list);
  return list;
}

/** 페이지가 받은 요청을 경로별로 센다(무대 출처만) */
export function countRequests(page, origin) {
  const seen = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin === origin) seen.push({ path: u.pathname, method: r.method(), request: r });
  });
  return {
    seen,
    count: (p) => seen.filter((x) => (typeof p === 'string' ? x.path === p : p.test(x.path))).length,
  };
}

/** 위반 보고(securitypolicyviolation)와 만든 Trusted Types 정책 이름을 적는다(console-csp/console.spec.mjs와 같은 방법) */
export async function trackPolicies(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    window.__ttNames = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ directive: e.effectiveDirective, disposition: e.disposition, blocked: e.blockedURI, sample: (e.sample || '').slice(0, 80) }));
    const tt = window.trustedTypes;
    if (tt?.createPolicy) {
      const create = tt.createPolicy.bind(tt);
      tt.createPolicy = (name, rules) => {
        window.__ttNames.push(name);
        return create(name, rules);
      };
    }
  });
  return () => page.evaluate(() => ({ violations: window.__csp, names: window.__ttNames }));
}

/** 원격 sha 폴더 이름들(한 원격에 정확히 하나여야 한다) */
export const shaDirsOf = (dist, name) => readdirSync(path.join(dist, 'remotes', name)).filter((d) => /^[0-9a-f]{7,40}$/.test(d));

/**
 * 원격 진입 파일 스크립트 요소를 넣은 횟수(적재기의 시도 수)를 적는다. 브라우저가 같은 주소를 메모리 캐시나 진행 중인 요청으로 채우면
 * 네트워크 요청 수는 시도 수보다 적을 수 있어, '한 번 다시'는 요소를 넣은 수로 센다(요소마다 integrity·crossorigin도 적는다)
 */
export async function trackRemoteScripts(page) {
  await page.addInitScript(() => {
    window.__remoteScripts = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n.nodeName === 'SCRIPT' && n.src && new URL(n.src).pathname.startsWith('/remotes/'))
            window.__remoteScripts.push({ path: new URL(n.src).pathname, integrity: n.getAttribute('integrity'), crossorigin: n.getAttribute('crossorigin'), fetchpriority: n.getAttribute('fetchpriority'), t: performance.now() });
    }).observe(document, { childList: true, subtree: true });
  });
  const all = () => page.evaluate(() => window.__remoteScripts);
  return { all, count: async (p) => (await all()).filter((x) => x.path === p).length };
}
