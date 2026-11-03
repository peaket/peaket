// v0 입구 시험 토큰(tools/local/v0-token.mjs) 시험(docs/infra.md §3 'v0 배포' 3, BUILD_ORDER BSL-050).
// 키 쌍·공개키 목록·키 파일·토큰 서명을 node:crypto로 따로 검증한다. 실행: node --test "tools/local/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { V0_TOKEN_ISSUER, V0_TOKEN_TTL_SECONDS, generateV0TokenKey, loadOrCreateV0TokenKey, publicJwksOf, signV0Token } from './v0-token.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'v0-token.mjs');
const temps = [];
process.on('exit', () => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'v0-token-'));
  temps.push(d);
  return d;
};

const B64URL = /^[A-Za-z0-9_-]+$/;
const fromB64url = (s) => Buffer.from(s, 'base64url');
const decodePart = (s) => JSON.parse(fromB64url(s).toString('utf8'));

/** RFC 7638 JWK 지문(EC: crv·kty·x·y를 사전 순으로, 공백 없이)의 base64url */
const thumbprint = (jwk) => createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');

/** 토큰을 세 칸으로 나눠 머리·본문을 풀고, 공개키 목록의 kid 키로 ES256(IEEE P1363 r||s) 서명을 확인한다 */
function verifyToken(token, jwks) {
  const parts = token.split('.');
  assert.equal(parts.length, 3, '머리.본문.서명 세 칸');
  for (const p of parts) assert.match(p, B64URL, 'base64url, 채움(=) 없음');
  const [h, p, s] = parts;
  const header = decodePart(h);
  const payload = decodePart(p);
  const sig = fromB64url(s);
  const jwk = jwks.keys.find((k) => k.kid === header.kid) ?? jwks.keys[0];
  const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
  const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, sig);
  return { header, payload, sig, ok };
}

