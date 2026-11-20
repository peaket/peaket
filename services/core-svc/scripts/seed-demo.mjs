#!/usr/bin/env node
// BAT-087 파트너사(promoter) 부트스트랩(로컬 데모 전용 예외). promoter를 만드는 공개 API가 없어
// 부트스트랩 값(Secret demo-bootstrap의 bootstrap.json)의 promoters를 직접 넣는다. 감사 기록은 남지 않는다(한계).
// - PEAKET_ENV가 local·ci·demo가 아니면 exit 2이고 아무것도 쓰지 않는다
// - id로 찾아 없을 때만 넣는다(두 번 적용해도 수가 같다)
// 쓰는 법(이미지 안): node scripts/seed-demo.mjs --check|--apply
import { readFileSync } from 'node:fs';
import pg from 'pg';

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
if (bootstrap?.version !== 1 || !Array.isArray(bootstrap.promoters)) {
  console.error(`${file}: version 1과 promoters 배열이 필요하다`);
  process.exit(2);
}
if (mode === '--check') {
  console.log(JSON.stringify({ ok: true, promoters: bootstrap.promoters.length }));
  process.exit(0);
}
const url = env.PEAKET_BOOTSTRAP_DATABASE_URL ?? env.PEAKET_DATABASE_URL;
if (!url) {
  console.error('PEAKET_DATABASE_URL이 없다');
  process.exit(2);
}
const client = new pg.Client({ connectionString: url, application_name: 'core-svc-demo-bootstrap' });
await client.connect();
let created = 0;
try {
  for (const p of bootstrap.promoters) {
    const exists = await client.query('select 1 from promoter where id = $1', [p.id]);
    if (exists.rowCount) continue;
    await client.query('insert into promoter (id, legal_name, verified_at) values ($1, $2, now()) on conflict (id) do nothing', [p.id, p.legalName]);
    created += 1;
  }
} finally {
  await client.end();
}
console.log(JSON.stringify({ ok: true, created: { promoters: created }, total: { promoters: bootstrap.promoters.length } }));
