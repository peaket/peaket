// F-10-2 모의 악성 코드 검사기(계획 docs/review/plans/F-10-2.md §3·§5·§7, D-T35 ④,
// docs/security/asvs/catalog-review.md 5.4.3). AWS 흉내 서버 moto 5.2.5의 실제 S3 REST에서 태그를 본다.
// 시험 먼저: 구현 전에는 tools/local/mock-malware-scanner.mjs가 없어 실패한다(ADR-0372).
// 실행(저장소 뿌리): node --test tools/local/mock-scanner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'tools', 'local', 'mock-malware-scanner.mjs');
const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const BUCKET = 'peaket-it-mock-scan';
const TAG_KEY = 'GuardDutyMalwareScanStatus';
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);

const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error('기다리다 시간이 지났다');
    await sleep(100);
  }
}

async function scan(endpoint) {
  execFileSync(process.execPath, [SCRIPT, '--endpoint', endpoint, '--bucket', BUCKET, '--once'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** S3 GET ?tagging 응답에서 태그 값을 읽는다(없으면 undefined) */
async function tagOf(endpoint, key) {
  const r = await fetch(`${endpoint}/${BUCKET}/${key}?tagging`);
  if (r.status === 404) return undefined;
  assert.equal(r.status, 200, `태그 읽기 ${r.status}`);
  const xml = await r.text();
  const m = new RegExp(`<Key>${TAG_KEY}</Key>\\s*<Value>([^<]+)</Value>`).exec(xml);
  return m?.[1];
}

test('D-T35 ④ 모의 검사기는 moto S3에서 EICAR만 THREATS_FOUND로 표시하고 다시 돌려도 바꾸지 않는다 [ASVS v5.0.0-5.4.3]', { timeout: 120_000 }, async () => {
  const container = docker(['run', '-d', '--rm', '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  try {
    const mapped = docker(['port', container, '5000/tcp']).split('\n')[0].trim();
    const endpoint = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
    await until(async () => {
      try {
        return (await fetch(endpoint)).status < 500;
      } catch {
        return false;
      }
    });
    assert.ok((await fetch(`${endpoint}/${BUCKET}`, { method: 'PUT' })).status < 300, '버킷을 만들지 못했다');
    assert.ok((await fetch(`${endpoint}/${BUCKET}/clean.png`, { method: 'PUT', body: PNG })).status < 300);
    assert.ok((await fetch(`${endpoint}/${BUCKET}/eicar.png`, { method: 'PUT', body: EICAR })).status < 300);
    // 이미 태그가 붙은 객체는 건드리지 않는다
    assert.ok((await fetch(`${endpoint}/${BUCKET}/tagged.png`, { method: 'PUT', body: EICAR, headers: { 'x-amz-tagging': `${TAG_KEY}=NO_THREATS_FOUND` } })).status < 300);

    await scan(endpoint);
    assert.equal(await tagOf(endpoint, 'clean.png'), 'NO_THREATS_FOUND');
    assert.equal(await tagOf(endpoint, 'eicar.png'), 'THREATS_FOUND');
    assert.equal(await tagOf(endpoint, 'tagged.png'), 'NO_THREATS_FOUND');
    // 두 번째 실행은 객체·태그를 바꾸지 않는다(멱등)
    const before = await (await fetch(`${endpoint}/${BUCKET}?list-type=2`)).text();
    await scan(endpoint);
    assert.equal(await tagOf(endpoint, 'clean.png'), 'NO_THREATS_FOUND');
    assert.equal(await tagOf(endpoint, 'eicar.png'), 'THREATS_FOUND');
    assert.equal(await tagOf(endpoint, 'tagged.png'), 'NO_THREATS_FOUND');
    const after = await (await fetch(`${endpoint}/${BUCKET}?list-type=2`)).text();
    assert.equal(after, before, '다시 돌렸더니 객체 목록이 바뀌었다');
  } finally {
    try {
      docker(['rm', '-f', '-v', container]);
    } catch {
      // 이미 지워졌다
    }
  }
});
