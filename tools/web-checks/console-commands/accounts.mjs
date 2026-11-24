// F-03-4 실제 서버 무대의 관리 계정 도우미: TOTP 코드, 브라우저 로그인, Chromium 가상 인증기(패스키).
// 값은 무대(stage.mjs)가 만든 시험 계정에서만 온다. 로그·파일·저장소에 남기지 않는다.
import { createHmac } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(value) {
  let bits = 0;
  let acc = 0;
  const out = [];
  for (const ch of value.toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('TOTP 시드가 base32가 아니다');
    acc = (acc << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** RFC 4226 HOTP 동적 자르기(identity-svc domain/totp.ts와 같은 규칙) */
export function totpAt(seed, step) {
  const key = base32Decode(seed);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

const PERIOD_MS = 30_000;
const lastStep = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 그 계정이 아직 쓰지 않은 TOTP 시간 칸의 코드. 칸 시작 3초 안이면 곧바로, 아니면 다음 칸을 기다린다.
 * 서버는 지금 칸의 코드만 받고 같은 칸을 다시 받지 않으므로, 경계에서 넘어가지 않게 칸 앞머리에 계산한다.
 */
export async function freshCode(account) {
  for (;;) {
    const now = Date.now();
    const step = Math.floor(now / PERIOD_MS);
    const into = now % PERIOD_MS;
    const used = lastStep.get(account.key) ?? -1;
    // 칸 앞머리 1.5초 안에서만 쓴다: 칸 끝에서 계산하면 서버가 다음 칸으로 읽어 코드가 틀린다
    if (step > used && into < 1_500) {
      lastStep.set(account.key, step);
      return totpAt(account.totpSeed, step);
    }
    const wait = step > used ? (into < 1_500 ? 100 : PERIOD_MS - into + 150) : PERIOD_MS - into + 150;
    await sleep(Math.max(100, wait));
  }
}

async function post(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const r = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { path, body },
  );
}

/** /login 화면에서 실제 identity-svc 로그인(비밀번호 → TOTP)을 해 쿠키를 브라우저 문맥에 넣는다 */
export async function signIn(page, account, baseUrl) {
  await page.goto(`${baseUrl}/login`);
  // 셈 저장소가 잠깐 답하지 않으면 503이므로 몇 번 다시 부른다(무대 기동 직후·부하 순간)
  let first;
  for (let i = 0; i < 4; i += 1) {
    first = await post(page, '/v1/ops/auth/sessions', { email: account.email, password: account.password });
    if (first.status !== 503) break;
    await sleep(1_500);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) first = await post(page, '/v1/ops/auth/sessions', { email: account.email, password: account.password });
    if (first.status !== 200 || first.body?.next !== 'TOTP') throw new Error(`로그인 1단계가 ${first.status}다: ${JSON.stringify(first.body)}`);
    const code = await freshCode(account);
    const second = await post(page, '/v1/ops/auth/sessions', { loginStep: first.body.loginStep, code });
    if (second.status === 200 && second.body?.next === 'DONE') {
      const me = await page.evaluate(async () => {
        const r = await fetch('/v1/ops/auth/sessions/me', { credentials: 'include' });
        return { status: r.status, body: await r.json().catch(() => null) };
      });
      if (me.status !== 200) throw new Error(`로그인은 됐는데 /sessions/me가 ${me.status}다(쿠키가 브라우저에 없다): ${JSON.stringify(me.body)}`);
      if (me.body?.role !== account.role) throw new Error(`역할이 ${me.body?.role}이다(${account.role} 기대)`);
      return me.body;
    }
    if (second.status !== 401 || attempt === 1) throw new Error(`로그인 2단계가 ${second.status}다: ${JSON.stringify(second.body)}`);
    // 같은 30초 칸의 코드를 다시 쓸 수 없어 다음 칸에서 1단계부터 다시 한다
    lastStep.delete(account.key);
    await sleep(PERIOD_MS - (Date.now() % PERIOD_MS) + 500);
  }
  throw new Error('로그인하지 못했다');
}

const b64 = (base64url) => Buffer.from(base64url, 'base64url').toString('base64');

/** Chromium 가상 인증기를 붙이고 그 계정의 패스키 자격을 넣는다(CDP WebAuthn) */
export async function installPasskey(page, account) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const pk = account.passkey;
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: b64(pk.credentialId),
      isResidentCredential: true,
      rpId: pk.rpId,
      privateKey: pk.privateKey,
      userHandle: pk.userHandle,
      // 서버에 남은 서명 횟수에서 시작한다(0에서 시작하면 퇴행으로 422 passkey-assertion-invalid가 난다)
      signCount: pk.signCount ?? 0,
    },
  });
  return { cdp, authenticatorId };
}

/** CSP·Trusted Types 위반과 만든 정책 이름을 페이지마다 모은다(콘솔 운영 빌드, F-03-1 T12와 같은 방식) */
export async function trackSecurity(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    window.__ttNames = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push({ directive: e.effectiveDirective, disposition: e.disposition, blocked: e.blockedURI, sample: (e.sample || '').slice(0, 80) }),
    );
    const tt = window.trustedTypes;
    if (tt?.createPolicy) {
      const create = tt.createPolicy.bind(tt);
      tt.createPolicy = (name, rules) => {
        window.__ttNames.push(name);
        return create(name, rules);
      };
    }
  });
  return () => page.evaluate(() => ({ violations: window.__csp ?? [], names: window.__ttNames ?? [] }));
}
