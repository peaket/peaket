// 공개 검증 도구 audit_verify.py의 시험(BAT-360 OPS-280, docs/features/control-tower.md §14 C-T38 ③·C-T39·C-T40·C-T42, ADR-0348 결정 2~8).
// 픽스처(공개 폴더 transparency/v1/와 검증 묶음)는 ops-svc 코드를 쓰지 않고 이 파일이 정본 식(ADR-0348 결정 2 잎·노드 바이트, 결정 3 RFC 8785 JSON,
// 결정 4 ECDSA P-256 DER base64, 결정 5 OpenTimestamps 파일 꼴, 결정 6 파일 이름, 결정 8 묶음 칸)으로 따로 만든다.
// 파일 꼴의 자리: ots.ts·publisher.ts·bundle.ts 머리 주석. 도구는 파이썬 3.11 이상(-I -X utf8)으로 부르고 --json 결과와 끝 코드를 함께 본다.
// 끝 코드(ADR-0348 결정 7, README): 0 통과, 1 어긋남, 2 입력 오류, 3 일부 확인 못 함.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('./audit_verify.py', import.meta.url));
const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

// ---- 정본 식(ADR-0348) ----

const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const u64be = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
/** 결정 2: 'PEAKET-audit-leaf-v1'(20바이트) ‖ seq u64 BE ‖ 기록 해시 32바이트 ‖ 잎 솔트 32바이트 */
const leafInput = (seq, recSha, salt, o = {}) => Buffer.concat([Buffer.from('PEAKET-audit-leaf-v1', 'ascii'), u64be(seq), recSha, ...(o.noSalt ? [] : [salt])]);
const leafHash = (input, prefix = 0x00) => sha256(Buffer.from([prefix]), input);
const nodeHash = (l, r, prefix = 0x01) => sha256(Buffer.from([prefix]), l, r);
/** RFC 9162 §2.1.1: k = n보다 작은 가장 큰 2의 거듭제곱 */
const splitOf = (n) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};
const mth = (hs, prefix = 0x01) => (hs.length === 1 ? hs[0] : nodeHash(mth(hs.slice(0, splitOf(hs.length)), prefix), mth(hs.slice(splitOf(hs.length)), prefix), prefix));
/** RFC 9162 §2.1.3.1 PATH(m, D[n]), 잎 쪽부터 */
const pathOf = (m, hs, prefix = 0x01) => {
  if (hs.length === 1) return [];
  const k = splitOf(hs.length);
  return m < k ? [...pathOf(m, hs.slice(0, k), prefix), mth(hs.slice(k), prefix)] : [...pathOf(m - k, hs.slice(k), prefix), mth(hs.slice(0, k), prefix)];
};
/** RFC 8785: 이 칸들은 ASCII 글과 안전한 정수뿐이라 키를 UTF-16 코드 단위 차례로 둔 압축 JSON이 정규형이다 */
const canonical = (obj) => JSON.stringify(Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]])));

// OpenTimestamps 파일(ots.ts 머리 주석의 꼴)
const OTS_MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
const PENDING_TAG = Buffer.from('83dfe30d2ef90c8e', 'hex');
const BITCOIN_TAG = Buffer.from('0588960d73d71901', 'hex');
const varuint = (n) => {
  const out = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return Buffer.from(out);
};
const varbytes = (b) => Buffer.concat([varuint(b.length), b]);
const CALENDAR = 'https://ots-calendar.fixture.invalid';
const pendingAtt = (uri) => Buffer.concat([Buffer.from([0x00]), PENDING_TAG, varbytes(varbytes(Buffer.from(uri, 'utf8')))]);
const bitcoinAtt = (height) => Buffer.concat([Buffer.from([0x00]), BITCOIN_TAG, varbytes(varuint(height))]);
/** 대상 다이제스트 → append(16바이트 난수) → sha256 → [대기 증명(, 그 값의 sha256 → 비트코인 증명)] */
const otsFile = (digest, o = {}) =>
  Buffer.concat([
    OTS_MAGIC,
    varuint(1),
    Buffer.from([0x08]),
    digest,
    Buffer.from([0xf0]),
    varbytes(o.nonce ?? randomBytes(16)),
    Buffer.from([0x08]),
    ...(o.bitcoinHeight !== undefined ? [Buffer.from([0xff]), pendingAtt(CALENDAR), Buffer.from([0x08]), bitcoinAtt(o.bitcoinHeight)] : [pendingAtt(CALENDAR)]),
  ]);

// ---- 픽스처 ----

const p256 = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pemOf = (publicKey) => publicKey.export({ type: 'spki', format: 'pem' }).toString();
/** 결정 4: ECDSA / SHA-256(체크포인트 JSON 바이트), DER을 base64로 */
const signB64 = (privateKey, bytes) => sign('sha256', bytes, { key: privateKey, dsaEncoding: 'der' }).toString('base64');

