// 리뷰 RV-01 재현(BAT-360 OPS-280, 계획 '15. 리뷰' RV-01, ADR-0348 결정 1·4·11과 '결과', docs/data.md audit_checkpoint.signature '게시 작업만 채운다').
// 정본: API 프로세스는 서명 키를 갖지 않고, 서명·공개 타임스탬프·게시는 게시 작업만 한다. API 프로세스가 뚫려도 서명 키를 쓰지 못해야 한다.
// - RV-01 ①: API 역할 ops_app은 서명 키 표 audit_signing_key에 키를 넣거나 고치지 못한다(권한 거절 42501).
// - RV-01 ②: ops_app은 공개 체크포인트의 서명·키 ID·증명·게시 칸을 채우지 못한다(권한 거절 42501).
// - RV-01 ③: 권한을 돌아(다른 역할로) 남의 키 행을 넣고 루트를 바꾼 체크포인트에 그 키로 서명을 채워도, 게시 작업은 루트·서명을 다시 보고 그 행을 게시하지 않으며
//   남의 키를 public-keys.json에 싣지 않는다(공개 검증 도구가 그 사슬을 통과시키지 않게).
// 작업은 DB 역할 ops_audit_anchor, API는 ops_app의 로그인 사용자로 붙는다(운영 배포와 같은 꼴). 게시 자리·캘린더는 제품 메모리 짝 가짜다.
import 'reflect-metadata';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createDatabase, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import {
  AuditCheckpointPublisher,
  DrizzleAuditChain,
  DrizzleAuditPublishStore,
  MemoryAuditPublicStore,
  MemoryOpenTimestampsCalendar,
  ephemeralCheckpointSigner,
  type CheckpointSigner,
} from '../src/modules/audit/index.js';
import { CreateCommand, DrizzleCommandStore } from '../src/modules/commands/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const DAY1 = Date.parse('2026-11-26T00:10:00.000+09:00');
const HOUR = 60 * 60_000;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let container: PostgresContainer;
let admin: pg.Client;
let db: Database;
let jobDb: Database;
let app: pg.Client;
const SIGNER = ephemeralCheckpointSigner('rv01-job-key');
/** 남의 키(API 프로세스를 빼앗은 사람이 만든 P-256 키) */
const attacker = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ATTACKER_SPKI = attacker.publicKey.export({ type: 'spki', format: 'der' });

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  await admin.query("CREATE ROLE rv01_anchor LOGIN PASSWORD 'rv01-anchor' IN ROLE ops_audit_anchor");
  await admin.query("CREATE ROLE rv01_app LOGIN PASSWORD 'rv01-app' IN ROLE ops_app");
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-rv01-it' });
  jobDb = createDatabase({ url: container.urlFor('rv01_anchor', 'rv01-anchor'), applicationName: 'ops-svc-rv01-anchor' });
  app = new pg.Client({ connectionString: container.urlFor('rv01_app', 'rv01-app') });
  await app.connect();
}, 180_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await jobDb?.close().catch(() => undefined);
  await db?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  container?.stop();
});

beforeEach(async () => {
  await admin.query('truncate ops_command, command_event, command_approval, command_actor, audit_chain, audit_checkpoint, audit_signing_key, idempotency_record cascade');
  await admin.query("update audit_chain_head set last_seq = 0, last_hash = ''::bytea where id = 1");
});

async function seed(n: number): Promise<void> {
  const create = new CreateCommand(new DrizzleCommandStore(db));
  for (let i = 0; i < n; i += 1) await create.execute({ type: 'LOG_LEVEL', reason: `RV-01 ${i}`, params: { service: 'queue-svc', level: 'DEBUG' }, requestedBy: randomUUID(), requestedRole: 'operator', nowMs: DAY1 - HOUR + i });
}

function job(signer: CheckpointSigner = SIGNER) {
  const pub = new MemoryAuditPublicStore('public');
  const anc = new MemoryAuditPublicStore('anchor');
  const logs: Record<string, unknown>[] = [];
  const p = new AuditCheckpointPublisher({
    store: new DrizzleAuditPublishStore(jobDb),
    chain: new DrizzleAuditChain(jobDb),
    signer,
    calendars: [new MemoryOpenTimestampsCalendar('https://cal-rv01.audit-test.invalid')],
    targets: [pub, anc],
    log: (_l, f) => logs.push(f),
  });
  return { p, pub, anc, logs };
}

/** 서명 전 공개 체크포인트 1번을 만든다(작업이 KMS 공개키를 받지 못한 실행) */
async function unsignedCheckpoint(): Promise<void> {
  await seed(3);
  const down: CheckpointSigner = { keyId: SIGNER.keyId, alg: SIGNER.alg, publicKeySpki: () => Promise.reject(new Error('KMS 503')), sign: (m) => SIGNER.sign(m) };
  const r = await job(down).p.run(DAY1);
  expect(r).toMatchObject({ created: [{ no: 1, kind: 'DAILY' }], signed: 0 });
}

