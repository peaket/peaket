// 로그인 경로 시험 도구: identity-svc SessionService 대역(gRPC, 계약 설명자로 띄운다), 쿠키 모음을 가진 브라우저 흉내.
// identity 쪽 규칙(멱등·기기 한도·연결 확인)의 정본 시험은 services/identity-svc에 있고, 이 대역은 웹 앱 서버가 보내고 받는 값만 흉내 낸다.
import { randomBytes, randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export const TOKEN_ISSUER = 'https://identity.peaket.test';
const OPTS = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

export async function startIdentityStub() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'fan-test', alg: 'ES256', use: 'sig' }] };
  const accounts = new Map(); // `${provider}|${sub}` → accountId
  const sessions = new Map(); // sessionId → { accountId, ended }
  const keys = new Map(); // 멱등 키 → { provider, sub, sessionId }
  const calls = [];
  const mode = { endFails: false, createFails: false, proposeFor: null, addResult: null, addFails: false };
  const sign = (sub, sid, typ = 'at+jwt', expSec = 900, at = Date.now()) =>
    new SignJWT({ sid })
      .setProtectedHeader({ alg: 'ES256', typ, kid: 'fan-test' })
      .setIssuer(TOKEN_ISSUER)
      .setSubject(sub)
      .setAudience('fan')
      .setIssuedAt(Math.floor(at / 1000))
      .setExpirationTime(Math.floor(at / 1000) + expSec)
      .sign(privateKey);
  const fail = (cb, code, details) => cb({ code: grpc.status[code], details });
  const proposals = new Map();
  const sessionOf = async (accountId, sessionId) => {
    const now = Date.now();
    return {
      account_id: accountId,
      session_id: sessionId,
      access_token: await sign(accountId, sessionId),
      access_token_expires_at_ms: now + 900_000,
      refresh_token: `rt-${randomUUID()}`,
      refresh_token_expires_at_ms: now + 14 * 86_400_000,
    };
  };

  const def = protoLoader.fromJSON(identityV1Identity, OPTS);
  const pkg = grpc.loadPackageDefinition(def).peaket.identity.v1;
  const server = new grpc.Server();
  server.addService(pkg.SessionService.service, {
    async CreateSession(call, cb) {
      const r = call.request;
      calls.push({ method: 'CreateSession', request: r });
      if (mode.createFails) return fail(cb, 'UNAVAILABLE', '대역 장애');
      const seen = keys.get(r.idempotency_key);
      if (seen && (seen.provider !== r.provider || seen.sub !== r.provider_user_id)) return fail(cb, 'ALREADY_EXISTS', '다른 내용');
      const k = `${r.provider}|${r.provider_user_id}`;
      let linked = 'PROVIDER_UNSPECIFIED';
      if (r.link_proposal_id) {
        // 연결 제안을 따라 온 로그인(identity §2.1): 묶음 값이 맞고, 이 계정이 제안의 대상이면 새 제공자를 잇는다
        const p = proposals.get(r.link_proposal_id);
        if (!p || p.binding !== r.link_binding) return fail(cb, 'NOT_FOUND', '연결 제안 없음');
        if (accounts.get(k) === undefined || accounts.get(k) !== accounts.get(p.target)) {
          p.attempts += 1;
          if (p.attempts >= 3) proposals.delete(r.link_proposal_id);
          return cb(null, { link_mismatch: { attempts_left: Math.max(0, 3 - p.attempts) }, new_account: false });
        }
        if (!accounts.has(p.newKey)) {
          accounts.set(p.newKey, accounts.get(k));
          linked = p.newProvider;
        }
        proposals.delete(r.link_proposal_id);
      } else if (!accounts.has(k) && r.email_verified && mode.proposeFor && r.email === mode.proposeFor.email) {
        // 같은 이메일의 계정이 있다고 흉내 낸다(mode.proposeFor.target = 'PROVIDER_KAKAO|4000001')
        const id = randomBytes(16).toString('base64url');
        const binding = randomBytes(32).toString('base64url');
        proposals.set(id, { binding, target: mode.proposeFor.target, newKey: k, newProvider: r.provider, email: r.email, attempts: 0, expiresAt: Date.now() + 600_000 });
        return cb(null, { link_proposal_id: id, link_binding: binding, new_account: false });
      }
      const newAccount = !accounts.has(k);
      if (newAccount) accounts.set(k, randomUUID());
      const accountId = accounts.get(k);
      const sessionId = seen?.sessionId ?? randomUUID();
      sessions.set(sessionId, { accountId, ended: false });
      keys.set(r.idempotency_key, { provider: r.provider, sub: r.provider_user_id, sessionId });
      cb(null, { session: await sessionOf(accountId, sessionId), new_account: newAccount, linked_provider: linked });
    },
    AddProvider(call, cb) {
      const r = call.request;
      calls.push({ method: 'AddProvider', request: r });
      if (mode.addFails) return fail(cb, 'UNAVAILABLE', '대역 장애');
      const s = sessions.get(r.session_id);
      if (!s || s.ended || s.accountId !== r.account_id || !r.reauth_token) return cb(null, { result: 'ADD_PROVIDER_RESULT_REAUTH_REQUIRED' });
      if (mode.addResult) return cb(null, { result: mode.addResult });
      const k = `${r.provider}|${r.provider_user_id}`;
      if (accounts.has(k)) return cb(null, { result: accounts.get(k) === r.account_id ? 'ADD_PROVIDER_RESULT_ALREADY_LINKED' : 'ADD_PROVIDER_RESULT_OTHER_ACCOUNT' });
      accounts.set(k, r.account_id);
      cb(null, { result: 'ADD_PROVIDER_RESULT_LINKED' });
    },
    GetLinkProposal(call, cb) {
      const r = call.request;
      calls.push({ method: 'GetLinkProposal', request: r });
      const p = proposals.get(r.link_proposal_id);
      if (!p || p.binding !== r.link_binding) return fail(cb, 'NOT_FOUND', '연결 제안 없음');
      cb(null, { existing_provider: p.target.split('|')[0], new_provider: p.newProvider, expires_at_ms: p.expiresAt, attempts_left: 3 - p.attempts });
    },
    async SeparateAccount(call, cb) {
      const r = call.request;
      calls.push({ method: 'SeparateAccount', request: r });
      const p = proposals.get(r.link_proposal_id);
      if (!p || p.binding !== r.link_binding) return fail(cb, 'NOT_FOUND', '연결 제안 없음');
      proposals.delete(r.link_proposal_id);
      const newAccount = !accounts.has(p.newKey);
      if (newAccount) accounts.set(p.newKey, randomUUID());
      const accountId = accounts.get(p.newKey);
      const sessionId = randomUUID();
      sessions.set(sessionId, { accountId, ended: false });
      cb(null, { session: await sessionOf(accountId, sessionId), new_account: newAccount, linked_provider: 'PROVIDER_UNSPECIFIED' });
    },
    EndSession(call, cb) {
      calls.push({ method: 'EndSession', request: call.request });
      if (mode.endFails) return fail(cb, 'UNAVAILABLE', '대역 장애');
      const s = sessions.get(call.request.session_id);
      if (!s) return fail(cb, 'NOT_FOUND', '없음');
      if (s.accountId !== call.request.account_id) return fail(cb, 'FAILED_PRECONDITION', '다른 계정');
      const ended = !s.ended;
      s.ended = true;
      cb(null, { ended });
    },
    IssueReauthToken(call, cb) {
      const r = call.request;
      calls.push({ method: 'IssueReauthToken', request: r });
      const s = sessions.get(r.session_id);
      if (!s || s.ended || s.accountId !== r.account_id) return fail(cb, 'FAILED_PRECONDITION', '세션 아님');
      if (accounts.get(`${r.provider}|${r.provider_user_id}`) !== r.account_id) return cb(null, { result: 'REAUTH_RESULT_ACCOUNT_MISMATCH' });
      // 대역의 세션은 모두 로그인 판정이 UNKNOWN이다(identity §7.1 ③)
      if (r.purpose === 'REAUTH_PURPOSE_HIGH_RISK' && r.strength === 'REAUTH_STRENGTH_REQUESTED') return cb(null, { result: 'REAUTH_RESULT_REVERIFY_REQUIRED' });
      cb(null, { result: 'REAUTH_RESULT_ISSUED', reauth_token: `reauth.${r.strength}.${r.provider}.${randomUUID()}`, reauth_token_expires_at_ms: Date.now() + 300_000 });
    },
  });
  const port = await new Promise((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  return {
    address: `127.0.0.1:${port}`,
    jwks,
    calls,
    mode,
    sessions,
    accounts,
    proposals,
    /** 시험이 직접 만든 액세스 토큰(만료된 것 등) */
    sign,
    close: () => new Promise((r) => server.tryShutdown(() => r())),
  };
}

/** 브라우저 흉내: 쿠키 모음(이름·경로·만료만 본다. 시험은 http라 Secure는 보지 않는다) */
export class Browser {
  constructor() {
    this.jar = new Map();
  }
  store(url, setCookies) {
    const host = new URL(url).host;
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';').map((s) => s.trim());
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      const a = Object.fromEntries(
        attrs.map((x) => {
          const j = x.indexOf('=');
          return j < 0 ? [x.toLowerCase(), true] : [x.slice(0, j).toLowerCase(), x.slice(j + 1)];
        }),
      );
      const path = a.path ?? '/';
      const key = `${host}|${path}|${name}`;
      const expired = a['max-age'] !== undefined && Number(a['max-age']) <= 0;
      if (expired || value === '') this.jar.delete(key);
      else this.jar.set(key, { name, value, host, path, attrs: a, raw: sc });
    }
  }
  cookieHeader(url) {
    const u = new URL(url);
    return [...this.jar.values()]
      .filter((c) => c.host === u.host && u.pathname.startsWith(c.path))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
  get(name) {
    return [...this.jar.values()].find((c) => c.name === name);
  }
  names() {
    return [...this.jar.values()].map((c) => c.name).sort();
  }
  /** 쿠키 모음과 함께 요청하고, follow면 리디렉션을 따라간다. 지나간 주소와 Location을 돌려준다 */
  async go(url, { method = 'GET', headers = {}, body, follow = true, max = 10 } = {}) {
    const trail = [];
    for (let n = 0; n < max; n++) {
      const h = new Headers(headers);
      const ck = this.cookieHeader(url);
      if (ck) h.set('cookie', ck);
      const r = await fetch(url, { method, headers: h, body, redirect: 'manual' });
      this.store(url, r.headers.getSetCookie());
      const loc = r.headers.get('location');
      trail.push({ url, status: r.status, location: loc, setCookie: r.headers.getSetCookie() });
      if (!follow || !loc || ![301, 302, 303, 307, 308].includes(r.status)) return { res: r, text: await r.text(), trail, url };
      url = new URL(loc, url).toString();
      method = 'GET';
      body = undefined;
      headers = {};
    }
    throw new Error('리디렉션이 너무 많다');
  }
}

/** 폼 POST 머리(Origin은 시험이 정한다)와 본문 */
export const formPost = (origin, fields) => ({
  method: 'POST',
  headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});
