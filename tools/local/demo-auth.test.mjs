// BAT-087 데모 인증 도우미의 계약(팬·관리·패스키)을 단위로 본다.
// 정본: docs/review/plans/BAT-087.md §5 '인증 도우미 계약', §6 DS-12, 감독 결정 5·7.
// 실제 gRPC·게이트웨이 로그인은 kind e2e(DS-08·09)가 본다. 여기서는 값의 모양·TOTP·쿠키·부트스트랩 행만 본다.
// W12S-04(서버 액션 키를 비밀 파일에서 만들기)·W12S-06(데모 HTTPS 요청의 인증서 확인)은 docs/review/plans/W12-ci-sec.md §3.
// W12T-01 ②~④(비밀 파일은 새로 만들 때와 다시 쓸 때 모두 0600)는 docs/review/plans/W12-tools.md §3.
// 실행(저장소 뿌리): node --test "tools/local/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkServerActionsKey } from '../../packages/config/next/server-actions-key.mjs';
import { DEMO_SECRETS_FILE, bootstrapOf, cookiesOf, demoAuth, demoUuid, httpsJson, prepareDemoSecrets, totpAt, readSeed } from './demo-auth.mjs';
import { gatewayCertArgs } from './gateway-objects.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const seed = readSeed();
const admins = seed.accounts.filter((a) => a.kind === 'admin');

/** 가짜 비밀(값은 시험용이며 저장소·.cache에 쓰지 않는다) */
function fakeSecrets() {
  const accounts = Object.fromEntries(admins.map((a) => [a.key, { password: `pw-${a.key}`, totpSeed: 'JBSWY3DPEHPK3PXP' }]));
  const passkeys = Object.fromEntries(
    (seed.adminPasskeys ?? []).map((p) => [p.accountKey, { name: p.name, credentialId: `cred-${p.accountKey}`, publicKeyCose: 'cose', aaguid: demoUuid(`aaguid:${p.accountKey}`) }]),
  );
  return { accounts, passkeys };
}

test('데모 인증 계약: 팬은 gRPC CreateSession, 관리·파트너는 공개 로그인 API, 패스키는 CDP 입력이다', async () => {
  // 계정 종류와 부르는 길이 어긋나면 까닭을 낸다(잘못된 계정으로 세션을 만들지 않는다)
  await assert.rejects(demoAuth('admin', 'jimin'), /팬 계정이다/);
  await assert.rejects(demoAuth('fan', 'sujin'), /관리 계정이다/);
  await assert.rejects(demoAuth('passkey', 'jimin'), /패스키 시드가 없다/);

  // 패스키 하나의 계약: rpId·credentialId·PKCS8 개인키·userHandle·이름. 비밀번호·TOTP는 싣지 않는다
  const out = await demoAuth('passkey', 'sujin');
  assert.equal(out.accountKey, 'sujin');
  assert.equal(out.kind, 'passkey');
  assert.equal(out.passkey.rpId, 'console.peaket.example');
  assert.ok(out.passkey.credentialId, 'credentialId');
  assert.ok(out.passkey.privateKey, 'privateKey(PKCS8)');
  assert.match(out.passkey.userHandle, /^[A-Za-z0-9+/]+=*$/, 'userHandle은 base64');
  assert.equal(out.passkey.name, seed.adminPasskeys.find((p) => p.accountKey === 'sujin')?.name);
  assert.equal(Object.hasOwn(out, 'password'), false, '패스키 결과에 비밀번호가 있다');
  assert.equal(Object.hasOwn(out, 'totpSeed'), false, '패스키 결과에 TOTP 시드가 있다');
  // 파트너 관리자는 파트너 콘솔의 rpId를 낸다(콘솔 rpId를 내면 파트너 WebAuthn이 거부한다, RV-07)
  const partner = await demoAuth('passkey', 'stella-admin');
  assert.equal(partner.passkey.rpId, 'partner.peaket.example', '파트너 관리자 패스키의 rpId');
});