/** 감사 기록 n개(seq 1부터). 기록 해시 = SHA-256(UTF-8(직전 해시 16진) ‖ UTF-8(정규화 기록)) */
function makeRecords(n, startSeq = 1, prevHash = '') {
  const out = [];
  let prev = prevHash;
  for (let i = 0; i < n; i += 1) {
    const seq = startSeq + i;
    const recordId = randomUUID();
    const recordJson = canonical({ at: new Date(Date.UTC(2026, 10, 21, 15, 7, seq % 60, 123)).toISOString(), payload: { note: `감사 점검 기록 ${seq}`, n: seq * 7 }, recordId, recordType: 'COMMAND_CREATED' });
    const recSha = sha256(Buffer.from(prev, 'utf8'), Buffer.from(recordJson, 'utf8'));
    out.push({ seq, recordId, recordJson, prevHash: prev, recSha, salt: randomBytes(32) });
    prev = recSha.toString('hex');
  }
  return out;
}

/**
 * 공개 사슬 하나. counts[i]개 기록을 덮는 체크포인트 no i+1을 만든다.
 * o.extra[no]: JSON에 더할 칸, o.leaf(rec): 잎 해시(틀린 구현 흉내), o.nodePrefix: 안쪽 노드 접두
 */
function makeChain(counts, o = {}) {
  const key = o.key ?? p256();
  const keyId = o.keyId ?? 'fixture-key-1';
  const records = makeRecords(counts.reduce((a, b) => a + b, 0), 1, '');
  const checkpoints = [];
  let at = 0;
  let prevCpHash = '';
  counts.forEach((count, i) => {
    const no = i + 1;
    const recs = records.slice(at, at + count);
    at += count;
    const leaves = recs.map((r) => (o.leaf ? o.leaf(r) : leafHash(leafInput(r.seq, r.recSha, r.salt))));
    const root = mth(leaves, o.nodePrefix ?? 0x01);
    const body = {
      v: 'PEAKET-checkpoint-v1',
      no,
      firstSeq: recs[0].seq,
      lastSeq: recs.at(-1).seq,
      leafCount: count,
      merkleRoot: root.toString('hex'),
      prevCheckpointHash: o.prevOverride?.[no] ?? prevCpHash,
      createdAt: new Date(Date.UTC(2026, 10, 20 + no, 15, 10, 0, 7)).toISOString(),
      ...(o.extra?.[no] ?? {}),
    };
    const json = canonical(body);
    const hash = sha256(Buffer.from(json, 'utf8'));
    const signature = signB64(key.privateKey, Buffer.from(json, 'utf8'));
    checkpoints.push({ no, body, json, hash: hash.toString('hex'), signature, ots: otsFile(hash), recs, leaves, nodePrefix: o.nodePrefix ?? 0x01 });
    prevCpHash = hash.toString('hex');
  });
  return { key, keyId, records, checkpoints };
}

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const tempDir = (tag) => {
  const d = mkdtempSync(join(tmpdir(), `audit-verify-test-${tag}-`));
  roots.push(d);
  return d;
};
const base = (no) => `checkpoints/${String(no).padStart(10, '0')}`;

/** 결정 6의 자리에 공개 파일을 쓴다. 돌려주는 값은 내려받은 폴더(transparency/v1의 위)다 */
function writeFolder(chain, o = {}) {
  const root = tempDir(o.tag ?? 'pub');
  const v1 = join(root, 'transparency', 'v1');
  mkdirSync(join(v1, 'checkpoints'), { recursive: true });
  const keys = o.keys ?? [{ keyId: chain.keyId, alg: 'ECDSA_P256_SHA256', publicKeyPem: pemOf(chain.key.publicKey), firstUsedAt: '2026-11-21T15:10:00.007Z' }];
  writeFileSync(join(v1, 'public-keys.json'), JSON.stringify({ version: 1, keys }));
  const entries = [];
  for (const c of chain.checkpoints) {
    writeFileSync(join(v1, `${base(c.no)}.json`), c.json, 'utf8');
    writeFileSync(join(v1, `${base(c.no)}.sig`), c.signature, 'ascii');
    writeFileSync(join(v1, `${base(c.no)}.ots`), c.ots);
    if (c.completeOts) writeFileSync(join(v1, `${base(c.no)}.complete.ots`), c.completeOts);
    entries.push({
      no: c.no,
      checkpointHash: c.hash,
      json: `transparency/v1/${base(c.no)}.json`,
      sig: `transparency/v1/${base(c.no)}.sig`,
      ots: `transparency/v1/${base(c.no)}.ots`,
      ...(c.completeOts ? { completeOts: `transparency/v1/${base(c.no)}.complete.ots` } : {}),
    });
  }
  writeFileSync(join(v1, 'index.json'), JSON.stringify({ version: 1, checkpoints: o.indexEntries ? o.indexEntries(entries) : entries }));
  return { root, v1 };
}

