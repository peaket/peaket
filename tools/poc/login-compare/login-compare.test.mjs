// I-T51 로그인 구현 비교(docs/features/identity.md §12·§12.1, ADR-0119 결정 3).
// 네 구현(A1 Auth.js 기본 사용, A2 Auth.js를 문서 기능만으로 고친 판, C1 openid-client, C2 oauth4webapi)마다 같은 시험을 돌린다.
// 시험이 쿠키 모음을 가진 브라우저 노릇을 하고, 모의 OIDC 제공자와 identity 세션 대역을 띄운다. 막힌 시험은 그 이유(구현이 서버 쪽에
// 남긴 오류)도 모은다. 쿠키 수·서명 검증 여부·막힌 이유는 cookie-counts.json에 남기고 report.mjs가 RESULT.md로 옮긴다.
// 실행: cd tools/poc/login-compare && node --test --test-reporter=junit --test-reporter-destination=junit.xml && node report.mjs
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Browser, CLIENT, PEAKET_COOKIES, PROVIDERS, serve, startIdentityStub, startMockOP } from './harness.mjs';

const IMPLS = {
  A1: () => import('./a-authjs.mjs'),
  A2: () => import('./a-authjs-hardened.mjs'),
  C1: () => import('./c-openid-client.mjs'),
  C2: () => import('./c-oauth4webapi.mjs'),
};
const counts = {};
const isC = (n) => n.startsWith('C');
// 막힌 이유: 라이브러리가 감싼 원인(cause)과 OAuth 오류(error·error_description)까지 한 줄로
const why = (e) => [e?.message, e?.code, e?.error, e?.error_description, e?.cause?.message, e?.cause?.code, e?.cause?.error, e?.cause?.error_description, e?.cause?.err?.message, e?.cause?.err?.code].filter((x) => typeof x === 'string' && x).join(' / ') || String(e);

