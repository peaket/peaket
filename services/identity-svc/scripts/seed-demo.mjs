#!/usr/bin/env node
// BAT-087 첫 관리자·패스키 부트스트랩(로컬 데모 전용 예외). 관리 계정 초대는 이미 있는 관리자·패스키 재인증이 필요해
// 공개 API로 첫 계정을 만들 수 없다. 그래서 identity-svc의 도메인 코드(비밀번호 해시·TOTP 봉투·패스키 행)를 그대로 써서
// 부트스트랩 값(Secret demo-bootstrap의 bootstrap.json)을 넣는다. 감사 기록·권한 부여 내역은 남지 않는다(한계).
// - PEAKET_ENV가 local·ci·demo가 아니면 exit 2이고 아무것도 쓰지 않는다
// - 같은 키를 두 번 넣지 않는다(id·email·credential_id로 찾는다). 두 번 적용해도 수가 같다
// 쓰는 법(이미지 안): node scripts/seed-demo.mjs --check|--apply
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { LocalPepper } from '../dist/modules/admin/adapters/local-pepper.js';
import { Pbkdf2AdminPasswords, ADMIN_PBKDF2_MIN_ITERATIONS } from '../dist/modules/admin/adapters/pbkdf2-admin-passwords.js';
import { LocalTotpSeedCipher } from '../dist/modules/admin/adapters/local-totp-seed-cipher.js';
import { base32Decode } from '../dist/modules/admin/domain/totp.js';

const ALLOWED = ['local', 'ci', 'demo'];
const env = process.env;
const mode = process.argv[2] ?? '';
if (!['--check', '--apply'].includes(mode)) {
  console.error('쓰는 법: node scripts/seed-demo.mjs --check|--apply');
  process.exit(2);
}
if (!ALLOWED.includes(env.PEAKET_ENV ?? '')) {
  console.error(`부트스트랩은 PEAKET_ENV ${ALLOWED.join('·')}에서만 돈다(지금 ${env.PEAKET_ENV ?? '없음'}). 아무것도 쓰지 않았다`);
  process.exit(2);
}
const file = env.PEAKET_DEMO_BOOTSTRAP_FILE ?? '/etc/peaket/bootstrap/bootstrap.json';
let bootstrap;
try {
  bootstrap = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`부트스트랩 파일을 읽지 못했다: ${file} (${e instanceof Error ? e.message : '알 수 없는 오류'})`);
  process.exit(2);
}
if (bootstrap?.version !== 1 || !Array.isArray(bootstrap.accounts)) {
  console.error(`${file}: version 1과 accounts 배열이 필요하다`);
  process.exit(2);
}
if (mode === '--check') {
  console.log(JSON.stringify({ ok: true, accounts: bootstrap.accounts.length, promoters: (bootstrap.promoters ?? []).length }));
  process.exit(0);
}
const url = env.PEAKET_DATABASE_URL;
if (!url) {
  console.error('PEAKET_DATABASE_URL이 없다');
  process.exit(2);
}
const pepperKey = Buffer.from(env.PEAKET_ADMIN_PEPPER_KEY ?? '', 'base64');
const totpKey = Buffer.from(env.PEAKET_ADMIN_TOTP_KEY ?? '', 'base64');
if (pepperKey.length !== 32 || totpKey.length !== 32) {
  console.error('PEAKET_ADMIN_PEPPER_KEY·PEAKET_ADMIN_TOTP_KEY는 base64 32바이트다');
  process.exit(2);
}
const pepper = new LocalPepper(new Map([[1, pepperKey]]), 1);
const hasher = new Pbkdf2AdminPasswords(pepper, { iterations: ADMIN_PBKDF2_MIN_ITERATIONS });
const totpCipher = new LocalTotpSeedCipher(totpKey);

const client = new pg.Client({ connectionString: url, application_name: 'identity-svc-demo-bootstrap' });
await client.connect();
let accounts = 0;
let passkeys = 0;
try {
  for (const a of bootstrap.accounts) {
    const exists = await client.query('select id from admin_account where id = $1 or (email = $2 and status <> $3) limit 1', [a.id, a.email, 'REMOVED']);
    if (exists.rowCount) continue;
    const phc = await hasher.hash(a.id, a.password);
    const seed = base32Decode(a.totpSeed);
    const enc = await totpCipher.encrypt(a.id, seed);
    await client.query(
      `insert into admin_account (id, role, promoter_id, status, email, display_name, password_phc, totp_seed_enc, created_at, updated_at)
       values ($1, $2, $3, 'ACTIVE', $4, $5, $6, $7, now(), now())
       on conflict (id) do nothing`,
      [a.id, a.role, a.promoterId ?? null, a.email, a.displayName ?? null, phc, enc],
    );
    accounts += 1;
    for (const p of a.passkeys ?? []) {
      const known = await client.query('select 1 from admin_passkey where credential_id = $1', [Buffer.from(p.credentialId, 'base64url')]);
      if (known.rowCount) continue;
      await client.query(
        `insert into admin_passkey (id, admin_account_id, credential_id, public_key, sign_count, transports, device_type, backed_up, aaguid, name, created_at)
         values (gen_random_uuid(), $1, $2, $3, 0, $4, 'multiDevice', true, $5, $6, now())`,
        [a.id, Buffer.from(p.credentialId, 'base64url'), Buffer.from(p.publicKeyCose, 'base64'), ['internal'], p.aaguid, p.name],
      );
      passkeys += 1;
    }
  }
} finally {
  await client.end();
}
console.log(JSON.stringify({ ok: true, created: { accounts, passkeys }, total: { accounts: bootstrap.accounts.length } }));
