// 감사 공개 앵커의 실제 PostgreSQL 18·AWS 흉내 서버(moto 5.2.5) 통합 시험(BAT-360 OPS-280, ADR-0348, ADR-0075, control-tower §14 C-T38·C-T41·C-T42).
// - C-T38 ①: 감사 기록 100건을 쓴 뒤 일 체크포인트 실행 한 번이 감사 앵커 버킷과 공개 게시 버킷(moto S3)에 같은 JSON·서명·대기 증명을 남긴다.
//   서명은 같은 알고리즘(ECDSA P-256)의 local 서명기다: moto 5.2.5는 KMS Sign의 MessageType DIGEST를 RAW처럼 다시 해시해 서명하므로(2026-11-22 시험 담당이 확인,
//   DIGEST 서명은 SHA-256(다이제스트) 위 서명이 된다) 실제 KMS의 DIGEST 서명 바이트는 흉내 서버로 볼 수 없다(계획 14절 3 '안 되면 미검증(클라우드)').
//   KMS 요청 꼴(MessageType DIGEST·ECDSA_SHA_256, 다이제스트 32바이트)은 단위 시험 audit-checkpoint-bytes가, moto KMS 키 꼴 받기는 아래 [ASVS v5.0.0-11.6.1] 시험이 본다.
//   작업은 DB 역할 ops_audit_anchor로 붙고 감사 체인에 기록을 더하지 않는다(결정 11).
// - C-T38 ③: 두 버킷에서 받은 폴더를 공개 검증 도구(tools/audit-verify, 파이썬·openssl)가 통과시킨다(--skip-bitcoin, 비트코인 단계는 공식 클라이언트 몫).
// - C-T41: 캘린더를 모두 막아도(닿지 않는 주소 + 실패하는 가짜) 체크포인트·서명은 DB에 남고 게시하지 않으며, 다음 실행에서 다시 찍는다.
// - C-T42: 감사 기록(정규화 기록·잎 솔트) 행을 지운 뒤에도 공개 폴더만으로 검증 도구가 통과하고, 공개 파일에는 기록 원문·솔트가 없다.
// - B12: 작업 역할 ops_audit_anchor는 audit_chain·audit_chain_head를 쓰지 못한다(SET ROLE로 본다).
// - B7: 서명 전 체크포인트의 루트가 어긋나면 작업은 서명·게시하지 않고 SEV2 조건을 낸다(경보는 ops-svc 신호 바퀴 몫, 단위 시험 audit-checkpoint-signals).
import 'reflect-metadata';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateKeyCommand, GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createDatabase, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import {
  AuditCheckpointPublisher,
  DrizzleAuditChain,
  DrizzleAuditPublishStore,
  HttpOpenTimestampsCalendar,
  KmsCheckpointSigner,
  ephemeralCheckpointSigner,
  type CheckpointSigner,
  MemoryOpenTimestampsCalendar,
  S3AuditPublicStore,
  kmsCheckpointSignerClient,
  type OpenTimestampsCalendar,
} from '../src/modules/audit/index.js';
import { CreateCommand, DrizzleCommandStore } from '../src/modules/commands/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const REGION = 'ap-northeast-2';
const PUBLIC_BUCKET = 'peaket-it-transparency-public';
const ANCHOR_BUCKET = 'peaket-it-audit-anchor';
const TOOL = fileURLToPath(new URL('../../../tools/audit-verify/audit_verify.py', import.meta.url));
const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const HOUR = 60 * 60_000;
/** 2026-11-26 00:10 KST(일 체크포인트가 생길 수 있는 첫 때, 결정 9) */
const DAY1 = Date.parse('2026-11-26T00:10:00.000+09:00');
const DAY2 = Date.parse('2026-11-27T00:10:00.000+09:00');
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
const sha = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

let container: PostgresContainer;
let admin: pg.Client;
let db: Database;
let jobDb: Database;
let moto = '';
let endpoint = '';
let keyId = '';
let kms: KMSClient;
let s3: S3Client;
const work: string[] = [];

