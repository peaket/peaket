// 감사 체인 mac의 실제 PostgreSQL 18·KMS 흉내 서버(moto 5.2.5) 통합 시험(BAT-355 OPS-270, ADR-0341, control-tower §7, C-T27 ①③, C-T49).
// - C-T49: KMS를 막아도 명령 2가 커밋되고 mac이 빈 행이 남는다. 가장 오래된 빈 행이 60,000ms면 경보가 없고 60,001ms면 SEV2 audit-mac-lag,
//   되살리면 작업자가 seq 차례로 따라잡아 경보가 풀리고 검증 잡이 통과한다. 서울만 막으면 도쿄 복제 키로 넘긴다(moto 다중 리전 HMAC 키, 같은 키 재료).
// - C-T27 ①: 앵커가 찍힌 기록의 사유를 고치고 원본 행(ops_command·command_event)과 키 없는 해시 연쇄를 모두 맞춰도 mac이 잡는다(겹친 가드를 하나씩 뺀다).
//   25시간보다 오래된 행은 체크포인트 재검증이 잡는다. 두 리전 KMS 실패는 ERROR다.
// - C-T27 ③: 마지막 앵커 뒤 끝 기록 삭제는 드러나지 않고(남는 한계), 앵커가 찍힌 seq 행 삭제는 드러난다.
// 작업자·경보·앵커·검증은 모듈 공개 면(AuditChainWorker·AuditMacLagMonitor·AuditMacAnchorer·AuditChainVerifier)을 DB 어댑터 위에서 바로 부른다(타이머는 끈다).
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateKeyCommand, KMSClient, ReplicateKeyCommand } from '@aws-sdk/client-kms';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleOpsAlertStore } from '../src/modules/alerts/index.js';
import {
  AuditChainVerifier,
  AuditChainWorker,
  AuditCheckpointService,
  AuditMacAnchorer,
  AuditMacLagMonitor,
  AuditSignals,
  DirMacAnchorStore,
  DrizzleAuditChain,
  DrizzleAuditCheckpointStore,
  DrizzleAuditMacStore,
  DrizzleAuditVerifyStore,
  KmsAuditMacKey,
  LocalAuditMacKey,
  auditHash,
  auditRecordFromJson,
  kmsAuditMacClient,
  type AuditMacKey,
} from '../src/modules/audit/index.js';
import { CreateCommand, DrizzleCommandStore, type CommandExecutor } from '../src/modules/commands/index.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { adminAccountsForCommands, reauthFor } from './reauth.js';

const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
/** 응답하지 않는 KMS(닫힌 포트) */
const DEAD = 'http://127.0.0.1:1';
const NOW = Date.parse('2026-11-22T10:00:00.000Z');
const HOUR = 3_600_000;
const SEOUL = 'ap-northeast-2';
const TOKYO = 'ap-northeast-1';

const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });
const executor: CommandExecutor = { execute: async () => ({ status: 'ACKED', ackedAtMs: clock.now() }) };
let container: PostgresContainer | undefined;
let moto = '';
let motoEndpoint = '';
let hmacArn = '';
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
let anchorDir = '';