/** 결정 8의 검증 묶음(기록 seq 하나). change로 칸을 바꿔 틀린 묶음을 만든다 */
function writeBundle(chain, seq, change = (b) => b) {
  const cp = chain.checkpoints.find((c) => c.body.firstSeq <= seq && seq <= c.body.lastSeq);
  const index = seq - cp.body.firstSeq;
  const rec = cp.recs[index];
  const bundle = change({
    version: 1,
    checkpoint: {
      no: cp.no,
      checkpointId: randomUUID(),
      json: cp.json,
      checkpointHash: cp.hash,
      signature: cp.signature,
      keyId: chain.keyId,
      signatureAlg: 'ECDSA_P256_SHA256',
      publicKeyPem: pemOf(chain.key.publicKey),
      otsProof: cp.ots.toString('base64'),
    },
    record: { seq, recordJson: rec.recordJson, prevHash: rec.prevHash, recordSha256: rec.recSha.toString('hex'), leafSalt: rec.salt.toString('hex') },
    inclusionProof: { leafIndex: index, treeSize: cp.leaves.length, path: pathOf(index, cp.leaves, cp.nodePrefix).map((b) => b.toString('hex')) },
  });
  const file = join(tempDir('bundle'), `bundle-${seq}.json`);
  writeFileSync(file, JSON.stringify(bundle), 'utf8');
  return file;
}

// ---- 도구 부르기 ----

function runTool(args) {
  const r = spawnSync(PYTHON, ['-I', '-X', 'utf8', TOOL, ...args, '--json'], { encoding: 'utf8', timeout: 120_000 });
  if (r.error) throw r.error;
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    assert.fail(`도구 출력이 JSON이 아니다(끝 코드 ${r.status}): ${r.stdout}\n${r.stderr}`);
  }
  // 출력의 exitCode와 실제 끝 코드가 같다
  assert.equal(out.exitCode, r.status, r.stderr);
  return { code: r.status, out };
}
const stepsOf = (out, step, status) => out.steps.filter((s) => s.step === step && (status === undefined || s.status === status));
const targetsOf = (out, step, status) => stepsOf(out, step, status).map((s) => s.target).sort();
const statuses = (out) => new Set(out.steps.map((s) => s.status));

// ---- 시험 ----

describe('C-T38 ③ 공개 폴더 검증(사슬·서명·루트·증명 머리)', () => {
  test('C-T38 ③ 기록 수가 다른 체크포인트 셋(2·3·5)의 폴더를 --skip-bitcoin으로 통과시킨다(끝 코드 0)', () => {
    const closed = [randomUUID(), randomUUID()].sort();
    const chain = makeChain([2, 3, 5], { extra: { 2: { closedEvents: closed }, 3: { accessLogDayAnchor: randomBytes(32).toString('hex') } } });
    const { root } = writeFolder(chain);
    const { code, out } = runTool([root, '--skip-bitcoin']);
    assert.equal(code, 0);
    assert.equal(typeof out.openssl, 'string', '서명은 openssl로 판정해야 한다(시험 환경에 openssl이 필요하다)');
    assert.deepEqual(out.inputErrors, []);
    assert.deepEqual(targetsOf(out, 'checkpoint-json', 'ok'), ['no 1', 'no 2', 'no 3']);
    assert.deepEqual(targetsOf(out, 'signature', 'ok'), ['no 1', 'no 2', 'no 3']);
    assert.deepEqual(targetsOf(out, 'chain', 'ok'), ['no 1', 'no 2', 'no 3']);
    assert.deepEqual(targetsOf(out, 'ots', 'ok'), ['no 1', 'no 2', 'no 3']);
    assert.deepEqual(targetsOf(out, 'bitcoin', 'skipped'), ['no 1', 'no 2', 'no 3']);
    assert.equal(stepsOf(out, 'numbers', 'ok').length, 1);
    // 일 앵커 칸이 없는 체크포인트는 '없음'이고 실패로 세지 않는다(ADR-0348 결정 9)
    assert.deepEqual(targetsOf(out, 'access-log-day-anchor', 'absent'), ['no 1', 'no 2']);
    assert.equal(statuses(out).has('mismatch'), false);
    assert.equal(statuses(out).has('unverified'), false);
  });

  test('C-T38 ③ 완료 증명(.complete.ots, 비트코인 증명)이 있어도 통과하고, 비트코인 증명이 없는 완료 파일은 어긋남이다', () => {
    const chain = makeChain([1, 2]);
    chain.checkpoints[0].completeOts = otsFile(Buffer.from(chain.checkpoints[0].hash, 'hex'), { bitcoinHeight: 912_345 });
    const good = runTool([writeFolder(chain).root, '--skip-bitcoin']);
    assert.equal(good.code, 0);
    assert.deepEqual(targetsOf(good.out, 'ots', 'ok'), ['no 1 대기', 'no 1 완료', 'no 2']);

    chain.checkpoints[0].completeOts = otsFile(Buffer.from(chain.checkpoints[0].hash, 'hex'));
    const bad = runTool([writeFolder(chain).root, '--skip-bitcoin']);
    assert.equal(bad.code, 1);
    assert.deepEqual(targetsOf(bad.out, 'ots-complete', 'mismatch'), ['no 1 완료']);
  });

  test('C-T38 ③ 증명 파일의 대상 해시가 체크포인트 해시와 다르면 어긋남이다', () => {
    const chain = makeChain([3, 2]);
    chain.checkpoints[1].ots = otsFile(randomBytes(32));
    const { code, out } = runTool([writeFolder(chain).root, '--skip-bitcoin']);
    assert.equal(code, 1);
    assert.deepEqual(targetsOf(out, 'ots', 'mismatch'), ['no 2']);
    assert.deepEqual(targetsOf(out, 'ots', 'ok'), ['no 1']);
  });

  test('C-T38 ③ RFC 8785 정규형이 아닌 바이트(같은 값, 공백 들임)는 서명이 맞아도 어긋남이다', () => {
    const chain = makeChain([2, 2]);
    const c = chain.checkpoints[1];
    c.json = JSON.stringify(JSON.parse(c.json), null, 1);
    c.hash = sha256(Buffer.from(c.json, 'utf8')).toString('hex');
    c.signature = signB64(chain.key.privateKey, Buffer.from(c.json, 'utf8'));
    c.ots = otsFile(Buffer.from(c.hash, 'hex'));
    const { code, out } = runTool([writeFolder(chain).root, '--skip-bitcoin']);
    assert.equal(code, 1);
    assert.deepEqual(targetsOf(out, 'checkpoint-json', 'mismatch'), ['no 2']);
  });
});

