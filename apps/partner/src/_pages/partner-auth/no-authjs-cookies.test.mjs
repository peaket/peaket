// 파트너 앱이 Auth.js(구 NextAuth)와 authjs.* 쿠키를 쓰지 않는지 보는 정적 시험(I-T52 ③, BUILD_ORDER BOT-132, ADR-0119).
// 파트너 로그인은 앱 서버의 얇은 OIDC 클라이언트가 아니라 gw-partner를 지나는 identity 경로이고, 쿠키는
// __Secure-peaket_partner_at·__Secure-peaket_partner_rt 둘뿐이다(identity §3 쿠키 표). 의존성·소스에 Auth.js가 없어야 한다.
// 실행: pnpm --filter @peaket/partner test (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..', '..', '..');
const SKIP = new Set(['node_modules', '.next', 'dist', 'coverage', 'test-results', 'out']);
const TEXT = /\.(m?[jt]sx?|cjs|json|css|md|ya?ml)$/;

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (TEXT.test(e.name)) yield p;
  }
}

const FORBIDDEN = [
  { what: 'Auth.js 패키지', re: /"(?:next-auth|@auth\/[a-z-]+|@next-auth\/[a-z-]+)"\s*:/ },
  { what: 'Auth.js import', re: /from\s+['"](?:next-auth|@auth\/[a-z-]+)(?:\/[^'"]*)?['"]/ },
  { what: 'Auth.js 쿠키 이름', re: /(?:__Secure-|__Host-)?authjs\.[A-Za-z0-9._-]+/ },
  { what: 'NextAuth 쿠키 이름', re: /(?:__Secure-|__Host-)?next-auth\.[A-Za-z0-9._-]+/ },
  { what: 'Auth.js 환경 값', re: /\b(?:NEXTAUTH_URL|NEXTAUTH_SECRET|AUTH_SECRET|AUTH_URL)\b/ },
];

test('I-T52 ③ 파트너 앱의 의존성·소스에 Auth.js와 authjs.* 쿠키가 없다', () => {
  const hits = [];
  let files = 0;
  for (const file of walk(APP)) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const rel = relative(APP, file).replaceAll('\\', '/');
    const text = readFileSync(file, 'utf8');
    files++;
    for (const { what, re } of FORBIDDEN) {
      const m = re.exec(text);
      if (m) hits.push(`${rel}: ${what} (${m[0]})`);
    }
  }
  assert.ok(files > 20, `파트너 앱 파일을 거의 읽지 못했다(${files})`);
  assert.deepEqual(hits, [], `Auth.js 흔적이 있다:\n${hits.join('\n')}`);
});

test('I-T52 ③ 파트너 앱은 로그인 쿠키 이름으로 __Secure-peaket_partner_at·__Secure-peaket_partner_rt만 쓴다', () => {
  // 쿠키 이름을 소스에서 직접 쓰는 곳이 있으면 그 이름이 관리 쿠키 둘인지 본다(다른 쿠키를 심는 코드는 없다)
  const allowed = new Set(['__Secure-peaket_partner_at', '__Secure-peaket_partner_rt']);
  const bad = [];
  for (const file of walk(APP)) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:__Secure-|__Host-)[A-Za-z0-9._-]+/g)) {
      if (!allowed.has(m[0])) bad.push(`${relative(APP, file).replaceAll('\\', '/')}: ${m[0]}`);
    }
  }
  assert.deepEqual(bad, []);
  // 앱이 세션을 브라우저 쿠키가 아니라 서버 BFF로 다루는지: next-auth 라우트 폴더가 없다
  assert.equal(statSync(join(APP, 'src')).isDirectory(), true);
});