beforeAll(async () => {
  // kmsAuditMacClient는 기본 자격 증명 사슬을 쓴다(흉내 서버용 값)
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-audit-mac-it' });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  const prefix = process.env.PEAKET_TEST_CONTAINER_PREFIX;
  moto = docker(['run', '-d', '--rm', ...(prefix ? ['--name', `${prefix}moto-${Math.random().toString(36).slice(2, 8)}`] : []), '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  const mapped = docker(['port', moto, '5000/tcp']).split('\n')[0]!;
  motoEndpoint = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  const seoul = new KMSClient({ endpoint: motoEndpoint, region: SEOUL, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      hmacArn = (await seoul.send(new CreateKeyCommand({ KeySpec: 'HMAC_256', KeyUsage: 'GENERATE_VERIFY_MAC', MultiRegion: true }))).KeyMetadata!.Arn!;
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  // moto는 ReplicateKey에 키 ARN을 받지 못해 키 ID로 부른다(identity-svc kms-failover.int.test.ts와 같다)
  await seoul.send(new ReplicateKeyCommand({ KeyId: hmacArn.slice(hmacArn.lastIndexOf('key/') + 4), ReplicaRegion: TOKYO }));
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db, executor, background: false, adminAccounts: adminAccountsForCommands }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 180_000);

afterAll(async () => {
  await svc?.close();
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
  if (moto) {
    try {
      docker(['rm', '-f', '-v', moto]);
    } catch {
      // 이미 멈췄다
    }
  }
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  // 시험마다 체인을 비운다(seq·머리·앵커·검증 기록이 서로 섞이지 않게)
  await admin.query(
    'truncate ops_command, command_event, command_approval, command_actor, audit_chain, audit_mac_anchor, audit_verification_run, audit_record_intake, audit_checkpoint, ops_alert, idempotency_record, ops_worker_lease cascade',
  );
  await admin.query("update audit_chain_head set last_seq = 0, last_hash = ''::bytea, mac_seq = 0, last_mac = ''::bytea where id = 1");
  if (anchorDir) rmSync(anchorDir, { recursive: true, force: true });
  anchorDir = mkdtempSync(join(tmpdir(), 'ops-audit-anchor-'));
});

/** 서울·도쿄 끝점을 골라 만든 KMS 감사 체인 키(넘길 때 onFailover) */
const kmsKey = (seoulEndpoint: string, tokyoEndpoint: string, signals?: AuditSignals): KmsAuditMacKey =>
  new KmsAuditMacKey(kmsAuditMacClient({ region: SEOUL, endpoint: seoulEndpoint }), hmacArn, { client: kmsAuditMacClient({ region: TOKYO, endpoint: tokyoEndpoint }), region: TOKYO }, (op) => signals?.failover(op));
const macStore = () => new DrizzleAuditMacStore(db);
const alerts = () => new DrizzleOpsAlertStore(db);
const chain = () => new DrizzleAuditChain(db);
const verifier = (key: AuditMacKey, o: { checkpoints?: AuditCheckpointService } = {}) =>
  new AuditChainVerifier({ store: new DrizzleAuditVerifyStore(db), key, ledger: macStore(), anchors: new DirMacAnchorStore(anchorDir), sourceMatches: (e) => chain().sourceMatches(e), alerts: alerts(), audit: chain(), ...o });
/** 바퀴를 끝까지 돌려 채운 행 수 */
async function fillAll(key: AuditMacKey): Promise<number> {
  const worker = new AuditChainWorker({ store: macStore(), key, alerts: alerts(), batch: 7 });
  let total = 0;
  for (let i = 0; i < 100; i += 1) {
    const r = await worker.runOnce(clock.now());
    if (r.error) throw new Error(r.error);
    if (r.filled === 0) return total;
    total += r.filled;
  }
  throw new Error('작업자가 끝나지 않았다');
}
const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) => admin.query<R>(text, params);
const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params)).rows[0]!.n);
/** 명령 접수(LOG_LEVEL, 1인·실행기 없음): 감사 행 하나(COMMAND_CREATED) */
async function seedCommands(reasons: readonly string[]): Promise<string[]> {
  const create = new CreateCommand(new DrizzleCommandStore(db));
  const ids: string[] = [];
  for (const reason of reasons) ids.push((await create.execute({ type: 'LOG_LEVEL', reason, params: { level: 'DEBUG' }, requestedBy: randomUUID(), requestedRole: 'operator', nowMs: clock.now() })).commandId);
  return ids;
}
/** 사유를 DB에서 바꾸고, 원본 행과 키 없는 해시 연쇄(record_sha256·prev_hash·머리)를 모두 다시 맞춘다. mac만 옛 값으로 남는다 */
async function tamperReason(commandId: string, reason: string): Promise<number> {
  await q('update ops_command set reason = $2 where id = $1', [commandId, reason]);
  await q('update command_event set reason = $2 where command_id = $1', [commandId, reason]);
  await q("update audit_chain set record_json = jsonb_set(record_json, '{payload,reason}', to_jsonb($2::text)) where record_id = $1 and record_type = 'COMMAND_CREATED'", [commandId, reason]);
  const seq = Number((await q<{ seq: string }>("select seq from audit_chain where record_id = $1 and record_type = 'COMMAND_CREATED'", [commandId])).rows[0]!.seq);
  const rows = (await q<{ seq: string; prev: string; record_json: unknown }>("select seq, encode(prev_hash, 'hex') as prev, record_json from audit_chain where seq >= $1 order by seq", [seq])).rows;
  let prev = rows[0]!.prev;
  for (const r of rows) {
    const hash = auditHash(prev, auditRecordFromJson(r.record_json)!);
    await q("update audit_chain set record_sha256 = decode($2, 'hex'), prev_hash = decode($3, 'hex') where seq = $1", [r.seq, hash, prev]);
    prev = hash;
  }
  await q("update audit_chain_head set last_hash = decode($1, 'hex') where id = 1", [prev]);
  return seq;
}
const LOCAL = randomBytes(32);