describe('B360-TOOL 끝 코드(ADR-0348 결정 7: 0 통과·1 어긋남·2 입력 오류·3 일부 확인 못 함)', () => {
  test('B360-TOOL ① --skip-bitcoin이 없으면 비트코인 단계가 확인 못 함이라 끝 코드 3이다(0이 아니다)', () => {
    const chain = makeChain([1, 3]);
    const { code, out } = runTool([writeFolder(chain).root]);
    assert.equal(code, 3);
    assert.deepEqual(targetsOf(out, 'bitcoin', 'unverified'), ['no 1', 'no 2']);
    assert.equal(statuses(out).has('mismatch'), false);
    assert.deepEqual(targetsOf(out, 'signature', 'ok'), ['no 1', 'no 2']);
  });

  test('B360-TOOL ② 없는 폴더는 입력 오류 2다', () => {
    const missing = join(tempDir('missing'), 'no-such-folder');
    const { code, out } = runTool([missing, '--skip-bitcoin']);
    assert.equal(code, 2);
    assert.equal(out.inputErrors.length, 1);
    assert.ok(out.inputErrors[0].includes('no-such-folder'), out.inputErrors[0]);
    assert.deepEqual(out.steps, []);
  });

  test('B360-TOOL ③ 읽지 못하는 index.json·public-keys.json은 입력 오류 2다', () => {
    const chain = makeChain([2]);
    const a = writeFolder(chain);
    writeFileSync(join(a.v1, 'index.json'), '{"version":1,"checkpoints":[', 'utf8');
    const r1 = runTool([a.root, '--skip-bitcoin']);
    assert.equal(r1.code, 2);
    assert.equal(r1.out.inputErrors.length, 1);
    assert.ok(r1.out.inputErrors[0].includes('index.json'), r1.out.inputErrors[0]);

    const b = writeFolder(chain);
    writeFileSync(join(b.v1, 'public-keys.json'), JSON.stringify({ version: 2, keys: [] }), 'utf8');
    const r2 = runTool([b.root, '--skip-bitcoin']);
    assert.equal(r2.code, 2);
    assert.ok(r2.out.inputErrors[0].includes('public-keys.json'), r2.out.inputErrors[0]);
  });

  test('B360-TOOL ④ openssl 경로가 없으면 서명 단계는 확인 못 함이고 끝 코드 3이다', () => {
    const chain = makeChain([2, 1]);
    const { code, out } = runTool([writeFolder(chain).root, '--skip-bitcoin', '--openssl', join(tempDir('nossl'), 'openssl-not-here')]);
    assert.equal(code, 3);
    assert.equal(out.openssl, null);
    assert.deepEqual(targetsOf(out, 'signature', 'unverified'), ['no 1', 'no 2']);
    assert.deepEqual(stepsOf(out, 'signature', 'ok'), []);
  });

  test('B360-TOOL ⑤ 어긋남이 있으면 확인 못 한 단계가 함께 있어도 끝 코드 1이다', () => {
    const chain = makeChain([2, 2]);
    chain.checkpoints[1].ots = otsFile(randomBytes(32));
    const { code, out } = runTool([writeFolder(chain).root]);
    assert.equal(code, 1);
    assert.equal(stepsOf(out, 'bitcoin', 'unverified').length > 0, true);
    assert.deepEqual(targetsOf(out, 'ots', 'mismatch'), ['no 2']);
  });

  test('B360-TOOL ⑥ 목록에 있지만 받지 못한 체크포인트·서명 파일은 확인 못 함(3)이고 번호 빈틈으로 세지 않는다', () => {
    const chain = makeChain([2, 3, 1]);
    const { root, v1 } = writeFolder(chain);
    unlinkSync(join(v1, `${base(3)}.json`));
    unlinkSync(join(v1, `${base(2)}.sig`));
    const { code, out } = runTool([root, '--skip-bitcoin']);
    assert.equal(code, 3);
    assert.deepEqual(targetsOf(out, 'file', 'unverified'), ['no 3']);
    assert.deepEqual(targetsOf(out, 'signature', 'unverified'), ['no 2']);
    assert.deepEqual(targetsOf(out, 'signature', 'ok'), ['no 1']);
    assert.equal(stepsOf(out, 'numbers', 'ok').length, 1);
    assert.equal(statuses(out).has('mismatch'), false);
  });
});

