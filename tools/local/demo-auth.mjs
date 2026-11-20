// BAT-087 데모 인증 도우미(로컬 데모 전용). OIDC 제공자를 올리지 않고 S1~S9의 로그인 상태를 만든다.
// - 팬: identity gRPC CreateSession(호스트 19051 → NodePort 30051)으로 계정·세션을 만들고 쿠키를 낸다
// - 관리·파트너: 공개 로그인 API(비밀번호 → TOTP)를 불러 Set-Cookie를 그대로 낸다
// - 패스키: 시드가 만든 자격 ID·개인키(PKCS8)·COSE 공개키를 읽어 Playwright CDP WebAuthn.addCredential 입력으로 낸다
// - 값은 `.cache/peaket-tools/demo-secrets/`(0600)에만 쓴다. 표준 출력·로그·측정에는 비밀을 싣지 않는다
// 쓰는 법:
//   node tools/local/demo-auth.mjs prepare [--seed <파일>]    (demo·demo-seed가 먼저 부른다. 없으면 새로 만든다)
//   node tools/local/demo-auth.mjs fan <accountKey>
//   node tools/local/demo-auth.mjs admin <accountKey>
//   node tools/local/demo-auth.mjs passkey <accountKey>
// 계약: 표준 출력 한 줄 JSON { accountKey, kind, cookies: [{ name, value, domain, path, secure, httpOnly, sameSite }], passkey? }
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { publicJwksOf } from './v0-token.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEMO_SECRETS_FILE = join(REPO, '.cache', 'peaket-tools', 'demo-secrets', 'secrets.json');
export const DEMO_SESSIONS_FILE = join(REPO, '.cache', 'peaket-tools', 'demo-secrets', 'sessions.json');
export const DEMO_CONTRACT_FILE = join(REPO, '.cache', 'peaket-tools', 'demo-contract.json');
export const DEMO_SEED_FILE = join(REPO, 'deploy', 'envs', 'demo', 'seed', 'base.yaml');

/** 모의 OIDC 대신 쓰는 제공자 번호(proto의 Provider enum: KAKAO=1, NAVER=2, GOOGLE=3, APPLE=4 [확인]) */
const PROVIDER = { KAKAO: 1, NAVER: 2, GOOGLE: 3, APPLE: 4 };

const b64u = (b) => Buffer.from(b).toString('base64url');
const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** base32(RFC 4648, 패딩 없음). TOTP 시드 표시에만 쓴다 */
function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += b32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += b32[(value << (5 - bits)) & 31];
  return out;
}