test('BSL050_시험키쌍_EC_P256_개인키JWK와_d없는공개키목록을_만든다 [ASVS v5.0.0-9.1.2]', () => {
  const { privateJwk, jwks } = generateV0TokenKey();
  assert.deepEqual(Object.keys(privateJwk).sort(), ['crv', 'd', 'kid', 'kty', 'x', 'y']);
  assert.equal(privateJwk.kty, 'EC');
  assert.equal(privateJwk.crv, 'P-256');
  for (const k of ['x', 'y', 'd']) assert.match(privateJwk[k], B64URL, k);
  // 실제로 쓸 수 있는 P-256 개인키다
  const priv = createPrivateKey({ key: { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d }, format: 'jwk' });
  assert.equal(priv.asymmetricKeyType, 'ec');
  assert.equal(priv.asymmetricKeyDetails.namedCurve, 'prime256v1');

  assert.equal(jwks.keys.length, 1);
  const pub = jwks.keys[0];
  assert.deepEqual(Object.keys(pub).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
  assert.deepEqual(pub, { kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y, kid: privateJwk.kid, alg: 'ES256', use: 'sig' });
  assert.equal('d' in pub, false, '공개키 목록에 개인키 칸 d가 없다');
});

test('BSL050_kid는_RFC7638_공개키지문의_앞16자이고_키마다다르다', () => {
  const a = generateV0TokenKey();
  const b = generateV0TokenKey();
  assert.equal(a.privateJwk.kid, thumbprint(a.privateJwk).slice(0, 16));
  assert.equal(a.privateJwk.kid.length, 16);
  assert.equal(a.jwks.keys[0].kid, a.privateJwk.kid);
  assert.notEqual(a.privateJwk.d, b.privateJwk.d);
  assert.notEqual(a.privateJwk.kid, b.privateJwk.kid);
  // base64url(-·_)이지 base64(+·/)가 아니다. 한 키로는 우연히 같을 수 있어(16자에 +·/가 없을 확률이 키마다 약 60%) 여럿을 본다
  for (let i = 0; i < 24; i += 1) {
    const { privateJwk } = generateV0TokenKey();
    assert.equal(privateJwk.kid, thumbprint(privateJwk).slice(0, 16), `kid ${privateJwk.kid}`);
    assert.match(privateJwk.kid, /^[A-Za-z0-9_-]{16}$/);
  }
});

test('BSL050_publicJwksOf는_개인키칸d를빼고_입력을바꾸지않는다 [ASVS v5.0.0-13.3.1]', () => {
  const { privateJwk, jwks } = generateV0TokenKey();
  const copy = structuredClone(privateJwk);
  const out = publicJwksOf(privateJwk);
  assert.deepEqual(out, jwks);
  assert.equal(out.keys.some((k) => 'd' in k), false);
  assert.equal(JSON.stringify(out).includes(privateJwk.d), false, '직렬화한 공개키 목록 어디에도 d 값이 없다');
  assert.deepEqual(privateJwk, copy, '받은 개인키 JWK를 고치지 않는다');
});

test('BSL050_키파일_없으면만들고_다시부르면같은키를돌려준다', () => {
  const file = join(tempDir(), 'v0-token-key.json');
  const first = loadOrCreateV0TokenKey(file);
  assert.ok(statSync(file).isFile(), '키 파일을 만든다');
  assert.equal(first.privateJwk.kid, thumbprint(first.privateJwk).slice(0, 16));
  assert.deepEqual(first.jwks, publicJwksOf(first.privateJwk));
  const second = loadOrCreateV0TokenKey(file);
  assert.deepEqual(second.privateJwk, first.privateJwk);
  assert.deepEqual(second.jwks, first.jwks);
  // 처음 보는 경로의 파일도 그 내용을 읽는다(메모리에 둔 키를 돌려주거나 새로 만들지 않는다)
  const copied = join(tempDir(), 'copied-key.json');
  copyFileSync(file, copied);
  const bytes = readFileSync(copied);
  const third = loadOrCreateV0TokenKey(copied);
  assert.deepEqual(third.privateJwk, first.privateJwk);
  assert.deepEqual(readFileSync(copied), bytes, '있는 키 파일을 고쳐 쓰지 않는다');
  // 읽은 개인키로 만든 토큰이 처음 공개키 목록으로 검증된다(개인키 칸 d까지 파일에 있다)
  assert.equal(verifyToken(signV0Token(third.privateJwk, { sub: 'u-1', sid: 's-1' }), first.jwks).ok, true);
  // 다른 새 파일은 다른 키다
  assert.notEqual(loadOrCreateV0TokenKey(join(tempDir(), 'v0-token-key.json')).privateJwk.kid, first.privateJwk.kid);
});

test('BSL050_키파일은_주인만읽고쓴다_0600 [ASVS v5.0.0-13.3.1]', { skip: process.platform === 'win32' && 'Windows는 POSIX 파일 권한이 없다' }, () => {
  const file = join(tempDir(), 'v0-token-key.json');
  loadOrCreateV0TokenKey(file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('BSL050_키파일이깨졌으면_덮어쓰지않고던진다', () => {
  for (const broken of ['not json{', '{"kty":"EC","crv":"P-256"}']) {
    const file = join(tempDir(), 'v0-token-key.json');
    // 정상 키 파일을 만든 뒤(만들기가 되는 것을 먼저 본다) 그 파일이 깨진 경우다
    loadOrCreateV0TokenKey(file);
    writeFileSync(file, broken);
    assert.throws(() => loadOrCreateV0TokenKey(file), undefined, broken);
    assert.equal(readFileSync(file, 'utf8'), broken, `깨진 파일을 그대로 둔다: ${broken}`);
  }
});

test('BSL050_토큰_머리는ES256·at+jwt·kid이고_서명이공개키로검증된다 [ASVS v5.0.0-9.1.1]', () => {
  const { privateJwk, jwks } = generateV0TokenKey();
  const token = signV0Token(privateJwk, { sub: 'u-1', sid: 's-u-1', scope: 'ticket:buy', pid: 'p-9' });
  const { header, payload, sig, ok } = verifyToken(token, jwks);
  assert.deepEqual(header, { alg: 'ES256', typ: 'at+jwt', kid: privateJwk.kid });
  assert.equal(sig.length, 64, 'ES256 서명은 IEEE P1363 r||s 64바이트(DER가 아니다)');
  assert.equal(ok, true, '공개키 목록의 키로 서명이 맞는다');
  assert.equal(payload.sub, 'u-1');
  assert.equal(payload.sid, 's-u-1');
  assert.equal(payload.scope, 'ticket:buy');
  assert.equal(payload.pid, 'p-9');
  // 다른 키 쌍의 공개키로는 맞지 않는다
  assert.equal(verifyToken(token, generateV0TokenKey().jwks).ok, false);
});

test('BSL050_토큰본문기본값_iss·aud_fan·iat지금·exp15분뒤', () => {
  const { privateJwk, jwks } = generateV0TokenKey();
  const nowMs = 1_790_000_000_987;
  const { payload } = verifyToken(signV0Token(privateJwk, { sub: 'u-1', sid: 's-1' }, { nowMs }), jwks);
  assert.equal(V0_TOKEN_ISSUER, 'https://identity.peaket.local');
  assert.equal(V0_TOKEN_TTL_SECONDS, 900);
  assert.equal(payload.iss, V0_TOKEN_ISSUER);
  assert.equal(payload.aud, 'fan');
  assert.equal(payload.iat, Math.floor(nowMs / 1000));
  assert.equal(payload.exp, Math.floor(nowMs / 1000) + 900);
  // nowMs를 주지 않으면 지금 시각이다
  const before = Math.floor(Date.now() / 1000);
  const { payload: p2 } = verifyToken(signV0Token(privateJwk, { sub: 'u-1', sid: 's-1' }), jwks);
  const after = Math.floor(Date.now() / 1000);
  assert.ok(p2.iat >= before && p2.iat <= after, `iat ${p2.iat}`);
  assert.equal(p2.exp, p2.iat + 900);
});

test('BSL050_틀린토큰을만들도록_본문칸과머리칸을덮어쓸수있다', () => {
  const { privateJwk, jwks } = generateV0TokenKey();
  const token = signV0Token(privateJwk, { sub: 'u-1', sid: 's-1', aud: 'staff', iss: 'https://evil.example', exp: 5, nbf: 99 }, { nowMs: 1_000_000, header: { typ: 'JWT', kid: 'unknown-kid' } });
  const [h, p] = token.split('.');
  const header = decodePart(h);
  const payload = decodePart(p);
  assert.equal(header.alg, 'ES256');
  assert.equal(header.typ, 'JWT');
  assert.equal(header.kid, 'unknown-kid');
  assert.equal(payload.aud, 'staff');
  assert.equal(payload.iss, 'https://evil.example');
  assert.equal(payload.exp, 5);
  assert.equal(payload.nbf, 99);
  assert.equal(payload.iat, 1000);
  // 머리를 바꿔도 서명은 같은 개인키의 ES256이다
  assert.equal(verifyToken(token, { keys: jwks.keys }).ok, true);
});

// 명령줄(node tools/local/v0-token.mjs jwks|sign). 키 파일은 도구 폴더(PEAKET_TOOLS_DIR, 기본 .cache/peaket-tools)의 v0-token-key.json이다
// (cluster.mjs v0와 e2e가 같은 파일을 쓴다). 시험은 임시 도구 폴더를 써 이 PC의 실제 시험 키를 건드리지 않는다
function cli(dir, ...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, PEAKET_TOOLS_DIR: dir }, timeout: 30_000 });
}

test('BSL050_명령줄_jwks는_d없는공개키목록을찍고_sign은그키로_sid_s-sub·scope_ticket:buy·15분토큰을찍는다 [ASVS v5.0.0-13.3.1]', () => {
  const dir = tempDir();
  const keyFile = join(dir, 'v0-token-key.json');
  const j = cli(dir, 'jwks');
  assert.equal(j.status, 0, j.stderr);
  assert.ok(j.stdout.trim(), '공개키 목록(JSON)을 찍는다');
  const jwks = JSON.parse(j.stdout);
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys.some((k) => 'd' in k), false, '찍은 공개키 목록에 d가 없다');
  assert.equal(j.stdout.includes('"d"'), false);
  assert.ok(existsSync(keyFile), `키 파일은 도구 폴더의 v0-token-key.json이다: ${keyFile}`);
  assert.deepEqual(jwks, loadOrCreateV0TokenKey(keyFile).jwks, '찍은 목록은 그 키 파일의 공개키 목록이다');
  // 다시 불러도 같은 키다(키 파일을 다시 쓴다)
  assert.deepEqual(JSON.parse(cli(dir, 'jwks').stdout), jwks);

  const s = cli(dir, 'sign', 'u-1', 'p-9');
  assert.equal(s.status, 0, s.stderr);
  assert.ok(s.stdout.trim(), '토큰을 찍는다');
  const lines = s.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, '토큰 한 줄');
  const { header, payload, ok } = verifyToken(lines[0], jwks);
  assert.equal(ok, true, '찍은 공개키 목록으로 서명이 맞는다');
  assert.deepEqual(header, { alg: 'ES256', typ: 'at+jwt', kid: jwks.keys[0].kid });
  assert.equal(payload.sub, 'u-1');
  assert.equal(payload.sid, 's-u-1');
  assert.equal(payload.scope, 'ticket:buy');
  assert.equal(payload.pid, 'p-9');
  assert.equal(payload.iss, V0_TOKEN_ISSUER);
  assert.equal(payload.aud, 'fan');
  assert.equal(payload.exp - payload.iat, V0_TOKEN_TTL_SECONDS);
  // pid를 주지 않으면 pid 칸이 없다
  const noPid = cli(dir, 'sign', 'u-2');
  assert.equal(noPid.status, 0, noPid.stderr);
  const p2 = verifyToken(noPid.stdout.trim(), jwks).payload;
  assert.deepEqual([p2.sub, p2.sid, 'pid' in p2], ['u-2', 's-u-2', false]);
});

test('BSL050_명령줄_모르는명령이나_sub없는sign은_토큰없이실패한다', () => {
  const dir = tempDir();
  for (const args of [[], ['nope'], ['sign']]) {
    const r = cli(dir, ...args);
    const what = args.join(' ') || '(인자 없음)';
    assert.notEqual(r.status, null, `${what}: 시간 안에 끝난다`);
    assert.notEqual(r.status, 0, `${what}: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\./, `${what}: 토큰을 찍지 않는다`);
  }
});