describe('C-T49 KMS 정지 중 명령 커밋(moto)', () => {
  test('C-T49 KMS를 막아도 명령 2가 커밋되고 mac이 빈 행이 남으며, 가장 오래된 빈 행이 60,000ms면 경보가 없고 60,001ms면 SEV2, 되살리면 seq 차례로 따라잡아 경보가 풀리고 검증 잡이 통과한다', async () => {
    const signals = new AuditSignals();
    const blocked = kmsKey(DEAD, DEAD, signals);
    const lagMonitor = new AuditMacLagMonitor(macStore(), alerts(), signals);
    const committedAt = clock.now();
    const r = await svc.http.inject({
      method: 'POST',
      url: '/v1/ops/commands',
      headers: { ...reauthFor('/v1/ops/commands', identity.ops('operator')), 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'ADMISSION_PAUSE', reason: 'KMS 정지 중 입장 멈춤', params: { eventId: randomUUID() } }),
    });
    expect(r.statusCode, r.payload).toBe(201);
    const commandId = (JSON.parse(r.payload) as { commandId: string; state: string }).commandId;
    expect((await q<{ state: string }>('select state from ops_command where id = $1', [commandId])).rows[0]!.state).toBe('ACKED');
    const worker = new AuditChainWorker({ store: macStore(), key: blocked, alerts: alerts() });
    expect(await worker.runOnce(clock.now())).toEqual({ filled: 0, error: 'AuditMacKeyUnavailable' });
    const rows = await count('select count(*) as n from audit_chain');
    expect(rows).toBeGreaterThan(0);
    // 막힌 동안 빈 행이 남는다(장애 주입이 실제로 끊었다)
    expect(await count('select count(*) as n from audit_chain where mac is null')).toBe(rows);
    expect((await q<{ mac_seq: string }>('select mac_seq from audit_chain_head where id = 1')).rows[0]!.mac_seq).toBe('0');
    expect(await lagMonitor.runOnce(committedAt + 60_000)).toEqual({ lagMs: 60_000, alerted: false });
    expect(await count("select count(*) as n from ops_alert where kind = 'audit-mac-lag'")).toBe(0);
    expect(await lagMonitor.runOnce(committedAt + 60_001)).toEqual({ lagMs: 60_001, alerted: true });
    expect((await q<{ event_key: string; severity: string; resolved_at: Date | null }>("select event_key, severity, resolved_at from ops_alert where kind = 'audit-mac-lag'")).rows).toEqual([{ event_key: 'audit-chain', severity: 'SEV2', resolved_at: null }]);

    // 되살림: 바퀴마다 seq 차례로 채워 mac_seq가 마지막 seq까지 간다
    const live = kmsKey(motoEndpoint, motoEndpoint, signals);
    expect(await fillAll(live)).toBe(rows);
    expect(await count('select count(*) as n from audit_chain where mac is null')).toBe(0);
    const head = (await q<{ mac_seq: string; last_seq: string }>('select mac_seq, last_seq from audit_chain_head where id = 1')).rows[0]!;
    expect(head.mac_seq).toBe(head.last_seq);
    expect(await lagMonitor.runOnce(committedAt + 70_000)).toEqual({ lagMs: 0, alerted: false });
    expect((await q<{ resolved_at: Date | null }>("select resolved_at from ops_alert where kind = 'audit-mac-lag'")).rows[0]!.resolved_at).not.toBeNull();
    // 앵커는 키 ID를 남긴다([ASVS v5.0.0-11.2.2] 키 바꾸기 지점)
    const anchored = await new AuditMacAnchorer(macStore(), new DirMacAnchorStore(anchorDir), live.keyId).runOnce(clock.now());
    expect(anchored).toEqual({ anchoredSeq: rows });
    const [file] = readdirSync(join(anchorDir, 'audit-chain/anchors/v1'));
    expect(file).toBe(`${String(rows).padStart(20, '0')}.json`);
    expect(JSON.parse(readFileSync(join(anchorDir, 'audit-chain/anchors/v1', file!), 'utf8'))).toMatchObject({ v: 1, seq: rows, keyId: hmacArn });
    const run = await verifier(live).verify({}, clock.now());
    expect(run).toMatchObject({ result: 'VALID', fromSeq: 1, toSeq: rows });
    expect(await count("select count(*) as n from audit_verification_run where result = 'VALID' and to_seq = $1", [rows])).toBe(1);
  }, 120_000);

  test('C-T49 서울 KMS만 막으면 mac은 도쿄 복제 키로 채워지고 넘김 지표가 오르며, 서울에서도 도쿄에서도 검증이 통과한다', async () => {
    await seedCommands(['서울 정지 1', '서울 정지 2', '서울 정지 3']);
    const signals = new AuditSignals();
    const seoulDown = kmsKey(DEAD, motoEndpoint, signals);
    const rows = await count('select count(*) as n from audit_chain');
    expect(await fillAll(seoulDown)).toBe(rows);
    const failovers = (await signals.kmsFailoverTotal.get()).values;
    expect(failovers.find((v) => v.labels.op === 'GenerateMac')?.value).toBe(rows);
    await new AuditMacAnchorer(macStore(), new DirMacAnchorStore(anchorDir), seoulDown.keyId).runOnce(clock.now());
    // 같은 키 재료: 서울(살아 있는 흉내 서버)에서 도쿄가 만든 mac을 확인한다
    expect(await verifier(kmsKey(motoEndpoint, motoEndpoint)).verify({}, clock.now())).toMatchObject({ result: 'VALID', toSeq: rows });
    expect(await verifier(seoulDown).verify({}, clock.now())).toMatchObject({ result: 'VALID', toSeq: rows });
    expect((await signals.kmsFailoverTotal.get()).values.find((v) => v.labels.op === 'VerifyMac')?.value).toBeGreaterThanOrEqual(rows);
  }, 120_000);
});