beforeAll(async () => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
  vi.stubEnv('AWS_REGION', REGION);
  container = await startPostgres();
  await migrateOps(container.url);
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  // 게시 작업의 로그인 사용자: 역할 ops_audit_anchor의 권한만 갖는다(운영 배포와 같은 꼴, 결정 11)
  await admin.query("CREATE ROLE audit_anchor_it LOGIN PASSWORD 'anchor-it' IN ROLE ops_audit_anchor");
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-public-anchor-it' });
  jobDb = createDatabase({ url: container.urlFor('audit_anchor_it', 'anchor-it'), applicationName: 'ops-svc-audit-anchor-it' });
  const prefix = process.env.PEAKET_TEST_CONTAINER_PREFIX;
  moto = docker(['run', '-d', '--rm', ...(prefix ? ['--name', `${prefix}moto-${Math.random().toString(36).slice(2, 8)}`] : []), '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  const mapped = docker(['port', moto, '5000/tcp']).split('\n')[0]!;
  endpoint = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  kms = new KMSClient({ endpoint, region: REGION, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  s3 = new S3Client({ endpoint, region: REGION, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      keyId = (await kms.send(new CreateKeyCommand({ KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY' }))).KeyMetadata!.KeyId!;
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      // 흉내 서버가 뜰 때까지 조건으로 기다린다(CreateKey가 될 때까지 다시)
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}, 180_000);

afterAll(async () => {
  await jobDb?.close().catch(() => undefined);
  await db?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  container?.stop();
  if (moto) {
    try {
      docker(['rm', '-f', '-v', moto]);
    } catch {
      // 이미 멈췄다
    }
  }
  for (const d of work) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** 시험마다 체인·체크포인트를 비우고, 버킷은 실행 ID를 붙여 새로 만든다 */
let runId = '';
beforeEach(async () => {
  await admin.query('truncate ops_command, command_event, command_approval, command_actor, audit_chain, audit_checkpoint, audit_signing_key, ops_alert, idempotency_record cascade');
  await admin.query("update audit_chain_head set last_seq = 0, last_hash = ''::bytea where id = 1");
  runId = randomUUID().slice(0, 8);
});

/** 감사 기록 n건(명령 접수 LOG_LEVEL 하나가 기록 하나) */
async function seed(n: number, atMs: number): Promise<string[]> {
  const create = new CreateCommand(new DrizzleCommandStore(db));
  const reasons: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const reason = `공개 앵커 통합 ${runId} ${i}`;
    reasons.push(reason);
    await create.execute({ type: 'LOG_LEVEL', reason, params: { level: 'DEBUG' }, requestedBy: randomUUID(), requestedRole: 'operator', nowMs: atMs + i });
  }
  return reasons;
}

/** 시험마다 버킷 두 개를 새로 만든다(같은 이름에 다른 바이트가 섞이지 않게) */
async function buckets(): Promise<{ pub: string; anc: string }> {
  const pub = `${PUBLIC_BUCKET}-${runId}`;
  const anc = `${ANCHOR_BUCKET}-${runId}`;
  for (const Bucket of [pub, anc]) await s3.send(new CreateBucketCommand({ Bucket, ObjectLockEnabledForBucket: true, CreateBucketConfiguration: { LocationConstraint: REGION } }));
  return { pub, anc };
}

/** 시험 파일 하나의 서명 키(ECDSA P-256, KMS와 같은 알고리즘) */
const SIGNER = ephemeralCheckpointSigner('audit-anchor-it-key');

function publisher(o: { pub: string; anc: string; calendars?: readonly OpenTimestampsCalendar[]; signer?: CheckpointSigner }) {
  const signer = o.signer ?? SIGNER;
  const logs: Record<string, unknown>[] = [];
  const p = new AuditCheckpointPublisher({
    store: new DrizzleAuditPublishStore(jobDb),
    chain: new DrizzleAuditChain(jobDb),
    signer,
    calendars: o.calendars ?? [new MemoryOpenTimestampsCalendar('https://cal-it.audit-test.invalid')],
    targets: [new S3AuditPublicStore('public', { bucket: o.pub, region: REGION, endpoint }), new S3AuditPublicStore('anchor', { bucket: o.anc, region: REGION, endpoint })],
    log: (_level, fields) => logs.push(fields),
  });
  return { p, logs };
}

async function getObject(Bucket: string, Key: string): Promise<Buffer | undefined> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket, Key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  } catch {
    return undefined;
  }
}

/** 버킷의 transparency/ 아래를 폴더로 받는다(밖의 확인자가 내려받는 것과 같다) */
async function download(Bucket: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'ops-transparency-'));
  work.push(dir);
  const list = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: 'transparency/' }));
  for (const o of list.Contents ?? []) {
    const path = join(dir, ...o.Key!.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, (await getObject(Bucket, o.Key!))!);
  }
  return join(dir, 'transparency', 'v1');
}

const allFiles = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? allFiles(join(dir, n)) : [join(dir, n)]));

function tool(dirs: readonly string[]): { status: number | null; steps: { step: string; status: string }[] } {
  const r = spawnSync(PYTHON, ['-I', '-X', 'utf8', TOOL, ...dirs, '--skip-bitcoin', '--json'], { encoding: 'utf8', timeout: 120_000 });
  if (r.error) throw r.error;
  const out = JSON.parse(r.stdout) as { steps: { step: string; status: string }[] };
  return { status: r.status, steps: out.steps };
}

/** 정본 식(ADR-0348 결정 2)의 루트를 DB 행으로 따로 계산한다 */
async function expectedRoot(fromSeq: number, toSeq: number): Promise<string> {
  const rows = (await admin.query<{ seq: string; h: Buffer; salt: Buffer }>('select seq, record_sha256 as h, leaf_salt as salt from audit_chain where seq between $1 and $2 order by seq', [fromSeq, toSeq])).rows;
  const leaves = rows.map((r) => {
    const seq = Buffer.alloc(8);
    seq.writeBigUInt64BE(BigInt(r.seq));
    return sha(Buffer.from([0x00]), Buffer.from('PEAKET-audit-leaf-v1', 'ascii'), seq, r.h, r.salt);
  });
  const mth = (l: readonly Buffer[]): Buffer => {
    if (l.length === 1) return l[0]!;
    let k = 1;
    while (k * 2 < l.length) k *= 2;
    return sha(Buffer.from([0x01]), mth(l.slice(0, k)), mth(l.slice(k)));
  };
  return mth(leaves).toString('hex');
}

const file = (no: number, ext: string) => `transparency/v1/checkpoints/${String(no).padStart(10, '0')}.${ext}`;
const chainCount = async () => Number((await admin.query<{ n: string }>('select count(*)::text as n from audit_chain')).rows[0]!.n);

describe('C-T38 감사 체크포인트와 공개 타임스탬프(PostgreSQL·moto)', () => {
  test('C-T38 ① 감사 기록 100건 뒤 일 체크포인트가 두 버킷(moto S3)에 같은 JSON·서명·대기 증명을 남기고, 게시한 공개키로 JSON 바이트가 확인되며 작업 역할은 체인에 기록을 더하지 않는다', async () => {
    const { pub, anc } = await buckets();
    await seed(100, DAY1 - 2 * HOUR);
    expect(await chainCount()).toBe(100);
    const { p } = publisher({ pub, anc });
    const run = await p.run(DAY1);
    expect(run).toMatchObject({ created: [{ no: 1, kind: 'DAILY' }], signed: 1, stamped: 1, published: 1, mismatches: [], conflicts: [], errors: [] });
    expect(await chainCount()).toBe(100);
    const [row] = (await admin.query<{ checkpoint_json: string; hash: string; root: string; ots_state: string; published_at: Date | null; key_id: string; signature: string; from_seq: string; to_seq: string }>(
      "select checkpoint_json, encode(checkpoint_hash,'hex') as hash, encode(root_hash,'hex') as root, ots_state, published_at, key_id, signature, from_seq, to_seq from audit_checkpoint where no = 1",
    )).rows;
    expect(row).toMatchObject({ ots_state: 'PENDING', key_id: 'audit-anchor-it-key', from_seq: '1', to_seq: '100' });
    expect(row!.published_at).toBeInstanceOf(Date);
    const root = await expectedRoot(1, 100);
    expect(row!.root).toBe(root);
    expect(JSON.parse(row!.checkpoint_json)).toEqual({ v: 'PEAKET-checkpoint-v1', no: 1, firstSeq: 1, lastSeq: 100, leafCount: 100, merkleRoot: root, prevCheckpointHash: '', createdAt: new Date(DAY1).toISOString() });
    for (const ext of ['json', 'sig', 'ots']) {
      const a = await getObject(pub, file(1, ext));
      const b = await getObject(anc, file(1, ext));
      expect(a).toBeInstanceOf(Buffer);
      expect(a!.equals(b!)).toBe(true);
    }
    const json = (await getObject(pub, file(1, 'json')))!;
    expect(json.toString('utf8')).toBe(row!.checkpoint_json);
    expect(sha(json).toString('hex')).toBe(row!.hash);
    // 서명 키의 공개키로만 확인한다(확인은 node:crypto, 피켓 확인 코드를 거치지 않는다)
    const spki = await SIGNER.publicKeySpki();
    const sig = Buffer.from((await getObject(anc, file(1, 'sig')))!.toString('utf8'), 'base64');
    expect(verify('sha256', json, { key: createPublicKey({ key: spki, format: 'der', type: 'spki' }), dsaEncoding: 'der' }, sig)).toBe(true);
    const keys = JSON.parse((await getObject(pub, 'transparency/v1/public-keys.json'))!.toString('utf8')) as { keys: { keyId: string; alg: string; publicKeyPem: string }[] };
    expect(keys.keys).toEqual([expect.objectContaining({ keyId: 'audit-anchor-it-key', alg: 'ECDSA_P256_SHA256' })]);
    expect(createPublicKey(keys.keys[0]!.publicKeyPem).export({ type: 'spki', format: 'der' }).equals(spki)).toBe(true);
    const ots = (await getObject(pub, file(1, 'ots')))!;
    expect(ots.subarray(33, 65).toString('hex')).toBe(row!.hash);
  });

  test('C-T38 ③ 두 버킷에서 받은 폴더(체크포인트 둘)를 공개 검증 도구가 통과시키고, 한 버킷의 서명 파일을 바꾸면 실패한다', async () => {
    const { pub, anc } = await buckets();
    await seed(5, DAY1 - HOUR);
    const { p } = publisher({ pub, anc });
    expect((await p.run(DAY1)).published).toBe(1);
    await seed(3, DAY1 + HOUR);
    expect((await p.run(DAY2)).published).toBe(1);
    const a = await download(pub);
    const b = await download(anc);
    const ok = tool([a, b]);
    expect(ok.status).toBe(0);
    expect(ok.steps.filter((s) => s.step === 'signature' && s.status === 'ok').length).toBeGreaterThanOrEqual(2);
    expect(ok.steps.filter((s) => s.step === 'chain' && s.status === 'ok').length).toBeGreaterThanOrEqual(1);
    // 받은 쪽 한 폴더의 2번 서명을 1번 서명으로 바꿔치기하면 어긋남(끝 코드 1)
    writeFileSync(join(b, 'checkpoints', '0000000002.sig'), readFileSync(join(b, 'checkpoints', '0000000001.sig')));
    const bad = tool([b]);
    expect(bad.status).toBe(1);
    expect(bad.steps.some((s) => s.step === 'signature' && s.status === 'mismatch')).toBe(true);
  });
});

describe('C-T41 공개 캘린더 장애(PostgreSQL·moto)', () => {
  test('C-T41 캘린더 주소를 모두 막아도 체크포인트·서명은 DB에 남고 게시하지 않으며, 캘린더가 돌아온 다음 실행에서 다시 찍어 게시한다', async () => {
    const { pub, anc } = await buckets();
    await seed(4, DAY1 - HOUR);
    const fake = new MemoryOpenTimestampsCalendar('https://cal-it-b.audit-test.invalid');
    fake.fail = true;
    // 닿지 않는 주소(연결 거절)의 HTTP 캘린더와 실패하는 가짜 캘린더
    const dead = new HttpOpenTimestampsCalendar('http://127.0.0.1:9', { timeoutMs: 2_000 });
    const down = publisher({ pub, anc, calendars: [dead, fake] });
    const r1 = await down.p.run(DAY1);
    expect(r1).toMatchObject({ created: [{ no: 1, kind: 'DAILY' }], signed: 1, stamped: 0, published: 0 });
    expect(r1.errors).toContain('ots:all-failed:1');
    const [row] = (await admin.query<{ signature: string | null; ots_state: string | null; published_at: Date | null }>('select signature, ots_state, published_at from audit_checkpoint where no = 1')).rows;
    expect(row!.signature).toEqual(expect.any(String));
    expect(row!.ots_state).toBeNull();
    expect(row!.published_at).toBeNull();
    expect(await getObject(pub, file(1, 'json'))).toBeUndefined();
    expect(await getObject(anc, file(1, 'json'))).toBeUndefined();
    fake.fail = false;
    const r2 = await publisher({ pub, anc, calendars: [dead, fake] }).p.run(DAY1 + 5 * 60_000);
    expect(r2).toMatchObject({ created: [], signed: 0, stamped: 1, published: 1 });
    expect((await admin.query<{ ots_state: string }>('select ots_state from audit_checkpoint where no = 1')).rows[0]!.ots_state).toBe('PENDING');
    expect((await getObject(anc, file(1, 'ots')))!.includes(Buffer.from('https://cal-it-b.audit-test.invalid', 'utf8'))).toBe(true);
  });
});

describe('C-T42 기록 파기 뒤 공개 루트(PostgreSQL·moto)', () => {
  test('C-T42 감사 기록과 잎 솔트를 지운 뒤에도 공개 폴더만으로 사슬·서명·증명 검증이 통과하고, 공개 파일에는 기록 원문·솔트가 없다', async () => {
    const { pub, anc } = await buckets();
    const reasons = await seed(6, DAY1 - HOUR);
    const { p } = publisher({ pub, anc });
    expect((await p.run(DAY1)).published).toBe(1);
    const salts = (await admin.query<{ s: string }>("select encode(leaf_salt,'hex') as s from audit_chain order by seq")).rows.map((r) => r.s);
    const ids = (await admin.query<{ id: string }>('select record_id::text as id from audit_chain order by seq')).rows.map((r) => r.id);
    expect(salts).toHaveLength(6);
    // 법정 보존 기간이 지난 기록의 파기를 흉내 낸다(행과 솔트를 함께 지운다. 파기 배치 자체는 BAT-395 OPS-330)
    await admin.query('delete from audit_chain where seq between 1 and 6');
    expect(await chainCount()).toBe(0);
    const dirA = await download(pub);
    const dirB = await download(anc);
    const r = tool([dirA, dirB]);
    expect(r.status).toBe(0);
    for (const dir of [dirA, dirB]) {
      const bytes = Buffer.concat(allFiles(dir).map((f) => readFileSync(f)));
      for (const s of salts) expect(bytes.includes(Buffer.from(s, 'utf8'))).toBe(false);
      for (const s of salts) expect(bytes.includes(Buffer.from(s, 'hex'))).toBe(false);
      for (const id of ids) expect(bytes.includes(Buffer.from(id, 'utf8'))).toBe(false);
      for (const reason of reasons) expect(bytes.includes(Buffer.from(reason, 'utf8'))).toBe(false);
    }
  });
});

describe('[ASVS v5.0.0-11.6.1] KMS 서명 키 꼴(moto KMS)', () => {
  test('[ASVS v5.0.0-11.6.1] KMS 서명기는 moto KMS의 ECC_NIST_P256·SIGN_VERIFY 키 공개키(SPKI, P-256)를 KMS가 준 그대로 받는다', async () => {
    const good = new KmsCheckpointSigner(kmsCheckpointSignerClient({ region: REGION, endpoint }), keyId);
    const spki = await good.publicKeySpki();
    expect(spki.equals(Buffer.from((await kms.send(new GetPublicKeyCommand({ KeyId: keyId }))).PublicKey!))).toBe(true);
    expect(createPublicKey({ key: spki, format: 'der', type: 'spki' }).asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    // 다른 키 꼴(ECC_SECG_P256K1 등)의 거절은 GetPublicKey의 KeySpec으로 판정한다: 흉내 서버가 그 칸을 주지 않아 단위 시험(audit-checkpoint-bytes)이 본다
  });
});

describe('B12·B7 작업 DB 역할과 루트 어긋남(PostgreSQL)', () => {
  test('B12 게시 작업 역할 ops_audit_anchor는 audit_chain·audit_chain_head를 쓰지 못하고(42501) 체크포인트 표만 고친다', async () => {
    await seed(2, DAY1 - HOUR);
    const job = await jobDb.pool.connect();
    try {
      await expect(job.query('insert into audit_chain select * from audit_chain where seq = 1')).rejects.toMatchObject({ code: '42501' });
      await expect(job.query('update audit_chain set record_type = record_type where seq = 1')).rejects.toMatchObject({ code: '42501' });
      await expect(job.query('delete from audit_chain where seq = 1')).rejects.toMatchObject({ code: '42501' });
      await expect(job.query('update audit_chain_head set last_seq = last_seq where id = 1')).rejects.toMatchObject({ code: '42501' });
      await expect(job.query('select 1 from ops_command limit 1')).rejects.toMatchObject({ code: '42501' });
      expect((await job.query('select count(*)::int as n from audit_chain')).rows[0]).toEqual({ n: 2 });
    } finally {
      job.release();
    }
  });

  test('B7 서명 전에 기록 해시가 바뀌면 작업은 서명·게시하지 않고 끝 코드 1의 SEV2 조건을 낸다', async () => {
    const { pub, anc } = await buckets();
    await seed(3, DAY1 - HOUR);
    // KMS에 닿지 않는 첫 실행(공개키를 받지 못함): 체크포인트만 만들고 서명하지 않는다
    const down: CheckpointSigner = { keyId: SIGNER.keyId, alg: SIGNER.alg, publicKeySpki: async () => Promise.reject(new Error('KMS 503')), sign: (m) => SIGNER.sign(m) };
    const r1 = await publisher({ pub, anc, signer: down }).p.run(DAY1);
    expect(r1).toMatchObject({ created: [{ no: 1, kind: 'DAILY' }], signed: 0 });
    await admin.query("update audit_chain set record_sha256 = decode(repeat('ef', 32), 'hex') where seq = 2");
    const { p, logs } = publisher({ pub, anc });
    const r2 = await p.run(DAY1 + 5 * 60_000);
    expect(r2).toMatchObject({ signed: 0, published: 0, mismatches: [1] });
    expect(logs).toContainEqual(expect.objectContaining({ event: 'audit-checkpoint-mismatch', severity: 'SEV2', no: 1 }));
    expect((await admin.query<{ signature: string | null }>('select signature from audit_checkpoint where no = 1')).rows[0]!.signature).toBeNull();
    expect(await getObject(pub, file(1, 'json'))).toBeUndefined();
  });
});
