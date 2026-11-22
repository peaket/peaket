// 셸 세션 배선(session-wiring.ts) 동작 시험(BUILD_ORDER GAT-040, F-05-1, docs/frontend.md §6 FE-T47 ④·FE-T48 ②, ADR-0363 결정 7·8, §5.14.4).
// 셸 대화상자의 [로그아웃]과 CMP-068 [알림 켜기]가 실제로 부르는 함수(logout·enable)를 브라우저 경계만 바꿔 끼워 부른다:
// 탭 저장소·location.assign·같은 출처 fetch·serviceWorker(웹 푸시 등록·구독). 정리 루틴·웹 푸시 흐름은 진짜다.
// 셸(AppShell)·화면(OpenAlert·찜 목록)이 이 모듈을 부르는지는 아래 마지막 시험이 소스로 본다(F-05-1 시험 이의: 첫 JS 예산으로 배선을 옮긴 뒤, 커밋 0ed6e470a).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { afterEach, test } from 'node:test';

// session-wiring.ts는 '@/' 별칭으로 가져온다. 이 시험 안에서만 별칭을 푼다(shared/lib/refresh-lock.test.mjs와 같은 방법)
const SRC = new URL('../../../', import.meta.url);
/** 파일만 찾는다(폴더 이름과 같은 별칭은 그 폴더의 index.ts) */
const withExt = (u) => [u, `${u}.ts`, `${u}.tsx`, `${u}/index.ts`].find((c) => existsSync(new URL(c)) && statSync(new URL(c)).isFile());
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const found = withExt(new URL(specifier.slice(2), SRC).href);
      if (found) return next(found, context);
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const found = withExt(new URL(specifier, context.parentURL).href);
      if (found) return next(found, context);
    }
    return next(specifier, context);
  },
});
const { ORIGINS } = await import('../../../shared/config/origins.ts');
const wiring = await import('./session-wiring.ts');

const API = 'https://api.f051-wiring.test';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/f051-shell';
const realFetch = globalThis.fetch;
const realApi = ORIGINS.api;

/** key(i)·length가 있는 탭 저장소 */
function storage(keys) {
  const m = new Map(keys.map((k) => [k, 'v']));
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

/** 브라우저 경계를 깐다. log에 나간 일의 차례를 남긴다 */
function browser({ server = 'redirect', subscribed = true } = {}) {
  const log = [];
  const local = storage(['peaket.clock', 'peaket.queue.evt-1', 'peaket.device', 'peaket.recentSearches']);
  const session = storage(['peaket.wallet.reauth', 'peaket.admission.evt-1', 'peaket.providers.merged']);
  const assigned = [];
  globalThis.window = { localStorage: local, sessionStorage: session, location: { assign: (u) => assigned.push(u) } };
  const reg = { scope: 'https://www.peaket.example/push/', unregister: async () => (log.push('unregister:/push/'), true), pushManager: { getSubscription: async () => (subscribed ? { endpoint: ENDPOINT } : null) } };
  Object.defineProperty(globalThis.navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async (s) => (s === '/push/' ? reg : undefined), getRegistrations: async () => [reg] } });
  ORIGINS.api = API;
  globalThis.fetch = async (url, init = {}) => {
    log.push(`${init.method} ${String(url).replace(API, '')}`);
    if (String(url) === '/logout') {
      if (server === 'down') throw new TypeError('Failed to fetch');
      if (server === 503) return new Response(null, { status: 503 });
      return { type: 'opaqueredirect', status: 0, ok: false };
    }
    return new Response(null, { status: 204 });
  };
  return { log, local, session, assigned };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  ORIGINS.api = realApi;
  delete globalThis.window;
  delete globalThis.navigator.serviceWorker;
});

test('FE-T47 ④ 셸 [로그아웃]: 웹 푸시 DELETE가 POST /logout보다 먼저이고 저장물을 지운 뒤 이동이면 홈으로 간다 [ASVS v5.0.0-14.3.1]', async () => {
  const b = browser();
  assert.equal(await wiring.logout({ clearEntryKeys: false }), undefined);
  const key = createHash('sha256').update(ENDPOINT).digest('base64url');
  assert.deepEqual(b.log, [`DELETE /v1/push-subscriptions/${key}`, 'POST /logout']);
  assert.deepEqual([...b.local.m.keys()].sort(), ['peaket.device', 'peaket.recentSearches']);
  assert.deepEqual([...b.session.m.keys()], ['peaket.providers.merged']);
  assert.deepEqual(b.assigned, ['/']);
});

test('FE-T47 ④ 서버 로그아웃이 503·연결 실패면 대화상자 안에 다시 시도를 안내하고(이동 없음) 저장물은 이미 지워졌다', async () => {
  for (const server of [503, 'down']) {
    const b = browser({ server });
    const r = await wiring.logout({ clearEntryKeys: false });
    assert.equal(typeof r?.error, 'string', String(server));
    assert.ok(r.error.length > 0, String(server));
    assert.deepEqual(b.assigned, [], `${server}: 홈으로 갔다`);
    assert.deepEqual([...b.local.m.keys()].sort(), ['peaket.device', 'peaket.recentSearches'], String(server));
    assert.equal(b.log.at(-1), 'POST /logout', String(server));
    assert.equal(b.log.includes('unregister:/push/'), false, '웹 푸시 워커 등록을 풀었다');
  }
});

test('FE-T48 ② [알림 켜기]를 켤 수 없으면(VAPID 공개키 빌드 값 없음) 요청 없이 이메일로 알려 드립니다를 띄운다', async () => {
  const b = browser({ subscribed: false });
  const toasts = [];
  assert.equal(await wiring.enable((message, icon) => toasts.push([message, icon])), false);
  assert.deepEqual(toasts.map(([m]) => m), ['이메일로 알려 드립니다']);
  assert.deepEqual(b.log, [], '켤 수 없는데 요청을 보냈다');
});

test('FE-T47·FE-T48 셸과 화면이 이 배선을 부른다(대화상자 [로그아웃]·[알림 켜기])', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const shell = read('../AppShell.tsx');
  assert.match(shell, /const sessionWiring = \(\) => import\('\.\/model\/session-wiring'\)/);
  assert.match(shell, /const logout = useCallback\(\(opts: \{ clearEntryKeys: boolean \}\) => sessionWiring\(\)\.then\(\(m\) => m\.logout\(opts\)\)/);
  assert.match(shell, /onLogout=\{logout\}/);
  assert.match(shell, /export const enableWebPush = [^\n]*=> sessionWiring\(\)\.then\(\(m\) => m\.enable\(toast\)\)/);
  assert.match(shell, /m\.start\(signedIn\)/);
  // [알림 켜기]의 누른 처리기 안에서 받은 toast로 부른다
  assert.match(read('../../../features/open-alert/OpenAlert.tsx'), /onAllow=\{\(\) => \{\s*void enablePush\?\.\(toast\)/);
  for (const p of ['../../../_pages/event-detail/ui/DetailPersonal.tsx', '../../../_pages/home/ui/HomePersonal.tsx']) assert.match(read(p), /enablePush=\{enableWebPush\}/, p);
  assert.match(read('../../../_pages/likes/ui/LikesClient.tsx'), /void enableWebPush\(toast\)/);
});