describe('C-T27 감사 기록 변조 탐지', () => {
  test('C-T27 ① [ASVS v5.0.0-11.3.3] [ASVS v5.0.0-16.4.2] 앵커가 찍힌 기록의 사유를 DB에서 고치고 원본 행과 키 없는 해시를 모두 맞춰도, 이미 검증한 구간이라도 다음 검증에서 mac 불일치(첫 seq)·SEV2 audit-chain-mismatch·AUDIT_CHAIN_MISMATCH가 나온다', async () => {
    const ids = await seedCommands(['원래 사유 1', '원래 사유 2', '원래 사유 3', '원래 사유 4']);
    const key = new LocalAuditMacKey(LOCAL, 'local-c-t27');
    expect(await fillAll(key)).toBe(4);
    expect(await new AuditMacAnchorer(macStore(), new DirMacAnchorStore(anchorDir), key.keyId).runOnce(clock.now())).toEqual({ anchoredSeq: 4 });
    expect(await verifier(key).verify({}, clock.now())).toMatchObject({ result: 'VALID', fromSeq: 1, toSeq: 4 });
    clock.advance(HOUR);
    const seq = await tamperReason(ids[1]!, '바뀐 사유');
    expect(seq).toBe(2);
    // 겹친 가드를 하나씩 뺀다: 원본 행 대조와 키 없는 해시 연쇄는 이 변조를 통과한다
    const [row] = (await q<{ hash: string; prev: string; record_json: unknown }>("select encode(record_sha256, 'hex') as hash, encode(prev_hash, 'hex') as prev, record_json from audit_chain where seq = 2")).rows;
    expect(await chain().sourceMatches({ seq: 2, hash: row!.hash, prevHash: row!.prev, record: auditRecordFromJson(row!.record_json)! })).toBe(true);
    const keyless: AuditMacKey = { keyId: 'keyless', mac: async () => Buffer.alloc(32), verify: async () => true };
    expect(await verifier(keyless).verify({}, clock.now())).toMatchObject({ result: 'VALID', toSeq: 4 });
    expect(await count("select count(*) as n from ops_alert where kind = 'audit-chain-mismatch'")).toBe(0);
    // 키를 건 mac이 잡는다
    const run = await verifier(key).verify({}, clock.now());
    expect(run).toMatchObject({ result: 'MISMATCH', fromSeq: 1, firstBadSeq: 2, reason: 'mac' });
    expect((await q<{ result: string; first_bad_seq: string; reason: string }>('select result, first_bad_seq, reason from audit_verification_run where run_id = $1', [run.runId])).rows).toEqual([{ result: 'MISMATCH', first_bad_seq: '2', reason: 'mac' }]);
    expect((await q<{ event_key: string; severity: string; detail: Record<string, unknown> }>("select event_key, severity, detail from ops_alert where kind = 'audit-chain-mismatch'")).rows).toEqual([
      { event_key: 'audit-chain', severity: 'SEV2', detail: { firstBadSeq: 2, reason: 'mac', runId: run.runId } },
    ]);
    const [mismatch] = (await q<{ record_json: { payload: Record<string, unknown> } }>("select record_json from audit_chain where record_type = 'AUDIT_CHAIN_MISMATCH'")).rows;
    expect(mismatch!.record_json.payload).toMatchObject({ runId: run.runId, firstBadSeq: 2, reason: 'mac' });
  }, 60_000);

  test('C-T27 ① 25시간보다 오래된 기록의 변조는 마지막 검증 지점 뒤가 아니어도 체크포인트 재검증이 잡는다', async () => {
    const ids = await seedCommands(['오래된 1', '오래된 2', '오래된 3']);
    const checkpoints = new AuditCheckpointService(new DrizzleAuditCheckpointStore(db), chain(), () => clock.now());
    const cp = await checkpoints.create({ reason: '일 체크포인트', actorRef: randomUUID() });
    expect([cp.fromSeq, cp.toSeq]).toEqual([1, 3]);
    const key = new LocalAuditMacKey(LOCAL, 'local-c-t27-old');
    await fillAll(key);
    await new AuditMacAnchorer(macStore(), new DirMacAnchorStore(anchorDir), key.keyId).runOnce(clock.now());
    expect(await verifier(key, { checkpoints }).verify({}, clock.now())).toMatchObject({ result: 'VALID', toSeq: 4 });
    await tamperReason(ids[1]!, '오래된 변조');
    const later = clock.now() + 26 * HOUR;
    const run = await verifier(key, { checkpoints }).verify({}, later);
    expect(run).toMatchObject({ result: 'MISMATCH', fromSeq: 5, firstBadSeq: 1, reason: 'checkpoint' });
    expect(await count("select count(*) as n from ops_alert where kind = 'audit-chain-mismatch'")).toBe(1);
  }, 60_000);

  test('C-T27 ③ 마지막 앵커 뒤의 맨 끝 기록 삭제는 다음 검증에서 드러나지 않고(남는 한계, 최대 5분), 앵커가 찍힌 seq 행의 삭제는 MISMATCH다', async () => {
    await seedCommands(['앵커 1', '앵커 2', '앵커 3']);
    const key = new LocalAuditMacKey(LOCAL, 'local-c-t27-tail');
    await fillAll(key);
    expect(await new AuditMacAnchorer(macStore(), new DirMacAnchorStore(anchorDir), key.keyId).runOnce(clock.now())).toEqual({ anchoredSeq: 3 });
    await seedCommands(['앵커 뒤 4', '앵커 뒤 5']);
    expect(await fillAll(key)).toBe(2);
    await q('delete from audit_chain where seq = 5');
    expect(await verifier(key).verify({}, clock.now())).toMatchObject({ result: 'VALID', fromSeq: 1, toSeq: 4 });
    expect(await count("select count(*) as n from ops_alert where kind = 'audit-chain-mismatch'")).toBe(0);
    await q('delete from audit_chain where seq = 3');
    expect(await verifier(key).verify({}, clock.now())).toMatchObject({ result: 'MISMATCH', firstBadSeq: 3, reason: 'gap' });
  }, 60_000);

  test('C-T27 ① 두 리전 KMS를 모두 쓰지 못하면 검증은 ERROR이고 통과(VALID)로 적지 않는다', async () => {
    await seedCommands(['검증 불가 1', '검증 불가 2']);
    await fillAll(kmsKey(motoEndpoint, motoEndpoint));
    const run = await verifier(kmsKey(DEAD, DEAD)).verify({}, clock.now());
    expect(run.result).toBe('ERROR');
    // 까닭은 KMS를 쓰지 못한 것(kms:오류 이름)이다
    expect(String(run.reason)).toMatch(/^kms:/);
    expect(run.firstBadSeq).toBeUndefined();
    expect(await count("select count(*) as n from audit_verification_run where result = 'VALID'")).toBe(0);
    expect(await count("select count(*) as n from audit_verification_run where result = 'ERROR'")).toBe(1);
  }, 60_000);

  test('[ASVS v5.0.0-11.5.1] 잎 솔트는 행마다 다른 32바이트다(100행 겹침 0)', async () => {
    await seedCommands(Array.from({ length: 100 }, (_, i) => `솔트 ${i}`));
    const [r] = (await q<{ n: string; distinct: string; min: number; max: number }>('select count(*) as n, count(distinct leaf_salt) as distinct, min(octet_length(leaf_salt)) as min, max(octet_length(leaf_salt)) as max from audit_chain')).rows;
    expect(r).toEqual({ n: '100', distinct: '100', min: 32, max: 32 });
  }, 60_000);
});