for (const [name, load] of Object.entries(IMPLS)) {
  describe(`구현 ${name}`, () => {
    let op;
    let idp;
    let app;
    let createApp;
    const reasons = [];
    const OFF = { wrongIss: false, wrongAud: false, naverIdMismatch: false, badSignature: false, otherNonce: false, expired: false, discoveryIssuer: false };
    const reset = () => Object.assign(op.mode, OFF);
    const startApp = async () => {
      let origin = '';
      const handler = await createApp({ issuer: op.issuer, client: CLIENT, identityUrl: idp.url, origin: () => origin, insecure: true, onError: (where, e) => reasons.push(`${where}: ${why(e)}`) });
      const srv = await serve(handler);
      origin = srv.url;
      return srv;
    };
    before(async () => {
      op = await startMockOP();
      idp = await startIdentityStub();
      ({ createApp } = await load());
      app = await startApp();
      counts[name] = { blockedReasons: {} };
    });
    after(async () => {
      await app.close();
      await op.close();
      await idp.close();
    });
    const host = () => new URL(app.url).host;
    const start = (b, p, { origin = app.url, returnTo, base = app.url } = {}) =>
      b.go(`${base}/login/${p}`, {
        method: 'POST', follow: false,
        headers: { origin, ...(returnTo ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: returnTo ? new URLSearchParams({ returnTo }).toString() : undefined,
      });
    /** 로그인을 시작해 제공자 동의까지 따라가고, 앱 콜백 주소에서 멈춘다 */
    async function toCallback(b, p, o = {}) {
      const s = await start(b, p, o);
      assert.ok([302, 303].includes(s.res.status), `${name} 시작 ${s.res.status} ${s.text.slice(0, 200)}`);
      const authz = new URL(s.res.headers.get('location'), o.base ?? app.url).toString();
      assert.ok(authz.startsWith(op.issuer(p)), `${name} 인가 주소 ${authz}`);
      const a = await b.go(authz, { follow: false });
      return new URL(a.res.headers.get('location')).toString();
    }
    const loggedIn = (b) => PEAKET_COOKIES.every((n) => b.names(host()).includes(n));
    const outside = (b) => b.names(host()).filter((n) => !PEAKET_COOKIES.includes(n));
    /** 세션을 만들지 않아야 하는 시도: 세션 수가 그대로이고 PEAKET 쿠키가 없다. 막힌 이유를 남긴다 */
    async function blocked(label, b, attempt) {
      const n0 = idp.sessions.size;
      const r0 = reasons.length;
      await attempt();
      counts[name].blockedReasons[label] = reasons.slice(r0);
      assert.equal(loggedIn(b), false, `${label}: PEAKET 쿠키가 생겼다`);
      assert.equal(idp.sessions.size, n0, `${label}: identity 세션이 생겼다`);
      return reasons.slice(r0).join(' | ');
    }

    for (const p of PROVIDERS) {
      test(`I-T51 ① ${name} ${p}: 정상 로그인은 identity 세션을 sub로 만들고 PEAKET 쿠키를 준다 [ASVS v5.0.0-10.1.1] [ASVS v5.0.0-10.5.2]`, async () => {
        reset();
        const b = new Browser();
        const n0 = idp.sessions.size;
        const r = await b.go(await toCallback(b, p));
        assert.ok(loggedIn(b), `${name} ${p}: PEAKET 쿠키 없음, 마지막 ${r.url} ${r.res.status} ${r.text.slice(0, 200)} ${reasons.slice(-2).join(' | ')}`);
        assert.equal(idp.sessions.size, n0 + 1);
        const s = [...idp.sessions.values()].at(-1);
        assert.deepEqual([s.provider, s.sub, s.email], [p, op.users[p].sub, op.users[p].email]);
        if (p === 'kakao') {
          counts[name].afterLogin = outside(b);
          counts[name].sessionCookies = outside(b).filter((n) => /session/i.test(n));
        }
      });
    }

    test(`I-T51 ① ${name}: 돌아갈 주소는 같은 출처의 경로만 따르고 다른 사이트 주소는 '/'로 바꾼다`, async () => {
      reset();
      for (const [want, given] of [['/events/1', '/events/1'], ['/', 'https://evil.example/x'], ['/', '//evil.example/x'], ['/', '/..//evil.example/x'], ['/search', '/search?q=아이유']]) {
        const b = new Browser();
        const r = await b.go(await toCallback(b, 'google', { returnTo: given }));
        assert.ok(loggedIn(b), `${name}: ${given}`);
        const landed = r.trail.map((t) => new URL(t.url)).filter((x) => x.host === host()).at(-1);
        assert.equal(`${landed.pathname}`, want, `${name}: ${given} → ${landed}`);
      }
    });

    test(`I-T51 ① ${name}: 다른 출처에서 보낸 로그인 시작은 막는다`, async () => {
      reset();
      const r = await start(new Browser(), 'kakao', { origin: 'https://evil.example' });
      assert.ok([400, 403].includes(r.res.status), `${name}: ${r.res.status}`);
    });

    test(`I-T51 ② ${name}: 다른 브라우저에 붙여넣은 콜백 주소는 세션을 만들지 않는다 [ASVS v5.0.0-10.1.2] [ASVS v5.0.0-10.2.1]`, async () => {
      reset();
      const cb = await toCallback(new Browser(), 'kakao');
      const other = new Browser();
      await blocked('②', other, () => other.go(cb));
    });

    test(`I-T51 ③ ${name}: state를 바꾼 콜백은 막는다 [ASVS v5.0.0-10.2.1]`, async () => {
      reset();
      const b = new Browser();
      const cb = new URL(await toCallback(b, 'kakao'));
      cb.searchParams.set('state', `${cb.searchParams.get('state')}x`);
      const why = await blocked('③ state', b, () => b.go(cb.toString()));
      if (isC(name)) assert.match(why, /"state"/);
    });

    test(`I-T51 ③ ${name}: 다른 nonce가 든 ID 토큰은 막는다 [ASVS v5.0.0-10.5.1]`, async () => {
      reset();
      op.mode.otherNonce = true;
      try {
        const b = new Browser();
        const cb = await toCallback(b, 'kakao');
        const why = await blocked('③ nonce', b, () => b.go(cb));
        if (isC(name)) assert.match(why, /"nonce"/);
      } finally {
        reset();
      }
    });

    test(`I-T51 ③ ${name}: 다른 브라우저에서 받은 코드를 내 state로 보내도(코드 주입) 막는다 [ASVS v5.0.0-10.1.2]`, async () => {
      reset();
      const victim = new Browser();
      const attacker = new Browser();
      const cbVictim = new URL(await toCallback(victim, 'kakao'));
      const cbAttacker = new URL(await toCallback(attacker, 'kakao'));
      cbVictim.searchParams.set('code', cbAttacker.searchParams.get('code'));
      const why = await blocked('③ 코드 주입', victim, () => victim.go(cbVictim.toString()));
      if (isC(name)) assert.match(why, /invalid_grant \/ PKCE/);
    });

    test(`I-T51 ③ ${name}: 로그인 진행 쿠키를 하나씩 바꾸면 막는다(nonce·PKCE 코드 베리파이어를 담은 쿠키) [ASVS v5.0.0-10.1.2]`, async () => {
      reset();
      const probe = new Browser();
      await toCallback(probe, 'kakao');
      // 진행 상태를 담은 쿠키(Auth.js의 돌아갈 주소·CSRF 쿠키는 진행 상태가 아니라 뺀다)
      const names = [...probe.jar.values()].filter((c) => c.host === host() && !PEAKET_COOKIES.includes(c.name) && !/callback-url|csrf/i.test(c.name)).map((c) => c.name);
      assert.ok(names.length > 0, `${name}: 로그인 진행 쿠키가 없다`);
      counts[name].progressCookies = names;
      for (const n of names) {
        const b = new Browser();
        const cb = await toCallback(b, 'kakao');
        const c = [...b.jar.values()].find((x) => x.name === n && x.host === host());
        const i = Math.floor(c.value.length / 2);
        c.value = c.value.slice(0, i) + (c.value[i] === 'A' ? 'B' : 'A') + c.value.slice(i + 1);
        await blocked(`③ 쿠키 ${n}`, b, () => b.go(cb));
      }
    });

    // 막는 장치는 제공자의 '코드는 한 번만'이다(복사한 진행 쿠키는 그대로 풀린다)
    test(`I-T51 ③ ${name}: 콜백 전에 떠 둔 쿠키로 같은 콜백을 다시 보내면 세션을 만들지 않는다`, async () => {
      reset();
      const b = new Browser();
      const cb = await toCallback(b, 'google');
      const copy = new Browser();
      for (const [k, c] of b.jar) copy.jar.set(k, { ...c });
      await b.go(cb);
      assert.ok(loggedIn(b));
      await blocked('③ 재사용', copy, () => copy.go(cb));
    });

    test(`I-T51 ③ ${name}: 만료된 ID 토큰은 막는다`, async () => {
      reset();
      op.mode.expired = true;
      try {
        const b = new Browser();
        const cb = await toCallback(b, 'kakao');
        const why = await blocked('③ 만료', b, () => b.go(cb));
        if (isC(name)) assert.match(why, /"exp"|TIMESTAMP_CHECK/);
      } finally {
        reset();
      }
    });

    for (const [mode, asvs, re] of [['wrongIss', '[ASVS v5.0.0-10.2.2]', /"iss"/], ['wrongAud', '[ASVS v5.0.0-10.5.4]', /"aud"/]]) {
      test(`I-T51 ④ ${name}: ${mode === 'wrongIss' ? '다른 issuer' : '다른 aud'}의 ID 토큰은 막는다 ${asvs}`, async () => {
        reset();
        op.mode[mode] = true;
        try {
          const b = new Browser();
          const cb = await toCallback(b, 'kakao');
          const why = await blocked(`④ ${mode}`, b, () => b.go(cb));
          if (isC(name)) assert.match(why, re);
        } finally {
          reset();
        }
      });
    }

    test(`I-T51 ④ ${name}: 발견 문서의 issuer가 설정한 issuer와 다르면 로그인 시작에서 막는다 [ASVS v5.0.0-10.5.3]`, async () => {
      reset();
      op.mode.discoveryIssuer = true; // ID 토큰도 가짜 issuer로 나와, 발견 문서 대조를 빼면 받아들인다
      // 발견 문서는 앱이 처음 쓸 때 읽어 두므로 새 앱으로 본다
      const fresh = await startApp();
      try {
        const b = new Browser();
        const n0 = idp.sessions.size;
        const r0 = reasons.length;
        const s0 = await start(b, 'naver', { base: fresh.url, origin: fresh.url });
        const loc = s0.res.headers.get('location');
        // 끝까지 따라가 본다(막지 않은 구현은 여기서 세션이 생긴다)
        if (loc && [302, 303].includes(s0.res.status)) {
          const a = await b.go(new URL(loc, fresh.url).toString(), { follow: false });
          const back = a.res.headers.get('location');
          if (back) await b.go(new URL(back).toString());
        }
        counts[name].blockedReasons['④ 발견 문서 issuer'] = reasons.slice(r0);
        assert.equal(idp.sessions.size, n0, `${name}: 발견 문서 issuer가 달라도 세션이 생겼다`);
        if (isC(name)) {
          assert.ok(!loc || !loc.startsWith(op.issuer('naver')), `${name}: 로그인 시작에서 막지 않고 제공자로 보냈다`);
          assert.match(reasons.slice(r0).join(' | '), /issuer/i);
        }
      } finally {
        await fresh.close();
        reset();
      }
    });

    // 서명 검증은 구현마다 결과를 남기고(기준 ④), 후보 C에만 통과를 요구한다. 세 라이브러리 모두 기본으로는 TLS로 받은 ID 토큰의 서명을 보지 않는다
    test(`I-T51 ④ ${name}: 제공자 JWKS에 없는 키로 서명한 ID 토큰${isC(name) ? '은 막는다 [ASVS v5.0.0-6.8.2]' : '을 막는지 잰다'}`, async () => {
      reset();
      op.mode.badSignature = true;
      try {
        const b = new Browser();
        const cb = await toCallback(b, 'kakao');
        const n0 = idp.sessions.size;
        const r0 = reasons.length;
        await b.go(cb);
        counts[name].blockedReasons['④ 서명'] = reasons.slice(r0);
        counts[name].badSignatureRejected = !loggedIn(b) && idp.sessions.size === n0;
        if (isC(name)) assert.match(reasons.slice(r0).join(' | '), /signature/i);
        if (isC(name)) assert.equal(counts[name].badSignatureRejected, true);
      } finally {
        reset();
      }
    });

    test(`I-T51 ⑤ ${name}: 로그아웃하면 identity 세션이 끝나고 PEAKET 쿠키가 지워지며, 남는 identity 밖 쿠키를 센다`, async () => {
      reset();
      const b = new Browser();
      await b.go(await toCallback(b, 'kakao'));
      assert.ok(loggedIn(b));
      const s = [...idp.sessions.values()].at(-1);
      const r = await b.go(`${app.url}/logout`, { method: 'POST', headers: { origin: app.url } });
      assert.ok(r.res.status < 400, `${name} 로그아웃 ${r.res.status}`);
      assert.equal(s.active, false, 'identity 세션이 끝나야 한다');
      assert.equal(loggedIn(b), false);
      counts[name].afterLogout = outside(b);
      if (isC(name)) {
        assert.deepEqual(counts[name].afterLogin, [], `${name}: 로그인 뒤 identity 밖 쿠키`);
        assert.deepEqual(counts[name].afterLogout, [], `${name}: 로그아웃 뒤 identity 밖 쿠키`);
      }
    });

    test(`I-T51 ⑥ ${name}: 네이버는 이메일을 사용자 정보 API로 받고, 사용자 정보 id가 sub와 다르면 막는다(모의 제공자 기준)`, async () => {
      reset();
      const b = new Browser();
      await b.go(await toCallback(b, 'naver'));
      assert.ok(loggedIn(b));
      assert.equal([...idp.sessions.values()].at(-1).email, op.users.naver.email);
      op.mode.naverIdMismatch = true;
      try {
        const b2 = new Browser();
        await blocked('⑥ id 불일치', b2, async () => b2.go(await toCallback(b2, 'naver')));
      } finally {
        reset();
      }
    });
  });
}

after(() => writeFileSync(new URL('./cookie-counts.json', import.meta.url), `${JSON.stringify(counts, null, 2)}\n`));
