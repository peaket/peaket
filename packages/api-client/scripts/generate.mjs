// api-client 생성물(docs/frontend.md §2.2 '생성물'·§4.1, BUILD_ORDER BAS-041, ADR-0196). 계약(docs/api/openapi.yaml)에서 만든다.
//   src/gen/operations.ts     작업 서술 표: 작업 이름 → 메서드·경로·호스트·작업 종류(시간 초과)·멱등 키·쿠키·If-Match·T=0·fetch 캐시
//   src/gen/problem-types.ts  이름 붙은 오류 목록(openapi x-peaket-problem-types)
//   src/gen/endpoints/**      orval이 만든 호출 함수·TanStack Query 5 훅(사용자 함수 src/orval-fetch.ts의 orvalFetch로 보낸다)과
//                             MSW 2 처리기(*.msw.ts, faker 값. 화면 운영 묶음에는 넣지 않는다, FE-T21)
//   src/gen/model/**          orval이 만든 요청·응답 TypeScript 형
// 사용: node scripts/generate.mjs           → 임시 폴더에 다 만든 뒤에만 src/gen/을 바꿔 넣는다(실패하면 그대로)
//       generateAll(폴더)                  → <폴더>/src/gen에 만든다(차이 검사가 임시 폴더에 쓴다)
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = fileURLToPath(new URL('..', import.meta.url));
export const OPENAPI = fileURLToPath(new URL('../../../docs/api/openapi.yaml', import.meta.url));
export const GEN = join(PKG, 'src', 'gen');
const require = createRequire(join(PKG, 'package.json'));
const { parse } = require('yaml');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const HOSTS = ['api', 'queue', 'partner-api', 'ops-api', 'scanner-api', 'queue-files', 'www'];
// 확장 칸 값(docs/api/guidelines.md '화면 호출의 작업 종류 표시'). 틀린 값이면 시간 초과가 없어 모든 요청이 바로 끝나므로 생성에서 막는다
const TIMEOUT_KINDS = ['read', 'write', 'longpoll', 'queue-file', 'upload'];
const FETCH_CACHES = ['default', 'no-store', 'reload', 'no-cache', 'force-cache', 'only-if-cached'];
const HEADER = '// 계약(docs/api/openapi.yaml)에서 만든 파일이다. 손으로 고치지 않는다: pnpm --filter @peaket/api-client gen(BUILD_ORDER BAS-041)\n';

function hostOf(url) {
  const h = String(url).replace(/^https?:\/\//, '').replace(/\.peaket\.example\/?$/, '');
  if (!HOSTS.includes(h)) throw new Error(`알 수 없는 호스트: ${url}`);
  return h;
}

/** openapi에서 작업 서술 표를 읽는다(docs/frontend.md §4.1 '호스트'·'자격 증명'·'본문'·'멱등키'·'시간 초과') */
export function operationsOf(spec) {
  const schemes = spec.components?.securitySchemes ?? {};
  const cookieScheme = (name) => schemes[name]?.type === 'apiKey' && schemes[name]?.in === 'cookie';
  const rules = spec['x-peaket-gateways']?.rules ?? [];
  const refName = (p) => (typeof p?.$ref === 'string' ? p.$ref.split('/').pop() : undefined);
  const out = {};
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const id = op.operationId;
      if (!id) throw new Error(`operationId가 없다: ${m.toUpperCase()} ${path}`);
      const servers = op.servers ?? item.servers;
      const server = servers?.[0]?.url ?? rules.find((r) => path.startsWith(r.prefix))?.server;
      if (!server) throw new Error(`호스트를 정하지 못했다: ${m.toUpperCase()} ${path}`);
      const host = hostOf(server);
      const params = [...(op.parameters ?? []), ...(item.parameters ?? [])];
      const content = op.requestBody?.content ?? {};
      const sec = op.security ?? spec.security ?? [];
      const where = `${m.toUpperCase()} ${path}`;
      if (op['x-peaket-timeout'] !== undefined && !TIMEOUT_KINDS.includes(op['x-peaket-timeout'])) throw new Error(`x-peaket-timeout 값이 틀렸다(${TIMEOUT_KINDS.join('·')}): ${where}`);
      if (op['x-peaket-fetch-cache'] !== undefined && !FETCH_CACHES.includes(op['x-peaket-fetch-cache'])) throw new Error(`x-peaket-fetch-cache 값이 틀렸다(${FETCH_CACHES.join('·')}): ${where}`);
      const kind = op['x-peaket-timeout'] ?? (host === 'queue-files' ? 'queue-file' : 'multipart/form-data' in content ? 'upload' : m === 'get' ? 'read' : 'write');
      const d = { operationId: id, method: m.toUpperCase(), path, host, kind };
      if (params.some((p) => refName(p) === 'IdempotencyKey')) d.idempotent = true;
      // 쿠키: 쿠키 방식으로 인증하는 작업, 또는 응답이 Set-Cookie를 주는 작업(로그인: credentials: 'omit'이면 브라우저가 Set-Cookie를 버린다)
      const responses = Object.values(op.responses ?? {});
      const setsCookie = responses.some((r) => Object.keys(r?.headers ?? {}).some((h) => h.toLowerCase() === 'set-cookie'));
      d.cookie = setsCookie || sec.some((req) => Object.keys(req ?? {}).some(cookieScheme));
      if (params.some((p) => refName(p) === 'IfMatch')) d.ifMatch = true;
      if ('text/plain' in content) d.t0 = true;
      if (op['x-peaket-fetch-cache']) d.cache = op['x-peaket-fetch-cache'];
      // SSE 흐름은 EventSource로 연다(생성 함수·훅으로 부르지 않는다)
      if (Object.entries(op.responses ?? {}).some(([c, r]) => String(c).startsWith('2') && 'text/event-stream' in (r?.content ?? {}))) d.sse = true;
      // 생성 함수가 보낼 수 있는 쿼리 이름(그 밖의 쿼리가 붙은 주소는 사용자 함수가 거절한다)
      const query = params.map((p) => (p?.$ref ? spec.components?.parameters?.[refName(p)] : p)).filter((p) => p?.in === 'query').map((p) => p.name).sort();
      if (query.length) d.query = query;
      out[id] = d;
    }
  }
  // 같은 메서드에서 한 주소에 맞는 작업 틀이 둘이면 사용자 함수가 작업을 가를 수 없다(고정 구간이 많은 틀이 이기는 경우만 허용)
  const list = Object.values(out);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.method !== b.method) continue;
      const sa = a.path.split('/'), sb = b.path.split('/');
      if (sa.length !== sb.length) continue;
      const isVar = (x) => /^\{.*\}(\.json)?$/.test(x);
      const fit = sa.every((x, k) => x === sb[k] || isVar(x) || isVar(sb[k]));
      if (fit && sa.filter(isVar).length === sb.filter(isVar).length) throw new Error(`한 주소에 맞는 작업 틀이 겹친다: ${a.method} ${a.path} · ${b.path}`);
    }
  }
  return out;
}