/** 결정적 UUID(같은 키를 두 번 넣지 않게). UUID v4 꼴로 만든다 */
export function demoUuid(label) {
  const h = createHash('sha256').update(`peaket-demo:${label}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const s = b.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** EC P-256 키 한 쌍을 CDP WebAuthn.addCredential 입력으로 만든다 */
function passkeyMaterial(name) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = /** @type {{ x: string, y: string }} */ (publicKey.export({ format: 'jwk' }));
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  // COSE_Key(EC2, P-256, ES256): {1:2, 3:-7, -1:1, -2:x, -3:y}. CBOR로 77바이트
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  return {
    name,
    credentialId: b64u(randomBytes(32)),
    privateKeyPkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKeyCose: cose.toString('base64'),
    aaguid: demoUuid(`aaguid:${name}`),
  };
}

/** 시드 YAML을 읽고 참조를 검사한다(두 번 적용해도 같은 키를 쓰게 key를 그대로 둔다) */
export function readSeed(file = DEMO_SEED_FILE) {
  const seed = parseYaml(readFileSync(file, 'utf8'));
  if (seed?.version !== 1) throw new Error(`${file}: version은 1이다`);
  const accounts = new Map(seed.accounts.map((a) => [a.key, a]));
  if (accounts.size !== seed.accounts.length) throw new Error(`${file}: account key가 겹친다`);
  const promoters = new Map((seed.promoters ?? []).map((p) => [p.key, p]));
  for (const p of seed.promoters ?? []) if (!accounts.has(p.partnerAdminKey)) throw new Error(`${file}: promoter ${p.key}의 partnerAdminKey(${p.partnerAdminKey})가 없다`);
  for (const a of seed.accounts) if (a.promoterKey && !promoters.has(a.promoterKey)) throw new Error(`${file}: account ${a.key}의 promoterKey(${a.promoterKey})가 없다`);
  const productions = new Map((seed.productions ?? []).map((p) => [p.key, p]));
  for (const p of seed.productions ?? []) if (!promoters.has(p.promoterKey)) throw new Error(`${file}: production ${p.key}의 promoterKey(${p.promoterKey})가 없다`);
  const events = new Map((seed.events ?? []).map((e) => [e.key, e]));
  for (const e of seed.events ?? []) if (!productions.has(e.productionKey)) throw new Error(`${file}: event ${e.key}의 productionKey(${e.productionKey})가 없다`);
  const seatMaps = new Map((seed.seatMaps ?? []).map((s) => [s.key, s]));
  for (const s of seed.seatMaps ?? []) {
    if (!events.has(s.eventKey)) throw new Error(`${file}: seatMap ${s.key}의 eventKey(${s.eventKey})가 없다`);
    if (s.copyOf && !seatMaps.has(s.copyOf)) throw new Error(`${file}: seatMap ${s.key}의 copyOf(${s.copyOf})가 없다`);
  }
  for (const s of seed.staff ?? []) {
    if (!events.has(s.eventKey)) throw new Error(`${file}: staff ${s.key}의 eventKey(${s.eventKey})가 없다`);
    if (!accounts.has(s.accountKey)) throw new Error(`${file}: staff ${s.key}의 accountKey(${s.accountKey})가 없다`);
  }
  for (const p of seed.adminPasskeys ?? []) if (!accounts.has(p.accountKey)) throw new Error(`${file}: adminPasskey의 accountKey(${p.accountKey})가 없다`);
  return seed;
}

/**
 * 데모 비밀을 읽거나 새로 만든다(0600). 같은 파일을 두 번 쓰지 않는다(멱등).
 * @param {{ seedFile?: string }} [o]
 * @returns {{ secrets: any, bootstrap: any }}
 */
export function prepareDemoSecrets(o = {}) {
  const seedFile = o.seedFile ?? DEMO_SEED_FILE;
  const seed = readSeed(seedFile);
  if (existsSync(DEMO_SECRETS_FILE)) {
    const secrets = JSON.parse(readFileSync(DEMO_SECRETS_FILE, 'utf8'));
    // 예전 파일(이 묶음 전)에는 identity의 연계정보·pid 키가 없다. 새로 만들지 않고 채워 넣는다(멱등)
    let changed = false;
    if (!secrets.pidHmacKey) {
      secrets.pidHmacKey = randomBytes(32).toString('base64');
      changed = true;
    }
    if (!secrets.ciHmacKey) {
      secrets.ciHmacKey = randomBytes(32).toString('base64');
      changed = true;
    }
    if (changed) writeFileSync(DEMO_SECRETS_FILE, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    return { secrets, bootstrap: bootstrapOf(seed, secrets, seedFile) };
  }
  const fan = randomJwk();
  const admin = randomJwk();
  const staff = randomJwk();
  const admission = randomJwk();
  const ecdh = randomJwk();
  const secrets = {
    version: 1,
    dbPassword: randomBytes(18).toString('base64url'),
    idvSecret: randomBytes(32).toString('base64'),
    pgSim: { secretKey: `sim_sk_${randomBytes(18).toString('hex')}`, clientKey: `sim_ck_${randomBytes(12).toString('hex')}` },
    tokenKeys: {
      fan: { privateJwk: fan.privateJwk },
      admin: { privateJwk: admin.privateJwk },
      staff: { privateJwk: staff.privateJwk },
      admission: { privateJwk: admission.privateJwk },
      ecdh: { privateJwk: ecdh.privateJwk, publicJwk: publicPart(ecdh.privateJwk) },
    },
    pepperKey: randomBytes(32).toString('base64'),
    totpKey: randomBytes(32).toString('base64'),
    // identity의 연계정보(CI)·pid HMAC 키(local·ci·demo 전용, 운영은 KMS). 둘은 달라야 한다
    pidHmacKey: randomBytes(32).toString('base64'),
    ciHmacKey: randomBytes(32).toString('base64'),
    internalToken: randomBytes(32).toString('base64url'),
    queueTokenKey: `demoq${randomBytes(8).toString('hex')}:${randomBytes(32).toString('base64')}`,
    admission: { privateJwk: admission.privateJwk, jwks: publicJwksOf(admission.privateJwk) },
    ecdh: { privateJwk: ecdh.privateJwk, publicJwk: publicPart(ecdh.privateJwk) },
    batchRandomness: randomBytes(32).toString('base64'),
    accounts: {},
    passkeys: {},
  };
  for (const a of seed.accounts) {
    if (a.kind === 'admin') secrets.accounts[a.key] = { password: randomBytes(18).toString('base64url'), totpSeed: base32(randomBytes(20)) };
  }
  for (const p of seed.adminPasskeys ?? []) secrets.passkeys[p.accountKey] = passkeyMaterial(p.name);
  mkdirSync(dirname(DEMO_SECRETS_FILE), { recursive: true });
  writeFileSync(DEMO_SECRETS_FILE, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  return { secrets, bootstrap: bootstrapOf(seed, secrets, seedFile) };
}

function randomJwk() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = /** @type {{ x: string, y: string, d: string }} */ (privateKey.export({ format: 'jwk' }));
  return { privateJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, kid: `demo-${randomBytes(4).toString('hex')}` } };
}

const publicPart = (jwk) => ({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: jwk.kid });

/**
 * 부트스트랩 값(첫 관리자·패스키·promoter). 감사 기록 없음 — 로컬 데모 전용 예외다.
 * 비밀번호·TOTP 시드는 값이 아니라 이 JSON(Secret demo-bootstrap)에만 있다.
 */
export function bootstrapOf(seed, secrets, seedFile = DEMO_SEED_FILE) {
  const promoterIds = Object.fromEntries((seed.promoters ?? []).map((p) => [p.key, demoUuid(`promoter:${p.key}`)]));
  const accounts = seed.accounts
    .filter((a) => a.kind === 'admin')
    .map((a) => {
      const s = secrets.accounts[a.key];
      const pk = secrets.passkeys[a.key];
      return {
        key: a.key,
        id: demoUuid(`admin:${a.key}`),
        email: a.email,
        displayName: a.displayName,
        role: a.role,
        ...(a.promoterKey ? { promoterId: promoterIds[a.promoterKey] } : {}),
        password: s.password,
        totpSeed: s.totpSeed,
        passkeys: pk ? [{ name: pk.name, credentialId: pk.credentialId, publicKeyCose: pk.publicKeyCose, aaguid: pk.aaguid }] : [],
      };
    });
  return {
    version: 1,
    seedFile: seedFile.replaceAll('\\', '/'),
    promoters: (seed.promoters ?? []).map((p) => ({ key: p.key, id: promoterIds[p.key], legalName: p.legalName })),
    accounts,
  };
}

/** TOTP(6자리, 30초, SHA1) — identity-svc의 domain/totp.ts와 같은 규칙 */
export function totpAt(seedBase32, nowMs = Date.now()) {
  const seed = base32Decode(seedBase32);
  const step = Math.floor(nowMs / 1000 / 30);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', seed).update(counter).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

function base32Decode(s) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s.toUpperCase().replace(/=+$/, '')) {
    const i = b32.indexOf(ch);
    if (i < 0) throw new Error('TOTP 시드가 base32가 아니다');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 데모 접속 정보(없으면 기본 포트·호스트를 쓴다). cluster.mjs demo가 쓴다 */
export function readContract() {
  if (existsSync(DEMO_CONTRACT_FILE)) return JSON.parse(readFileSync(DEMO_CONTRACT_FILE, 'utf8'));
  return { ports: { 'partner-api': 18443, 'ops-api': 18444 }, hosts: { 'partner-api': 'partner-api.peaket.example', 'ops-api': 'ops-api.peaket.example' }, grpcPort: 19051 };
}

/**
 * HTTPS 요청(자체 서명 인증서, Host로 정본 이름을 보낸다). 303·302를 따라가지 않는다(로그인 응답의 Set-Cookie만 본다).
 * @param {{ host: string, port: number, method: string, path: string, body?: unknown, headers?: Record<string,string> }} o
 */
export function httpsJson(o) {
  return new Promise((resolve, reject) => {
    const payload = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body));
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: o.port,
        method: o.method,
        path: o.path,
        servername: o.host,
        rejectUnauthorized: false,
        headers: {
          host: `${o.host}:${o.port}`,
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...o.headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Set-Cookie 머리들을 Playwright 쿠키 모양으로 */
export function cookiesOf(setCookie, host) {
  const out = [];
  for (const line of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at);
    const value = pair.slice(at + 1);
    const a = Object.fromEntries(attrs.map((x) => {
      const i = x.indexOf('=');
      return i < 0 ? [x.toLowerCase(), true] : [x.slice(0, i).toLowerCase(), x.slice(i + 1)];
    }));
    out.push({
      name,
      value,
      domain: a.domain ?? host,
      path: a.path ?? '/',
      ...(a.expires ? { expires: Date.parse(a.expires) } : {}),
      secure: Boolean(a.secure),
      httpOnly: Boolean(a.httponly),
      sameSite: a.samesite ? String(a.samesite)[0].toUpperCase() + String(a.samesite).slice(1).toLowerCase() : 'Strict',
    });
  }
  return out;
}

/**
 * 관리 로그인(비밀번호 → TOTP). 파트너는 partner-api, 관제는 ops-api.
 * @param {'partner'|'ops'} aud @param {string} email @param {string} password @param {string} totpSeed
 */
export async function adminLogin(aud, email, password, totpSeed) {
  const c = readContract();
  const key = aud === 'partner' ? 'partner-api' : 'ops-api';
  const base = { host: c.hosts[key], port: c.ports[key] };
  // 브라우저와 같은 출처 머리를 보낸다(게이트웨이 CSRF·CORS가 출처를 본다)
  const headers = { origin: c.origins?.[aud === 'partner' ? 'partner' : 'console'] ?? (aud === 'partner' ? 'https://partner.peaket.example:18443' : 'https://console.peaket.example:18444'), 'sec-fetch-site': 'same-origin' };
  const path = aud === 'partner' ? '/v1/partner/auth/sessions' : '/v1/ops/auth/sessions';
  // 같은 TOTP 칸(30초)의 코드를 두 번 쓰면 서버가 재사용으로 401을 낸다.
  // 시드 직후 재생기가 곧바로 로그인하는 경우가 있어, 401이면 다음 칸까지 기다렸다가 1단계부터 다시 한다
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const first = await httpsJson({ ...base, headers, method: 'POST', path, body: { email, password } });
    if (first.status !== 401 && first.status !== 200) return { ok: false, reason: `1단계 ${first.status}`, response: first };
    const loginStep = first.json?.loginStep ?? first.json?.challenge?.loginStep;
    if (!loginStep) return { ok: false, reason: `1단계 응답에 loginStep이 없다(${first.status})`, response: first };
    const second = await httpsJson({ ...base, headers, method: 'POST', path, body: { loginStep, code: totpAt(totpSeed) } });
    if (second.status >= 200 && second.status < 300) return { ok: true, status: second.status, cookies: cookiesOf(second.headers['set-cookie'], base.host) };
    if (second.status !== 401 || attempt > 0) return { ok: false, reason: `2단계 ${second.status}`, response: second };
    const waitMs = 30_000 - (Date.now() % 30_000) + 1_000;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return { ok: false, reason: '2단계 401' };
}

/** gRPC CreateSession 클라이언트(팬). @grpc 모듈은 뿌리 개발 의존성이다 */
async function createSession(account) {
  const grpc = await import('@grpc/grpc-js');
  const loader = await import('@grpc/proto-loader');
  const def = loader.loadSync(join(REPO, 'docs', 'api', 'proto', 'peaket', 'identity', 'v1', 'identity.proto'), { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  const pkg = grpc.loadPackageDefinition(def);
  const SessionService = pkg.peaket.identity.v1.SessionService;
  const c = readContract();
  const client = new SessionService(`127.0.0.1:${c.grpcPort ?? 19051}`, grpc.credentials.createInsecure());
  try {
    const res = await new Promise((resolve, reject) => {
      const call = client.CreateSession ?? client.createSession;
      call.call(
        client,
        {
          idempotency_key: `demo-${account.key}-${randomBytes(8).toString('hex')}`,
          provider: PROVIDER[account.provider] ?? 1,
          provider_user_id: account.providerUserId,
          email: account.email,
          email_verified: true,
        },
        (err, value) => (err ? reject(err) : resolve(value)),
      );
    });
    return res?.session;
  } finally {
    client.close();
  }
}

/**
 * 데모 인증 한 번. 표준 출력 한 줄 JSON을 돌려준다(파일에도 쓴다).
 * @param {'fan'|'admin'|'passkey'} kind @param {string} accountKey
 */
export async function demoAuth(kind, accountKey) {
  const seed = readSeed();
  const account = seed.accounts.find((a) => a.key === accountKey);
  if (!account) throw new Error(`시드에 없는 계정: ${accountKey}`);
  const { secrets } = prepareDemoSecrets();
  // 패스키 rpId는 계정 역할이 속한 콘솔의 호스트다(파트너 관리자는 partner, 나머지는 console, RV-07)
  const rpIdOf = (a) => (a.role === 'partner_admin' || a.role === 'partner_member' ? 'partner.peaket.example' : 'console.peaket.example');
  if (kind === 'passkey') {
    const pk = secrets.passkeys[accountKey];
    if (!pk) throw new Error(`${accountKey}에 패스키 시드가 없다`);
    return { accountKey, kind: 'passkey', passkey: { rpId: rpIdOf(account), credentialId: pk.credentialId, privateKey: pk.privateKeyPkcs8, userHandle: Buffer.from(demoUuid(`admin:${accountKey}`).replaceAll('-', ''), 'hex').toString('base64'), name: pk.name } };
  }
  if (account.kind === 'fan') {
    if (kind !== 'fan') throw new Error(`${accountKey}는 팬 계정이다(demo-auth fan …)`);
    const session = await createSession(account);
    if (!session?.access_token) throw new Error('CreateSession 응답에 세션이 없다(연결 확인)');
    const domain = 'peaket.example';
    return {
      accountKey,
      kind: 'fan',
      accountId: session.account_id,
      cookies: [
        { name: '__Secure-peaket_at', value: session.access_token, domain, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' },
        { name: '__Secure-peaket_rt', value: session.refresh_token, domain, path: '/v1/identity/access-tokens', secure: true, httpOnly: true, sameSite: 'Strict' },
      ],
    };
  }
  if (kind !== 'admin') throw new Error(`${accountKey}는 관리 계정이다(demo-auth admin …)`);
  const aud = account.role === 'partner_admin' || account.role === 'partner_member' ? 'partner' : 'ops';
  const s = secrets.accounts[accountKey];
  const login = await adminLogin(aud, account.email, s.password, s.totpSeed);
  if (!login.ok) throw new Error(`${accountKey} 로그인 실패: ${login.reason}`);
  const pk = secrets.passkeys[accountKey];
  return {
    accountKey,
    kind: 'admin',
    aud,
    cookies: login.cookies,
    ...(pk ? { passkey: { rpId: rpIdOf(account), credentialId: pk.credentialId, privateKey: pk.privateKeyPkcs8, userHandle: Buffer.from(demoUuid(`admin:${accountKey}`).replaceAll('-', ''), 'hex').toString('base64'), name: pk.name } } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , cmd, arg] = process.argv;
  if (cmd === 'prepare') {
    const { secrets, bootstrap } = prepareDemoSecrets();
    console.log(JSON.stringify({ secretsFile: DEMO_SECRETS_FILE.replaceAll('\\', '/'), accounts: Object.keys(secrets.accounts).length, passkeys: Object.keys(secrets.passkeys).length, promoters: bootstrap.promoters.length }));
    process.exit(0);
  }
  if (!['fan', 'admin', 'passkey'].includes(cmd) || !arg) {
    console.error('쓰는 법: node tools/local/demo-auth.mjs prepare|fan <accountKey>|admin <accountKey>|passkey <accountKey>');
    process.exit(2);
  }
  const result = await demoAuth(cmd, arg);
  mkdirSync(dirname(DEMO_SESSIONS_FILE), { recursive: true });
  const sessions = existsSync(DEMO_SESSIONS_FILE) ? JSON.parse(readFileSync(DEMO_SESSIONS_FILE, 'utf8')) : {};
  sessions[`${cmd}:${arg}`] = result;
  writeFileSync(DEMO_SESSIONS_FILE, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
}