test('데모 인증 계약: 부트스트랩은 관리 계정 전부·promoter·패스키 공개 부분만 만든다', () => {
  const bootstrap = bootstrapOf(seed, fakeSecrets());
  assert.equal(bootstrap.version, 1);
  assert.equal(bootstrap.promoters.length, 1);
  assert.equal(bootstrap.promoters[0].key, 'stella');
  assert.match(bootstrap.promoters[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(bootstrap.accounts.length, admins.length);
  for (const a of bootstrap.accounts) {
    assert.ok(a.password && a.totpSeed, `${a.key}의 부트스트랩 비밀`);
    assert.ok(Array.isArray(a.passkeys), `${a.key}의 passkeys`);
    for (const p of a.passkeys) {
      assert.equal(Object.hasOwn(p, 'privateKey'), false, `${a.key} 패스키에 개인키가 있다(부트스트랩에는 공개 부분만)`);
      assert.ok(p.credentialId && p.publicKeyCose, `${a.key} 패스키 공개 부분`);
    }
  }
  // 패스키가 있는 계정만 자격을 싣는다
  for (const key of ['sujin', 'second-commander', 'stella-admin']) assert.equal(bootstrap.accounts.find((a) => a.key === key)?.passkeys.length, 1, `${key} 패스키`);
  for (const key of ['minho', 'seoyeon', 'daeun', 'jun']) assert.equal(bootstrap.accounts.find((a) => a.key === key)?.passkeys.length, 0, `${key}는 패스키가 없다`);
  // 같은 시드·비밀이면 같은 ID(두 번 넣어도 키가 같다)
  assert.deepEqual(bootstrapOf(seed, fakeSecrets()), bootstrap);
});

test('데모 인증 계약: TOTP는 identity-svc와 같은 6자리·30초·SHA1 규칙이다', () => {
  // RFC 6238 SHA1 표본(ASCII "12345678901234567890"의 base32), 59초 → 8자리 94287082의 6자리
  assert.equal(totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');
  assert.match(totpAt('JBSWY3DPEHPK3PXP'), /^\d{6}$/);
});

test('데모 인증 계약: Set-Cookie를 Playwright 쿠키 모양으로 옮긴다', () => {
  const [c] = cookiesOf('__Secure-peaket_at=abc.def; Path=/v1/identity/access-tokens; Domain=.peaket.example; Secure; HttpOnly; SameSite=Lax; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'www.peaket.example');
  assert.deepEqual(c, {
    name: '__Secure-peaket_at',
    value: 'abc.def',
    domain: '.peaket.example',
    path: '/v1/identity/access-tokens',
    expires: Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'),
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  });
  const [d] = cookiesOf('a=1', 'api.peaket.example');
  assert.deepEqual(d, { name: 'a', value: '1', domain: 'api.peaket.example', path: '/', secure: false, httpOnly: false, sameSite: 'Strict' });
  assert.deepEqual(cookiesOf(undefined, 'x'), []);
});

test('데모 인증 계약: 결정적 UUID는 v4 꼴이고 같은 이름에 같은 값이다', () => {
  const a = demoUuid('admin:sujin');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, demoUuid('admin:sujin'));
  assert.notEqual(a, demoUuid('admin:minho'));
});

// ---------- W12S-04 서버 액션 키는 데모 비밀 파일에서 무작위로 만든다(docs/review/plans/W12-ci-sec.md §3) ----------
// 정본: docs/infra.md '로컬 데모의 비밀'(Next.js 서버 액션 암호화 키도 같은 비밀 파일에서 무작위 32바이트로 만든다).
// 키 꼴은 packages/config/next/server-actions-key.mjs의 checkServerActionsKey(서버가 뜰 때 보는 것과 같은 검사)로 본다.

/** 예전 데모 상수(공개된 값). 글자 그대로 두지 않고 문구 조각을 이어 그 자리에서 base64로 만든다(계획 §3 첫 줄) */
const OLD_DEMO_KEY = Buffer.from(`${['peaket', 'demo', 'server', 'actions', 'key'].join('-')}--`).toString('base64');
const readOrNull = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

/**
 * 임시 폴더의 secretsFile로 prepareDemoSecrets를 부르는 시험 틀. secretsFile을 받지 않는 구현이 기본 자리(.cache의 비밀 파일)에
 * 쓰거나 고치면 그 사실을 단언하고, 끝나면 기본 자리를 시험 전 모습으로 되돌린다(이 PC의 데모 비밀을 바꾸지 않는다).
 */
async function withTempSecrets(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'w12s-secrets-'));
  const realDir = dirname(DEMO_SECRETS_FILE);
  const realDirBefore = existsSync(realDir);
  const realBefore = readOrNull(DEMO_SECRETS_FILE);
  try {
    await fn({ file: (name) => join(dir, name, 'secrets.json') });
    assert.equal(readOrNull(DEMO_SECRETS_FILE), realBefore, 'secretsFile을 줬는데 기본 자리의 데모 비밀 파일을 만들거나 고쳤다');
  } finally {
    const realAfter = readOrNull(DEMO_SECRETS_FILE);
    if (realAfter !== realBefore) {
      if (realBefore === null) rmSync(DEMO_SECRETS_FILE, { force: true });
      else writeFileSync(DEMO_SECRETS_FILE, realBefore, { mode: 0o600 });
    }
    // 시험이 새로 만든 빈 비밀 폴더만 지운다(전부터 있던 폴더·다른 파일은 그대로 둔다)
    if (!realDirBefore && existsSync(realDir) && readdirSync(realDir).length === 0) rmdirSync(realDir);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** secretsFile에 쓰인 serverActionsKey(파일이 없으면 실패) */
function storedKey(file) {
  assert.ok(existsSync(file), `secretsFile(${file})에 비밀 파일을 만들지 않았다`);
  return JSON.parse(readFileSync(file, 'utf8')).serverActionsKey;
}

test('W12S-04 ① 새로 만든 데모 비밀 파일의 serverActionsKey는 서버가 받는 꼴(표준 base64 32바이트, checkServerActionsKey 통과)이다', async () => {
  await withTempSecrets(({ file }) => {
    const out = prepareDemoSecrets({ secretsFile: file('a') });
    const key = storedKey(file('a'));
    assert.equal(typeof key, 'string', `파일에 serverActionsKey가 없다(${typeof key})`);
    assert.deepEqual(checkServerActionsKey(key), { ok: true }, 'serverActionsKey가 서버 액션 키 검사를 지나지 못한다');
    assert.equal(Buffer.from(key, 'base64').length, 32, 'serverActionsKey가 32바이트가 아니다');
    assert.equal(out.secrets.serverActionsKey, key, '돌려준 비밀과 파일의 serverActionsKey가 다르다');
    assert.notEqual(key, OLD_DEMO_KEY, '예전 데모 상수를 그대로 쓴다');
  });
});

test('W12S-04 ② 두 번 새로 만들면 serverActionsKey가 서로 다르다(상수가 아니라 무작위)', async () => {
  await withTempSecrets(({ file }) => {
    prepareDemoSecrets({ secretsFile: file('a') });
    prepareDemoSecrets({ secretsFile: file('b') });
    const a = storedKey(file('a'));
    const b = storedKey(file('b'));
    assert.equal(typeof a, 'string', 'a에 serverActionsKey가 없다');
    assert.equal(typeof b, 'string', 'b에 serverActionsKey가 없다');
    assert.notEqual(a, b, '새로 만든 두 비밀 파일의 serverActionsKey가 같다');
  });
});

test('W12S-04 ③ serverActionsKey가 없는 예전 파일에는 그 값만 채워 넣고 다른 값은 그대로이며, 다시 불러도 같다', async () => {
  await withTempSecrets(({ file }) => {
    const f = file('old');
    prepareDemoSecrets({ secretsFile: f });
    assert.ok(existsSync(f), `secretsFile(${f})에 비밀 파일을 만들지 않았다`);
    // 이 묶음 전의 파일 모양: serverActionsKey만 없다
    const old = JSON.parse(readFileSync(f, 'utf8'));
    delete old.serverActionsKey;
    writeFileSync(f, `${JSON.stringify(old, null, 2)}\n`);

    const second = prepareDemoSecrets({ secretsFile: f });
    const filled = JSON.parse(readFileSync(f, 'utf8'));
    assert.deepEqual(checkServerActionsKey(filled.serverActionsKey), { ok: true }, '채워 넣은 serverActionsKey가 서버 액션 키 검사를 지나지 못한다');
    assert.equal(second.secrets.serverActionsKey, filled.serverActionsKey, '돌려준 비밀과 파일의 serverActionsKey가 다르다');
    const rest = { ...filled };
    delete rest.serverActionsKey;
    assert.deepEqual(rest, old, '채워 넣으면서 다른 비밀 값을 바꿨다(새로 만들지 않고 채워 넣는다)');

    const afterFill = readFileSync(f, 'utf8');
    const third = prepareDemoSecrets({ secretsFile: f });
    assert.equal(readFileSync(f, 'utf8'), afterFill, '다시 부르면 비밀 파일이 바뀐다(멱등이 아니다)');
    assert.equal(third.secrets.serverActionsKey, filled.serverActionsKey, '다시 부르면 serverActionsKey가 바뀐다');
  });
});

// ---------- W12T-01 데모 비밀 파일 권한(docs/review/plans/W12-tools.md §3) ----------
// 정본: docs/infra.md '로컬 데모의 비밀'(0600(주인만 읽고 쓰는 파일 권한)은 비밀 파일을 새로 만들 때와 있던 파일을 다시 쓸 때 모두 맞춘다.
// 권한 검사는 .cache의 비밀 파일만 본다). writeFileSync의 mode는 새 파일에만 듣는다: 있던 파일을 다시 쓰는 자리를 따로 본다.
// 비밀 JSON 쓰기 도우미는 demo-auth.mjs가 내보내는 writeSecretJson(file, value)다(계획 §2: 폴더 만들기 → 0600으로 쓰기 → 권한 맞추기).
const POSIX_ONLY = process.platform === 'win32' && 'Windows에는 POSIX 파일 권한이 없다(우분투 CI tools-check / tools가 본다)';
const modeOf = (file) => (statSync(file).mode & 0o777).toString(8);
/** 도우미를 그 자리에서 가져온다(도우미가 없는 트리에서도 이 파일의 다른 시험은 돈다) */
async function secretWriter() {
  const mod = await import('./demo-auth.mjs');
  assert.equal(typeof mod.writeSecretJson, 'function', 'demo-auth.mjs가 비밀 JSON 쓰기 도우미 writeSecretJson을 내보내지 않는다');
  return mod.writeSecretJson;
}

// skip-until: 2027-05-21 Windows에는 POSIX 파일 권한이 없다(우분투 CI tools-check가 본다) W12-tools
test('W12T-01 ② 임시 secretsFile에 새로 만든 데모 비밀 파일은 0600이다(POSIX)', { skip: POSIX_ONLY }, async () => {
  await withTempSecrets(({ file }) => {
    const f = file('new');
    prepareDemoSecrets({ secretsFile: f });
    assert.equal(modeOf(f), '600', `새로 만든 비밀 파일의 권한이 ${modeOf(f)}다`);
  });
});

// skip-until: 2027-05-21 Windows에는 POSIX 파일 권한이 없다(우분투 CI tools-check가 본다) W12-tools
test('W12T-01 ③ 키 하나(serverActionsKey)가 빠진 0644 비밀 파일을 채워 다시 쓰면 0600으로 좁혀진다(POSIX)', { skip: POSIX_ONLY }, async () => {
  await withTempSecrets(({ file }) => {
    const f = file('wide');
    prepareDemoSecrets({ secretsFile: f });
    const old = JSON.parse(readFileSync(f, 'utf8'));
    delete old.serverActionsKey;
    writeFileSync(f, `${JSON.stringify(old, null, 2)}\n`);
    chmodSync(f, 0o644);
    assert.equal(modeOf(f), '644', '시험 준비: 넓은 권한(644) 파일을 만들지 못했다');

    const out = prepareDemoSecrets({ secretsFile: f });
    const filled = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(typeof filled.serverActionsKey, 'string', '빠진 serverActionsKey를 채워 다시 쓰지 않았다(이 시험의 전제)');
    assert.equal(out.secrets.serverActionsKey, filled.serverActionsKey, '돌려준 비밀과 파일의 serverActionsKey가 다르다');
    assert.equal(modeOf(f), '600', `있던 비밀 파일을 다시 쓴 뒤 권한이 ${modeOf(f)}다(0600으로 맞추지 않았다)`);
  });
});

// skip-until: 2027-05-21 Windows에는 POSIX 파일 권한이 없다(우분투 CI tools-check가 본다) W12-tools
test('W12T-01 ④ 비밀 JSON 쓰기 도우미는 있던 0644 파일에 써도 0600으로 맞춘다(POSIX)', { skip: POSIX_ONLY }, async () => {
  const writeSecretJson = await secretWriter();
  const dir = mkdtempSync(join(tmpdir(), 'w12t-secret-json-'));
  try {
    const f = join(dir, 'sessions.json');
    writeFileSync(f, '{"before":true}\n');
    chmodSync(f, 0o644);
    assert.equal(modeOf(f), '644', '시험 준비: 넓은 권한(644) 파일을 만들지 못했다');
    const value = { version: 1, jimin: { cookie: 'w12t-fake-cookie' } };
    writeSecretJson(f, value);
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), value, '도우미가 준 값을 그대로 쓰지 않았다');
    assert.equal(modeOf(f), '600', `도우미로 다시 쓴 뒤 권한이 ${modeOf(f)}다`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('W12T-01 ④ demo-auth.mjs의 비밀 파일 쓰기(writeFileSync)는 도우미 안 한 곳뿐이고, 도우미는 없는 폴더를 만들어 쓴다(모든 OS)', async () => {
  const writeSecretJson = await secretWriter();
  const dir = mkdtempSync(join(tmpdir(), 'w12t-secret-json-'));
  try {
    const f = join(dir, 'demo-secrets', 'nested', 'secrets.json');
    const value = { version: 1, dbPassword: 'w12t-fake-password' };
    writeSecretJson(f, value);
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), value, '도우미가 없는 폴더를 만들어 쓰지 않았다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 있던 파일을 다시 쓰는 자리(빠진 키 채우기·sessions.json)가 도우미를 비켜 가면 권한이 넓은 채 남는다. 주석 줄은 세지 않는다
  const code = readFileSync(join(REPO, 'tools', 'local', 'demo-auth.mjs'), 'utf8')
    .split(/\r?\n/)
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
    .join('\n');
  const at = [...code.matchAll(/writeFileSync\(/g)].map((m) => m.index);
  assert.equal(at.length, 1, `demo-auth.mjs의 writeFileSync( 호출이 ${at.length}곳이다(도우미 안 한 곳이어야 한다)`);
  const start = code.indexOf('export function writeSecretJson(');
  assert.ok(start >= 0, 'demo-auth.mjs에 export function writeSecretJson( 정의가 없다');
  const end = code.indexOf('\n}\n', start);
  assert.ok(start < at[0] && at[0] < end, 'demo-auth.mjs의 writeFileSync( 한 곳이 writeSecretJson 안에 있지 않다');
});

// ---------- W12S-06 데모 HTTPS 요청은 무대 인증서로 확인한다(docs/review/plans/W12-ci-sec.md §3) ----------
// 정본: docs/infra.md '로컬 데모의 비밀'(데모 도구의 HTTPS 요청은 무대 계약 파일의 자체 서명 인증서 caPem을 믿을 기준으로 삼아
// 인증서와 이름을 확인하고, 그 값이 없으면 확인을 끄지 않고 요청 전에 멈춘다).
// 인증서는 무대와 같은 openssl 인자(gatewayCertArgs)로 이 PC에서 만들고, openssl이 없으면 건너뛰지 않고 실패한다(계획 §3).
const HOST = 'partner-api.peaket.example';

function makeCert(dir, name) {
  const keyFile = join(dir, `${name}.key`);
  const certFile = join(dir, `${name}.crt`);
  // real-time: 실제 X.509 인증서가 있어야 TLS 확인을 시험할 수 있고 Node에는 인증서 만들기가 없다(무대와 같은 openssl 인자) W12S-06
  const r = spawnSync('openssl', gatewayCertArgs(keyFile, certFile, [HOST]), { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.error, undefined, `openssl을 부르지 못했다(PATH에 openssl이 있어야 한다, 건너뛰지 않는다): ${r.error?.message}`);
  assert.equal(r.status, 0, `openssl 인증서 만들기 실패: ${r.stderr}`);
  return { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') };
}

/** 127.0.0.1의 HTTPS 서버. 연결·요청 처리 수를 센다 */
async function startServer(c) {
  const seen = { connections: 0, requests: 0 };
  const server = createHttpsServer({ key: c.key, cert: c.cert }, (req, res) => {
    seen.requests += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
  });
  server.on('connection', () => {
    seen.connections += 1;
  });
  // real-time: httpsJson은 연결 함수를 받지 않아 TLS 손 맞잡기를 하려면 루프백 포트가 필요하다(0번 포트, 시험마다 닫는다) W12S-06
  await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const close = () =>
    new Promise((done) => {
      server.closeAllConnections();
      server.close(() => done(undefined));
    });
  return { port, seen, close };
}

/** 인증서 A·B를 만들고, 시험이 띄운 서버는 끝에 모두 닫는다 */
async function withServers(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'w12s-tls-'));
  const servers = [];
  const serve = async (c) => {
    const s = await startServer(c);
    servers.push(s);
    return s;
  };
  try {
    const A = makeCert(dir, 'a');
    const B = makeCert(dir, 'b');
    assert.notEqual(A.cert, B.cert, '인증서 A·B가 같다');
    await fn({ A, B, serve });
  } finally {
    for (const s of servers) await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 인증서·이름 확인에서 거절된 오류인가(연결 거부 같은 다른 오류와 가른다) */
const tlsRefusal = (e) => /certificate|CERT|ALTNAME|SELF_SIGNED/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);

test('W12S-06 ① 서버 인증서 A를 ca A로 믿으면 요청이 가고 응답 JSON을 받는다', async () => {
  await withServers(async ({ A, serve }) => {
    const s = await serve(A);
    const r = await httpsJson({ host: HOST, port: s.port, method: 'GET', path: '/w12s/ping', ca: A.cert });
    assert.equal(r.status, 200, `응답 상태 ${r.status}`);
    assert.deepEqual(r.json, { path: '/w12s/ping', host: `${HOST}:${s.port}` });
    assert.equal(s.seen.requests, 1, '서버가 요청을 한 번 받아야 한다');
  });
});

test('W12S-06 ② 다른 인증서 B를 내는 서버는 ca A로 거절하고 서버 처리기는 한 번도 돌지 않는다', async () => {
  await withServers(async ({ A, B, serve }) => {
    const s = await serve(B);
    await assert.rejects(
      async () => httpsJson({ host: HOST, port: s.port, method: 'GET', path: '/w12s/ping', ca: A.cert }),
      (e) => tlsRefusal(e) || assert.fail(`인증서 확인 거절이 아닌 오류다: ${e?.code} ${e?.message}`),
      '믿지 않는 인증서의 서버에 요청했다(인증서 확인을 끈다)',
    );
    assert.equal(s.seen.requests, 0, '믿지 않는 서버의 처리기가 돌았다');
  });
});

test('W12S-06 ③ ca가 빈 글이면 연결하지 않고 caPem을 말하는 오류로 거절한다(확인을 끄는 쪽으로 물러서지 않는다)', async () => {
  await withServers(async ({ A, serve }) => {
    const s = await serve(A);
    await assert.rejects(async () => httpsJson({ host: HOST, port: s.port, method: 'GET', path: '/w12s/ping', ca: '' }), /caPem/, '믿을 인증서 없이 요청했거나 caPem을 말하지 않는다');
    // 같은 서버에 바른 요청 하나를 보낸 뒤 센다: 앞 요청이 늦게 닿았다면 여기서 둘이 된다(고정 대기 없이 본다)
    const ok = await httpsJson({ host: HOST, port: s.port, method: 'GET', path: '/w12s/after', ca: A.cert });
    assert.equal(ok.status, 200, `뒤 요청 상태 ${ok.status}`);
    assert.deepEqual({ connections: s.seen.connections, requests: s.seen.requests }, { connections: 1, requests: 1 }, 'ca가 빈 요청이 서버에 닿았다');
  });
});

test('W12S-06 ④ 인증서는 믿어도 요청 이름(Host)이 인증서 이름에 없으면 거절한다(이름 확인을 끄지 않는다)', async () => {
  await withServers(async ({ A, serve }) => {
    const s = await serve(A);
    await assert.rejects(
      async () => httpsJson({ host: 'other.peaket.example', port: s.port, method: 'GET', path: '/w12s/ping', ca: A.cert }),
      (e) => tlsRefusal(e) || assert.fail(`이름 확인 거절이 아닌 오류다: ${e?.code} ${e?.message}`),
      '인증서 이름에 없는 호스트로 요청했다(이름 확인을 끈다)',
    );
    assert.equal(s.seen.requests, 0, '이름이 맞지 않는 서버의 처리기가 돌았다');
  });
});