describe('C-T40 체크포인트 사슬의 빈틈과 바꿔치기', () => {
  test('C-T40 ① 공개 목록에서 가운데 체크포인트를 빼면 번호 빈틈으로 실패한다(끝 코드 1)', () => {
    const chain = makeChain([2, 3, 2]);
    const { root, v1 } = writeFolder(chain, { indexEntries: (e) => e.filter((x) => x.no !== 2) });
    for (const ext of ['json', 'sig', 'ots']) unlinkSync(join(v1, `${base(2)}.${ext}`));
    const { code, out } = runTool([root, '--skip-bitcoin']);
    assert.equal(code, 1);
    const numbers = stepsOf(out, 'numbers');
    assert.equal(numbers.length, 1);
    assert.equal(numbers[0].status, 'mismatch');
    assert.match(numbers[0].detail, /번호 빈틈: 2\(/);
    // 빠진 번호 뒤의 사슬은 확인 못 함이다(통과로 새지 않는다)
    assert.deepEqual(targetsOf(out, 'chain', 'unverified'), ['no 3']);
  });

  test('C-T40 ② 같은 번호의 다른 체크포인트(다른 루트, 서명은 맞음)를 다른 폴더에서 받으면 둘 다 보고한다', () => {
    const key = p256();
    const a = makeChain([2, 3], { key });
    const b = makeChain([2, 3], { key });
    // 두 폴더의 no 1은 같은 바이트, no 2만 다른 기록(다른 루트)으로 만든다
    b.checkpoints[0] = a.checkpoints[0];
    const c2 = b.checkpoints[1];
    c2.body = { ...c2.body, prevCheckpointHash: a.checkpoints[0].hash };
    c2.json = canonical(c2.body);
    c2.hash = sha256(Buffer.from(c2.json, 'utf8')).toString('hex');
    c2.signature = signB64(key.privateKey, Buffer.from(c2.json, 'utf8'));
    c2.ots = otsFile(Buffer.from(c2.hash, 'hex'));
    assert.notEqual(c2.body.merkleRoot, a.checkpoints[1].body.merkleRoot);
    const fa = writeFolder(a, { tag: 'site-a' });
    const fb = writeFolder(b, { tag: 'site-b' });
    const { code, out } = runTool([fa.root, fb.root, '--skip-bitcoin']);
    assert.equal(code, 1);
    const same = stepsOf(out, 'same-number', 'mismatch');
    assert.deepEqual(
      same.map((s) => s.target),
      ['no 2'],
    );
    // 두 체크포인트를 둘 다 보인다(해시 둘)
    assert.ok(same[0].detail.includes(a.checkpoints[1].hash), same[0].detail);
    assert.ok(same[0].detail.includes(c2.hash), same[0].detail);
    // 각 체크포인트의 서명은 맞다(서명만으로는 바꿔치기를 막지 못한다)
    assert.equal(stepsOf(out, 'signature', 'ok').length, 4);
  });

  test('C-T40 ③ 한 폴더의 목록에 같은 번호가 두 번(다른 해시) 있으면 두 해시를 모두 보고한다', () => {
    const chain = makeChain([1, 2]);
    const other = randomBytes(32).toString('hex');
    const { root } = writeFolder(chain, { indexEntries: (e) => [...e, { ...e[1], checkpointHash: other }] });
    const { code, out } = runTool([root, '--skip-bitcoin']);
    assert.equal(code, 1);
    const listed = stepsOf(out, 'same-number', 'mismatch').filter((s) => s.target === 'index.json no 2');
    assert.equal(listed.length, 1);
    assert.ok(listed[0].detail.includes(chain.checkpoints[1].hash) && listed[0].detail.includes(other), listed[0].detail);
  });

  test('C-T40 ④ 직전 해시를 바꿔치기한 체크포인트(다시 서명함)는 사슬 불일치로 실패한다', () => {
    const chain = makeChain([2, 2, 3], { prevOverride: { 3: randomBytes(32).toString('hex') } });
    const { code, out } = runTool([writeFolder(chain).root, '--skip-bitcoin']);
    assert.equal(code, 1);
    assert.deepEqual(targetsOf(out, 'chain', 'mismatch'), ['no 3']);
    assert.deepEqual(targetsOf(out, 'chain', 'ok'), ['no 1', 'no 2']);
    assert.deepEqual(targetsOf(out, 'signature', 'ok'), ['no 1', 'no 2', 'no 3']);
  });

  test('C-T40 ⑤ 기록 구간이 이어지지 않거나 첫 체크포인트가 seq 1부터가 아니면 사슬 불일치다', () => {
    const chain = makeChain([2, 2]);
    const c = chain.checkpoints[1];
    c.body = { ...c.body, firstSeq: c.body.firstSeq + 1, leafCount: c.body.leafCount - 1 };
    c.json = canonical(c.body);
    c.hash = sha256(Buffer.from(c.json, 'utf8')).toString('hex');
    c.signature = signB64(chain.key.privateKey, Buffer.from(c.json, 'utf8'));
    c.ots = otsFile(Buffer.from(c.hash, 'hex'));
    const r1 = runTool([writeFolder(chain).root, '--skip-bitcoin']);
    assert.equal(r1.code, 1);
    assert.deepEqual(targetsOf(r1.out, 'chain', 'mismatch'), ['no 2']);

    const first = makeChain([3]);
    const f = first.checkpoints[0];
    f.body = { ...f.body, firstSeq: 2, lastSeq: 4 };
    f.json = canonical(f.body);
    f.hash = sha256(Buffer.from(f.json, 'utf8')).toString('hex');
    f.signature = signB64(first.key.privateKey, Buffer.from(f.json, 'utf8'));
    f.ots = otsFile(Buffer.from(f.hash, 'hex'));
    const r2 = runTool([writeFolder(first).root, '--skip-bitcoin']);
    assert.equal(r2.code, 1);
    assert.deepEqual(targetsOf(r2.out, 'chain', 'mismatch'), ['no 1']);
  });
});

describe('C-T39 검증 묶음으로 기록 하나 확인', () => {
  // 기록 수 1·2·3·5·8인 체크포인트 다섯(공개 사슬 하나)
  const SIZES = [1, 2, 3, 5, 8];
  const chain = makeChain(SIZES);
  const folder = writeFolder(chain, { tag: 'bundle-pub' });
  const seqsOf = (c) => [...new Set([c.body.firstSeq, c.body.firstSeq + Math.floor(c.leaves.length / 2), c.body.lastSeq])];

  test('C-T39 ① 기록 수 1·2·3·5·8마다 첫·가운데·끝 잎의 묶음이 기록 → 기록 해시 → 잎 → 포함 증명 → 루트·서명·증명까지 통과한다', () => {
    const seqs = chain.checkpoints.flatMap(seqsOf);
    assert.equal(seqs.length, 1 + 2 + 3 + 3 + 3);
    const { code, out } = runTool([folder.root, '--skip-bitcoin', ...seqs.flatMap((s) => ['--bundle', writeBundle(chain, s)])]);
    assert.equal(code, 0);
    const labels = seqs.map((s) => `묶음 seq ${s}`).sort();
    assert.deepEqual(targetsOf(out, 'record', 'ok'), labels);
    assert.deepEqual(targetsOf(out, 'inclusion', 'ok'), labels);
    assert.deepEqual(targetsOf(out, 'bundle-folder', 'ok'), labels);
    assert.deepEqual(
      stepsOf(out, 'signature', 'ok')
        .map((s) => s.target)
        .filter((t) => t.startsWith('묶음'))
        .sort(),
      labels,
    );
    assert.equal(statuses(out).has('mismatch'), false);
  });

  test('C-T39 ② 기록 정규화 값의 한 글자를 바꾸면 기록 해시가, 기록 해시까지 다시 계산하면 포함 증명이 실패한다', () => {
    const c5 = chain.checkpoints[3];
    const seq = c5.body.firstSeq + 2;
    const oneChar = (rj) => rj.replace(`감사 점검 기록 ${seq}`, `감사 점검 기룩 ${seq}`);
    const onlyText = writeBundle(chain, seq, (b) => ({ ...b, record: { ...b.record, recordJson: oneChar(b.record.recordJson) } }));
    const r1 = runTool([folder.root, '--skip-bitcoin', '--bundle', onlyText]);
    assert.equal(r1.code, 1);
    assert.deepEqual(targetsOf(r1.out, 'record', 'mismatch'), [`묶음 seq ${seq}`]);

    const rehashed = writeBundle(chain, seq, (b) => {
      const recordJson = oneChar(b.record.recordJson);
      return { ...b, record: { ...b.record, recordJson, recordSha256: sha256(Buffer.from(b.record.prevHash, 'utf8'), Buffer.from(recordJson, 'utf8')).toString('hex') } };
    });
    const r2 = runTool([folder.root, '--skip-bitcoin', '--bundle', rehashed]);
    assert.equal(r2.code, 1);
    assert.deepEqual(targetsOf(r2.out, 'record', 'ok'), [`묶음 seq ${seq}`]);
    assert.deepEqual(targetsOf(r2.out, 'inclusion', 'mismatch'), [`묶음 seq ${seq}`]);
  });

  test('C-T39 ③ 다른 기록의 잎 솔트를 넣으면 기록 수 5·8의 가운데·끝 잎 모두 포함 증명이 실패한다', () => {
    const targets = [chain.checkpoints[3], chain.checkpoints[4]].flatMap((c) => [c.body.firstSeq + Math.floor(c.leaves.length / 2), c.body.lastSeq]);
    const bundles = targets.map((seq) => {
      const other = chain.records.find((r) => r.seq === (seq === 1 ? 2 : seq - 1));
      return writeBundle(chain, seq, (b) => ({ ...b, record: { ...b.record, leafSalt: other.salt.toString('hex') } }));
    });
    const { code, out } = runTool([folder.root, '--skip-bitcoin', ...bundles.flatMap((f) => ['--bundle', f])]);
    assert.equal(code, 1);
    assert.deepEqual(targetsOf(out, 'inclusion', 'mismatch'), targets.map((s) => `묶음 seq ${s}`).sort());
    assert.deepEqual(stepsOf(out, 'inclusion', 'ok'), []);
  });

  test('C-T39 ④ 공개 키 목록에 없는 키로 서명한 묶음은 서명이 맞아도 실패한다', () => {
    const intruder = p256();
    const c3 = chain.checkpoints[2];
    const seq = c3.body.firstSeq + 1;
    const forged = writeBundle(chain, seq, (b) => ({
      ...b,
      checkpoint: { ...b.checkpoint, publicKeyPem: pemOf(intruder.publicKey), signature: signB64(intruder.privateKey, Buffer.from(b.checkpoint.json, 'utf8')) },
    }));
    const { code, out } = runTool([folder.root, '--skip-bitcoin', '--bundle', forged]);
    assert.equal(code, 1);
    assert.deepEqual(targetsOf(out, 'signature', 'mismatch'), [`묶음 seq ${seq}`, `묶음 seq ${seq}`]);
  });

  test('C-T39 ⑤ 폴더 없이 묶음만 주면 묶음의 키가 공개 목록에 있는지 몰라 확인 못 함(3)이다', () => {
    const seq = chain.checkpoints[1].body.lastSeq;
    const { code, out } = runTool(['--skip-bitcoin', '--bundle', writeBundle(chain, seq)]);
    assert.equal(code, 3);
    assert.deepEqual(targetsOf(out, 'inclusion', 'ok'), [`묶음 seq ${seq}`]);
    assert.deepEqual(targetsOf(out, 'signature', 'unverified'), [`묶음 seq ${seq}`]);
  });
});

describe('C-T42 기록 파기 뒤 공개 루트', () => {
  test('C-T42 ① 공개 폴더 어디에도 기록 원문·기록 ID·잎 솔트가 없다', () => {
    const chain = makeChain([3, 5]);
    const { root } = writeFolder(chain);
    const files = [];
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(readFileSync(p));
      }
    };
    walk(root);
    assert.equal(files.length, 2 + 3 * 2);
    for (const r of chain.records) {
      for (const f of files) {
        assert.equal(f.includes(Buffer.from(r.recordJson, 'utf8')), false);
        assert.equal(f.includes(Buffer.from(r.recordId, 'ascii')), false);
        assert.equal(f.includes(Buffer.from(r.salt.toString('hex'), 'ascii')), false);
        assert.equal(f.includes(r.salt), false);
      }
    }
  });

  test('C-T42 ② 기록과 잎 솔트를 모두 버린 뒤에도 공개 폴더만으로 사슬·서명·증명 검증이 통과한다', () => {
    const chain = makeChain([4, 1, 3]);
    const { root } = writeFolder(chain);
    // 파기: 시험이 가진 기록·솔트를 버린다(도구에 넘기지 않는다)
    chain.records.length = 0;
    for (const c of chain.checkpoints) c.recs = [];
    const { code, out } = runTool([root, '--skip-bitcoin']);
    assert.equal(code, 0);
    assert.deepEqual(targetsOf(out, 'chain', 'ok'), ['no 1', 'no 2', 'no 3']);
    assert.deepEqual(targetsOf(out, 'signature', 'ok'), ['no 1', 'no 2', 'no 3']);
    assert.deepEqual(targetsOf(out, 'ots', 'ok'), ['no 1', 'no 2', 'no 3']);
    assert.deepEqual(stepsOf(out, 'record'), []);
  });
});