function writeTables(dir, spec) {
  const ops = operationsOf(spec);
  const ids = Object.keys(ops).sort();
  const lines = [HEADER, "import type { Operation } from '../client';", '',
    '/** 작업 이름(operationId, docs/api/guidelines.md §10) */',
    `export type OperationId =\n${ids.map((id) => `  | '${id}'`).join('\n')};`, '',
    '/** 작업 서술 표(docs/frontend.md §4.1). 화면은 OPERATIONS.<작업 이름>을 api-client의 request에 넘기거나, 생성 훅을 쓴다 */',
    `export const OPERATIONS = {\n${ids.map((id) => `  ${id}: ${JSON.stringify(ops[id]).replace(/"([a-zA-Z0-9]+)":/g, '$1: ')},`).join('\n')}\n} as const satisfies Record<OperationId, Operation & { operationId: OperationId }>;`, ''];
  writeFileSync(join(dir, 'operations.ts'), lines.join('\n'));
  const types = spec['x-peaket-problem-types']?.types ?? {};
  const names = Object.keys(types).sort();
  const pl = [HEADER,
    '/** 이름 붙은 오류(RFC 9457 type의 마지막 경로, openapi x-peaket-problem-types, docs/api/guidelines.md §2) */',
    `export type ProblemType =\n${names.map((n) => `  | '${n}'`).join('\n')};`, '',
    `export const PROBLEM_TYPE_BASE = ${JSON.stringify(spec['x-peaket-problem-types']?.base ?? 'https://peaket.example/problems/')};`, '',
    '/** 이름마다 상태 코드와 제목(제목은 화면에 보이지 않는다. 화면은 문구 키로 고른다, docs/frontend.md §5.12) */',
    `export const PROBLEM_TYPES = {\n${names.map((n) => `  '${n}': { status: ${types[n].status}, title: ${JSON.stringify(types[n].title)} },`).join('\n')}\n} as const satisfies Record<ProblemType, { status: number; title: string }>;`, ''];
  writeFileSync(join(dir, 'problem-types.ts'), pl.join('\n'));
}

/** @param {string} root 패키지 모양의 폴더(<root>/src/orval-fetch.ts가 있어야 한다). <root>/src/gen에 만든다 */
export async function generateAll(root, { openapi = OPENAPI } = {}) {
  const spec = parse(readFileSync(openapi, 'utf8'));
  const gen = join(root, 'src', 'gen');
  rmSync(gen, { recursive: true, force: true });
  mkdirSync(gen, { recursive: true });
  writeTables(gen, spec);
  // orval은 이 패키지가 고정한 판(계약 패키지와 같은 8.45)을 쓴다. 판 정보는 이 패키지의 package.json·tsconfig로 정한다(작업 폴더 위의 파일을 찾지 않게)
  const { generate } = await import(pathToFileURL(require.resolve('orval')).href);
  await generate({
    input: { target: openapi },
    output: {
      target: join(gen, 'endpoints', 'endpoints.ts'),
      schemas: join(gen, 'model'),
      client: 'react-query',
      httpClient: 'fetch',
      mode: 'tags-split',
      mock: { generators: [{ type: 'msw' }] },
      // 경로 변수를 부호화한다(.. ? # 가 다른 작업으로 새지 않게, 새 맥락 리뷰 BAS-041)
      urlEncodeParameters: true,
      packageJson: join(PKG, 'package.json'),
      tsconfig: join(PKG, 'tsconfig.json'),
      override: {
        mutator: { path: join(root, 'src', 'orval-fetch.ts'), name: 'orvalFetch' },
        query: { version: 5, signal: true },
        // 오류는 사용자 함수가 ApiError로 던지므로 반환 형은 성공 응답만이다(오류 형은 orval-fetch.ts의 ErrorType)
        fetch: { forceSuccessResponse: true },
      },
    },
  }, root, { throwOnError: true, logLevel: 'warn' });
}

if (import.meta.main) {
  const work = mkdtempSync(join(tmpdir(), 'api-client-gen-'));
  try {
    mkdirSync(join(work, 'src'), { recursive: true });
    cpSync(join(PKG, 'src', 'orval-fetch.ts'), join(work, 'src', 'orval-fetch.ts'));
    await generateAll(work);
    rmSync(GEN, { recursive: true, force: true });
    cpSync(join(work, 'src', 'gen'), GEN, { recursive: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