describe('RV-01 서명 칸·서명 키 표의 쓰기 권한(ADR-0348 결정 1·4·11)', () => {
  test('RV-01 ① API 역할 ops_app은 audit_signing_key에 키 행을 넣거나 고치거나 지우지 못한다(42501)', async () => {
    await expect(app.query("insert into audit_signing_key (key_id, public_key_spki, alg, first_used_at) values ('attacker', $1, 'ECDSA_P256_SHA256', now())", [ATTACKER_SPKI])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("update audit_signing_key set public_key_spki = $1 where key_id = 'rv01-job-key'", [ATTACKER_SPKI])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("delete from audit_signing_key where key_id = 'rv01-job-key'")).rejects.toMatchObject({ code: '42501' });
    expect((await admin.query<{ n: string }>('select count(*)::text as n from audit_signing_key')).rows[0]!.n).toBe('0');
  });

  test('RV-01 ② API 역할 ops_app은 공개 체크포인트의 서명·키 ID·증명·게시 칸을 채우지 못한다(42501)', async () => {
    await unsignedCheckpoint();
    const [row] = (await admin.query<{ checkpoint_json: string }>('select checkpoint_json from audit_checkpoint where no = 1')).rows;
    const forged = sign('sha256', Buffer.from(row!.checkpoint_json, 'utf8'), { key: attacker.privateKey, dsaEncoding: 'der' }).toString('base64');
    await expect(app.query("update audit_checkpoint set signature = $1, key_id = 'attacker' where no = 1", [forged])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("update audit_checkpoint set ots_state = 'COMPLETE', ots_proof = '\\x00'::bytea where no = 1")).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("update audit_checkpoint set published_at = now(), anchor_ref = 'transparency/v1/checkpoints/0000000001.json' where no = 1")).rejects.toMatchObject({ code: '42501' });
    const [after] = (await admin.query<{ signature: string | null; key_id: string | null; published_at: Date | null }>('select signature, key_id, published_at from audit_checkpoint where no = 1')).rows;
    expect(after).toEqual({ signature: null, key_id: null, published_at: null });
  });
});

describe('RV-01 ③ 게시 작업의 다시 확인(ADR-0348 결정 4·10)', () => {
  test('RV-01 ③ 남의 키 행을 넣고 루트를 바꾼 체크포인트에 그 키로 서명을 채워도 게시 작업은 그 행을 게시하지 않고 남의 키를 공개 키 목록에 싣지 않는다', async () => {
    await unsignedCheckpoint();
    // 권한을 돌아(슈퍼유저로) 꾸민다: 루트를 바꾼 JSON·해시와 그 JSON에 대한 남의 키 서명, 남의 키 행
    const [row] = (await admin.query<{ checkpoint_json: string }>('select checkpoint_json from audit_checkpoint where no = 1')).rows;
    const body = JSON.parse(row!.checkpoint_json) as Record<string, unknown>;
    const fakeRoot = 'ab'.repeat(32);
    const keys = Object.keys({ ...body, merkleRoot: fakeRoot }).sort();
    const forgedJson = JSON.stringify(Object.fromEntries(keys.map((k) => [k, k === 'merkleRoot' ? fakeRoot : body[k]])));
    const forgedSig = sign('sha256', Buffer.from(forgedJson, 'utf8'), { key: attacker.privateKey, dsaEncoding: 'der' }).toString('base64');
    await admin.query("insert into audit_signing_key (key_id, public_key_spki, alg, first_used_at) values ('attacker', $1, 'ECDSA_P256_SHA256', now())", [ATTACKER_SPKI]);
    await admin.query("update audit_checkpoint set checkpoint_json = $1, checkpoint_hash = decode($2, 'hex'), root_hash = decode($3, 'hex'), signature = $4, key_id = 'attacker' where no = 1", [
      forgedJson,
      sha(Buffer.from(forgedJson, 'utf8')),
      fakeRoot,
      forgedSig,
    ]);
    const { p, pub, anc, logs } = job();
    const run = await p.run(DAY1 + 5 * 60_000);
    expect(run.published).toBe(0);
    expect(run.stamped).toBe(0);
    expect(run.mismatches).toEqual([1]);
    expect(logs.some((l) => l.severity === 'SEV2')).toBe(true);
    for (const t of [pub, anc]) {
      expect(t.objects.has('transparency/v1/checkpoints/0000000001.json')).toBe(false);
      const keysFile = t.objects.get('transparency/v1/public-keys.json');
      if (keysFile) expect(keysFile.toString('utf8')).not.toContain('attacker');
    }
    expect((await admin.query<{ published_at: Date | null }>('select published_at from audit_checkpoint where no = 1')).rows[0]!.published_at).toBeNull();
  });

  test('RV-01 ③ 루트는 그대로 두고 남의 키로 서명만 채운 행도 게시하지 않는다(작업 키가 아닌 서명)', async () => {
    await unsignedCheckpoint();
    const [row] = (await admin.query<{ checkpoint_json: string }>('select checkpoint_json from audit_checkpoint where no = 1')).rows;
    const forgedSig = sign('sha256', Buffer.from(row!.checkpoint_json, 'utf8'), { key: attacker.privateKey, dsaEncoding: 'der' }).toString('base64');
    await admin.query("insert into audit_signing_key (key_id, public_key_spki, alg, first_used_at) values ('attacker', $1, 'ECDSA_P256_SHA256', now())", [ATTACKER_SPKI]);
    await admin.query("update audit_checkpoint set signature = $1, key_id = 'attacker' where no = 1", [forgedSig]);
    const { p, pub, anc } = job();
    const run = await p.run(DAY1 + 5 * 60_000);
    expect(run.published).toBe(0);
    for (const t of [pub, anc]) {
      expect(t.objects.has('transparency/v1/checkpoints/0000000001.sig')).toBe(false);
      const keysFile = t.objects.get('transparency/v1/public-keys.json');
      if (keysFile) expect(keysFile.toString('utf8')).not.toContain('attacker');
    }
  });
});