describe('ASVS 암호 요건(공개 검증 도구)', () => {
  test('[ASVS v5.0.0-11.4.3] 안쪽 노드 접두를 0x00으로 만든 루트의 묶음은 포함 증명이 실패한다(M6)', () => {
    const chain = makeChain([5], { nodePrefix: 0x00 });
    const { root } = writeFolder(chain);
    const { code, out } = runTool([root, '--skip-bitcoin', '--bundle', writeBundle(chain, 2), '--bundle', writeBundle(chain, 5)]);
    assert.equal(code, 1);
    assert.deepEqual(targetsOf(out, 'inclusion', 'mismatch'), ['묶음 seq 2', '묶음 seq 5']);
    // 서명·사슬은 맞는 체크포인트다(루트 계산만 틀렸다)
    assert.deepEqual(targetsOf(out, 'signature', 'ok'), ['no 1', '묶음 seq 2', '묶음 seq 5']);
  });

  test('[ASVS v5.0.0-11.4.3] 잎 입력에서 솔트를 뺀 루트의 묶음은 포함 증명이 실패한다(M5)', () => {
    const chain = makeChain([8], { leaf: (r) => leafHash(leafInput(r.seq, r.recSha, r.salt, { noSalt: true })) });
    const { root } = writeFolder(chain);
    const { code, out } = runTool([root, '--skip-bitcoin', '--bundle', writeBundle(chain, 4), '--bundle', writeBundle(chain, 8)]);
    assert.equal(code, 1);
    assert.deepEqual(targetsOf(out, 'inclusion', 'mismatch'), ['묶음 seq 4', '묶음 seq 8']);
  });

  test('[ASVS v5.0.0-11.4.3] 잎 해시 접두(0x00) 없이 만든 잎의 묶음도 포함 증명이 실패한다', () => {
    const chain = makeChain([3], { leaf: (r) => sha256(leafInput(r.seq, r.recSha, r.salt)) });
    const { root } = writeFolder(chain);
    const { code, out } = runTool([root, '--skip-bitcoin', '--bundle', writeBundle(chain, 3)]);
    assert.equal(code, 1);
    assert.deepEqual(targetsOf(out, 'inclusion', 'mismatch'), ['묶음 seq 3']);
  });

  test('[ASVS v5.0.0-11.2.1] 서명 1바이트를 바꾸면 openssl 확인이 실패해 서명 어긋남이다', () => {
    const chain = makeChain([2, 2]);
    const c = chain.checkpoints[1];
    const der = Buffer.from(c.signature, 'base64');
    der[der.length - 1] ^= 0x01;
    c.signature = der.toString('base64');
    const { code, out } = runTool([writeFolder(chain).root, '--skip-bitcoin']);
    assert.equal(code, 1);
    assert.equal(typeof out.openssl, 'string');
    assert.deepEqual(targetsOf(out, 'signature', 'mismatch'), ['no 2']);
    assert.deepEqual(targetsOf(out, 'signature', 'ok'), ['no 1']);
  });

  test('[ASVS v5.0.0-11.2.3] P-384·secp256k1 키로 서명한 체크포인트는 P-256이 아니라 서명 어긋남이다', () => {
    for (const namedCurve of ['secp384r1', 'secp256k1']) {
      const key = generateKeyPairSync('ec', { namedCurve });
      const chain = makeChain([2], { key, keyId: `fixture-${namedCurve}` });
      const { code, out } = runTool([writeFolder(chain).root, '--skip-bitcoin']);
      assert.equal(code, 1, namedCurve);
      const sig = stepsOf(out, 'signature');
      assert.equal(sig.length, 1, namedCurve);
      assert.equal(sig[0].status, 'mismatch', namedCurve);
      assert.match(sig[0].detail, /P-256 공개키가 아니다/, namedCurve);
    }
  });
});
