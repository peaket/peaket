// BAT-087 데모 인증 도우미의 계약(팬·관리·패스키)을 단위로 본다.
// 정본: docs/review/plans/BAT-087.md §5 '인증 도우미 계약', §6 DS-12, 감독 결정 5·7.
// 실제 gRPC·게이트웨이 로그인은 kind e2e(DS-08·09)가 본다. 여기서는 값의 모양·TOTP·쿠키·부트스트랩 행만 본다.
// 실행(저장소 뿌리): node --test "tools/local/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapOf, cookiesOf, demoAuth, demoUuid, totpAt, readSeed } from './demo-auth.mjs';

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