describe('다른 서비스의 감사 기록 받기(실제 DB)', () => {
  test('OPS-270 같은 eventKey가 동시에 두 번 와도 체인 행 하나·받은 기록 하나이고 처음 seq를 돌려주며 SYSTEM 기록이다(실제 DB)', async () => {
    const eventId = randomUUID();
    const commit = 'ef'.repeat(32);
    const body = {
      eventKey: `shuffle-commit:${eventId}:lobby:${commit}`,
      recordType: 'SHUFFLE_COMMIT_DISCLOSED',
      recordId: eventId,
      payload: { eventId, group: 'lobby', commit, chain: 'quicknet', round: 42, algorithm: 'shuffle-v1' },
      occurredAt: new Date(clock.now()).toISOString(),
    };
    const send = () => svc.http.inject({ method: 'POST', url: '/internal/v1/ops/audit-records', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(JSON.parse(a.payload)).toEqual(JSON.parse(b.payload));
    const seq = (JSON.parse(a.payload) as { seq: number }).seq;
    expect(seq).toBeGreaterThan(0);
    expect(await count("select count(*) as n from audit_chain where record_type = 'SHUFFLE_COMMIT_DISCLOSED'")).toBe(1);
    expect((await q<{ seq: string }>('select seq from audit_record_intake where event_key = $1', [body.eventKey])).rows).toEqual([{ seq: String(seq) }]);
    const [row] = (await q<{ seq: string; record_json: { payload: Record<string, unknown> }; mac: Buffer | null }>("select seq, record_json, mac from audit_chain where record_type = 'SHUFFLE_COMMIT_DISCLOSED'")).rows;
    expect(row).toMatchObject({ seq: String(seq), mac: null });
    expect(row!.record_json.payload).toMatchObject({ actorRef: '00000000-0000-0000-0000-000000000000', actorRole: 'system', eventKey: body.eventKey });
  }, 60_000);
});
