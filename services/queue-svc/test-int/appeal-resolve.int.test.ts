// 실서버 연결: queue-svc의 추가 검증·이의 결과 반영(실제 gRPC 서버 VerificationAppealService + 실제 Valkey)과 trust-svc 프로세스(dist/main.js, 실제 Valkey,
// 사람 확인 대역)를 함께 띄워 B-T10 ③·B-T11을 끝까지 돈다(docs/features/bot-defense.md §5.2·§9·§12, ADR-0259).
// 약속:
// - trust-svc는 처음에 tsc로 이 폴더 아래 .trust-svc/dist(무시되는 빌드 출력)에 빌드해 운영 시작 명령(node --import @peaket/platform/telemetry/register dist/main.js)으로 띄운다.
//   의존 패키지는 queue-svc와 같아(node_modules가 같다) 이 자리에서 풀린다. 끝나면 지운다.
// - 사람 확인은 시험이 띄운 siteverify 대역이다(local·ci만 http). 토큰 글 'pass:<action>'이면 그 action으로 성공, 'fail'이면 토큰 탓 실패를 준다.
// - ops-svc 자리는 시험이 맡는다: queue-svc GetVerificationAppeal·ResolveVerificationAppeal과 trust-svc ApplyLabel(LABEL_SOURCE_APPEAL_ACCEPTED, LABEL_HUMAN)을 부른다.
// - 차단 기기는 CS가 부정 구매로 확인한 건(FRAUD_CONFIRMED, LABEL_BOT)으로 올리고, 그 기기로 사전 검증해 판정 근거가 차단 목록인 추가 검증을 만든다(§12 '남는 한계': 첫 판정이 차단 목록인 경우).
// - 건 요청 발행은 가짜다(Kafka는 test-int/case-requests.int.test.ts가 본다). identity-svc 재통과는 가짜(PASSED)다(I-T56은 identity-svc 시험이 본다).
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { queueV1Queue, trustV1Trust } from '@peaket/contracts/proto';
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { GrpcTrustRisk } from '../src/modules/entry/adapters/grpc-trust-risk.js';
import { keys, RedisEntryStore } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
import { DEFAULT_ENTRY_OPTIONS, EnterQueue, type EnterResult } from '../src/modules/entry/application/enter-queue.js';
import { type EventSchedule } from '../src/modules/entry/domain/queue.js';
import { RedisVerificationStore } from '../src/modules/verification/adapters/redis-verification-store.js';
import { GetVerificationAppeal, ResolveVerificationAppeal } from '../src/modules/verification/application/appeals.js';
import { SubmitAppeal } from '../src/modules/verification/application/submit-appeal.js';
import { SubmitVerification } from '../src/modules/verification/application/submit-verification.js';
import { queuePackage, verificationAppealHandlers } from '../src/modules/verification/inbound/appeal.grpc.js';
import { ACCOUNT, DEVICE, newEvent, newRequest, OTHER_ACCOUNT, openSchedule, PID, preverifyToken, tokens } from '../test/support.js';
import { hashOf, numberDup, recordingCases, recordingLogger, recordingReverification, recordingSignals, TEST_OPTIONS } from '../test/verification-cases.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR = join(HERE, '..');
const TRUST_DIR = join(SERVICE_DIR, '../trust-svc');
const TRUST_BUILD = join(HERE, '.trust-svc');
const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;

let queueValkey: ValkeyContainer;
let trustValkey: ValkeyContainer;
let queueRedis: HotRedis;
let trustRedis: HotRedis;
let turnstile: Server;
let trust: ChildProcess | undefined;
let trustOutput = '';
let trustGrpcPort = 0;
let trustManagementPort = 0;
let queueGrpc: { port: number; close(): Promise<void> };
let risk: GrpcTrustRisk;
let labels: grpc.Client & { ApplyLabel: Unary };
let appeals: grpc.Client & { GetVerificationAppeal: Unary; ResolveVerificationAppeal: Unary };
const turnstileSeen: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** 포트가 연결을 받을 때까지 기다린다 */
async function waitPort(port: number, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const ok = await new Promise<boolean>((res) => {
      const s = connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        res(true);
      });
      s.once('error', () => res(false));
    });
    if (ok) return;
    if (trust?.exitCode !== null && trust?.exitCode !== undefined) throw new Error(`trust-svc가 끝났다(${trust.exitCode}): ${trustOutput.slice(-2_000)}`);
    if (Date.now() > end) throw new Error(`trust-svc가 ${ms}ms 안에 뜨지 않았다: ${trustOutput.slice(-2_000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const unary = <T extends grpc.Client>(c: T, method: keyof T & string, r: object) =>
  new Promise<Record<string, unknown>>((res, rej) => (c[method] as unknown as Unary)(r, new grpc.Metadata(), { deadline: Date.now() + 10_000 }, (e, v) => (e ? rej(e) : res(v ?? {}))));

beforeAll(async () => {
  [queueValkey, trustValkey] = await Promise.all([startValkey(), startValkey()]);
  queueRedis = await createHotRedis({ url: queueValkey.url });
  trustRedis = await createHotRedis({ url: trustValkey.url });

  // 사람 확인 siteverify 대역: 토큰 글로 action을 정한다
  turnstile = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += String(d)));
    req.on('end', () => {
      const token = new URLSearchParams(body).get('response') ?? '';
      turnstileSeen.push(token);
      const m = /^pass:([a-z]+)$/.exec(token);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(m ? { success: true, hostname: 'www.peaket.example', action: m[1] } : { success: false, 'error-codes': ['invalid-input-response'] }));
    });
  });
  await new Promise<void>((r) => turnstile.listen(0, '127.0.0.1', () => r()));
  const turnstilePort = (turnstile.address() as { port: number }).port;

  // trust-svc를 빌드해 프로세스로 띄운다
  execFileSync(process.execPath, [join(TRUST_DIR, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', join(TRUST_BUILD, 'dist')], { cwd: TRUST_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const rulesDir = mkdtempSync(join(tmpdir(), 'queue-trust-rules-'));
  const rulesFile = join(rulesDir, 'rules.json');
  const support = (await import(/* @vite-ignore */ pathToFileURL(join(TRUST_DIR, 'test/support.ts')).href)) as { SYNTHETIC_RULES_JSON: string };
  writeFileSync(rulesFile, support.SYNTHETIC_RULES_JSON);
  trustGrpcPort = await freePort();
  trustManagementPort = await freePort();
  const { PEAKET_TEST_REPORT: _r, NODE_OPTIONS: _o, ...parent } = process.env;
  trust = spawn(process.execPath, ['--import', '@peaket/platform/telemetry/register', join(TRUST_BUILD, 'dist/main.js')], {
    cwd: SERVICE_DIR,
    env: {
      ...parent,
      PEAKET_ENV: 'ci',
      OTEL_SERVICE_NAME: 'trust-svc',
      OTEL_TRACES_EXPORTER: 'none',
      PEAKET_TRUST_REDIS_URL: trustValkey.url,
      PEAKET_TRUST_RULES_FILE: rulesFile,
      PEAKET_INV_REF_DEVICE_KEY: Buffer.alloc(32, 11).toString('base64'),
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      PEAKET_TURNSTILE_URL: `http://127.0.0.1:${turnstilePort}/turnstile/v0/siteverify`,
      PEAKET_TURNSTILE_SECRET: 'test-secret-value',
      PEAKET_GRPC_PORT: String(trustGrpcPort),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PORT: String(await freePort()),
      PEAKET_MANAGEMENT_PORT: String(trustManagementPort),
      PEAKET_LOG_LEVEL: 'info',
      PEAKET_TELEMETRY_KAFKA_BROKERS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trust.stdout!.on('data', (d) => (trustOutput += String(d)));
  trust.stderr!.on('data', (d) => (trustOutput += String(d)));
  await waitPort(trustGrpcPort, 60_000);

  // queue-svc 쪽: trust-svc 클라이언트, 업무 gRPC 서버(VerificationAppealService)
  risk = new GrpcTrustRisk(`127.0.0.1:${trustGrpcPort}`);
  const store = new RedisVerificationStore(queueRedis);
  queueGrpc = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: queuePackage().VerificationAppealService.service, handlers: verificationAppealHandlers({ get: new GetVerificationAppeal(store), resolve: new ResolveVerificationAppeal(store, systemClock, recordingLogger().logger) }, () => undefined) }],
  });
  const trustPkg = grpc.loadPackageDefinition(protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS)) as unknown as { peaket: { trust: { v1: { TrustLabelService: grpc.ServiceClientConstructor } } } };
  labels = new trustPkg.peaket.trust.v1.TrustLabelService(`127.0.0.1:${trustGrpcPort}`, grpc.credentials.createInsecure()) as unknown as typeof labels;
  const queuePkg = grpc.loadPackageDefinition(protoLoader.fromJSON(queueV1Queue as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS)) as unknown as { peaket: { queue: { v1: { VerificationAppealService: grpc.ServiceClientConstructor } } } };
  appeals = new queuePkg.peaket.queue.v1.VerificationAppealService(`127.0.0.1:${queueGrpc.port}`, grpc.credentials.createInsecure()) as unknown as typeof appeals;
}, 180_000);

afterAll(async () => {
  labels?.close();
  appeals?.close();
  risk?.close();
  await queueGrpc?.close();
  trust?.kill();
  await new Promise<void>((r) => (turnstile ? turnstile.close(() => r()) : r()));
  await queueRedis?.close();
  await trustRedis?.close();
  queueValkey?.stop();
  trustValkey?.stop();
  rmSync(TRUST_BUILD, { recursive: true, force: true });
});

const qcmd = (key: string, args: string[]) => queueRedis.command(args, { key, deadlineMs: 5_000 });
const tcmd = (key: string, args: string[]) => trustRedis.command(args, { key, deadlineMs: 5_000 });

async function trustKeys(pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = '0';
  do {
    const r = (await trustRedis.command(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '1000'], { deadlineMs: 5_000 })) as unknown[];
    cursor = String(r[0]);
    out.push(...(r[1] as unknown[]).map(String));
  } while (cursor !== '0');
  return out;
}

async function openEvent(): Promise<{ eventId: string; schedule: EventSchedule }> {
  const eventId = newEvent();
  // 로비 셔플을 끄고 오픈 직후 묶음은 1ms로 두고 이미 닫았다(오픈 뒤 발급 토큰은 바로 번호를 받는다)
  const schedule = openSchedule(Date.now(), { lobbyShuffle: false, openBatch: true, batchWindowMs: 1 });
  await qcmd(keys.cfg(eventId), ['HSET', keys.cfg(eventId), 'opensAtMs', String(schedule.opensAtMs), 'startsAtMs', String(schedule.startsAtMs), 'lobbyShuffle', '0', 'openBatch', '1', 'batchWindowMs', '1', 'rev', '1']);
  await qcmd(keys.batchDone(eventId), ['HSET', keys.batchDone(eventId), '1', '1:0:1']);
  return { eventId, schedule };
}

/** 사전 검증 판정(실제 trust-svc)을 받아 그 결과로 줄에 선다. 고위험이면 진입이 VERIFYING을 쓴다 */
async function enterWithVerdict(eventId: string, pid: string, account: string, humanToken: string) {
  const verdict = await risk.score({ context: 'PREVERIFY', eventId, accountId: account, pid, deviceId: DEVICE, journeyId: newRequest(), lobbyShuffle: false, humanCheckToken: humanToken, client: { ip: '198.51.100.7', asn: 0, clientHints: {} } });
  const enter = new EnterQueue(new RedisEntryStore(queueRedis), new RedisEventSchedules(queueRedis, systemClock), tokens, systemClock, DEFAULT_ENTRY_OPTIONS);
  const vr = verdict.kind === 'VERIFY' ? verdict.reason : undefined;
  const r = (await enter.run({ accountId: account, sessionId: 's', pid, eventId, body: { preverifyToken: preverifyToken(systemClock, eventId, { a: account, ...(vr ? { vr } : {}) }), deviceId: DEVICE, entryRequestId: newRequest() } })) as EnterResult;
  return { verdict, ticket: r };
}

let blocked = false;
/** 이 기기를 차단 기기 목록에 올린다: 사람 확인 실패 판정으로 근거 키를 만들고, CS가 그 판정을 부정 구매로 확인한다(FRAUD_CONFIRMED, LABEL_BOT) */
async function blockDevice(): Promise<void> {
  if (blocked) return;
  const ev0 = newEvent();
  const v = await risk.score({ context: 'PREVERIFY', eventId: ev0, accountId: ACCOUNT, pid: `${PID}-seed`, deviceId: DEVICE, journeyId: newRequest(), lobbyShuffle: false, humanCheckToken: 'fail' });
  expect(v).toEqual({ kind: 'VERIFY', reason: 'HUMAN_CHECK' });
  const r = await unary(labels, 'ApplyLabel', { source_ref: `cs-${ev0}`, source_version: 1, source: 'LABEL_SOURCE_FRAUD_CONFIRMED', label: 'LABEL_BOT', event_id: ev0, pid: `${PID}-seed`, acted_by: 'cs-agent-1' });
  expect(r).toEqual({ changed: true, block_list: 'BLOCK_LIST_CHANGE_ADDED' });
  expect(await trustKeys('tr:block:*')).toHaveLength(1);
  blocked = true;
}

test('B-T11 실제 trust-svc에서 차단 목록 기기도 VERIFICATION 사람 확인(action verify)과 재통과면 PASSED이고 action이 다르면 실패다', async () => {
  await blockDevice();
  const { eventId } = await openEvent();
  const pid = `${PID}-b11`;
  // 차단 기기의 사전 검증은 추가 검증이다(사유 범주 DEVICE_HISTORY)
  const { verdict, ticket } = await enterWithVerdict(eventId, pid, OTHER_ACCOUNT, 'pass:preverify');
  expect(verdict).toEqual({ kind: 'VERIFY', reason: 'DEVICE_HISTORY' });
  expect(ticket).toMatchObject({ kind: 'TICKET', verification: 'REQUIRED', verificationReason: 'DEVICE_HISTORY' });
  const submit = new SubmitVerification(new RedisVerificationStore(queueRedis), new RedisEventSchedules(queueRedis, systemClock), recordingReverification('PASSED'), risk, TEST_OPTIONS, systemClock, recordingSignals());
  const run = (token: string) => submit.run({ eventId, accountId: OTHER_ACCOUNT, pid, challengeToken: token, deviceId: DEVICE });
  // 사전 검증용 토큰(action preverify)은 추가 검증에서 실패다
  expect(await run('pass:preverify')).toEqual({ result: 'CHALLENGE_FAILED' });
  expect(await run('pass:verify')).toEqual({ result: 'PASSED', queueNumber: ticket.seq, graceUntil: null });
  const field = /:([0-9a-f]{64})$/.exec(String(await qcmd(keys.dup(pid, eventId), ['GET', keys.dup(pid, eventId)])))![1]!;
  expect(String(await qcmd(keys.verify(eventId), ['HGET', keys.verify(eventId), field]))).toMatch(/^PASSED:\d+:DEVICE_HISTORY$/);
  // 차단 키는 그대로다(통과는 라벨이 아니다)
  expect(await trustKeys('tr:block:*')).toHaveLength(1);
}, 60_000);

test('B-T10 ③ 인정하면 PASSED와 LABELED_HUMAN이 남고 근거에 차단 목록이 있으면 키가 지워진다', async () => {
  await blockDevice();
  const { eventId } = await openEvent();
  const pid = `${PID}-b10`;
  const { verdict } = await enterWithVerdict(eventId, pid, ACCOUNT, 'pass:preverify');
  expect(verdict).toEqual({ kind: 'VERIFY', reason: 'DEVICE_HISTORY' });
  // 판정 근거 키: 이 회차의 첫 CHALLENGE가 차단 목록이다
  expect(JSON.parse(String(await tcmd(`tr:vb:{${pid}}:${eventId}`, ['GET', `tr:vb:{${pid}}:${eventId}`])))).toMatchObject({ hardSignal: 'BLOCK_LIST' });
  const store = new RedisVerificationStore(queueRedis);
  const cases = recordingCases('ok');
  const out = await new SubmitAppeal(store, new RedisEventSchedules(queueRedis, systemClock), cases, TEST_OPTIONS, systemClock, recordingSignals()).run({ eventId, accountId: ACCOUNT, pid, text: '사람입니다. 재검토 바랍니다' });
  if (out.kind !== 'RECEIVED') throw new Error('접수되지 않았다');
  expect(cases.delivered).toHaveLength(1);
  // ops-svc 자리: 건을 만든 뒤 내용을 읽고, 인정을 queue-svc와 trust-svc에 알린다
  const read = await unary(appeals, 'GetVerificationAppeal', { appeal_id: out.appealId });
  expect(read).toMatchObject({ appeal_id: out.appealId, event_id: eventId, pid, text: '사람입니다. 재검토 바랍니다', reason_category: 'REASON_CATEGORY_DEVICE_HISTORY', entry_state: 'APPEAL_ENTRY_STATE_VERIFYING' });
  const caseId = `case-${eventId}`;
  expect(await unary(appeals, 'ResolveVerificationAppeal', { appeal_id: out.appealId, case_id: caseId, case_version: 1, outcome: 'APPEAL_OUTCOME_ACCEPTED' })).toEqual({ result: 'RESOLVE_APPEAL_RESULT_APPLIED' });
  const label = await unary(labels, 'ApplyLabel', { source_ref: caseId, source_version: 1, source: 'LABEL_SOURCE_APPEAL_ACCEPTED', label: 'LABEL_HUMAN', event_id: String(read.event_id), pid: String(read.pid), acted_by: 'cs-agent-1' });
  expect(label).toEqual({ changed: true, block_list: 'BLOCK_LIST_CHANGE_REMOVED' });
  // queue-svc: PASSED, trust-svc: 차단 키가 지워지고 라벨 기록(사람)이 남는다
  expect((await unary(appeals, 'GetVerificationAppeal', { appeal_id: out.appealId })).entry_state).toBe('APPEAL_ENTRY_STATE_PASSED');
  expect(await trustKeys('tr:block:*')).toEqual([]);
  const lbl = (await tcmd(`tr:lbl:{${caseId}}`, ['HGETALL', `tr:lbl:{${caseId}}`])) as unknown;
  const lblText = JSON.stringify(lbl);
  expect(lblText).toContain('HUMAN');
  expect(lblText).toContain('REMOVED');
  const metrics = await (await fetch(`http://127.0.0.1:${trustManagementPort}/metrics`)).text();
  expect(metrics).toContain('trust_block_list_changes_total{op="removed",source="APPEAL_ACCEPTED"} 1');
  // 다시 부르면 둘 다 같은 결과다(ops-svc 작업 워커의 다시 보내기)
  expect(await unary(appeals, 'ResolveVerificationAppeal', { appeal_id: out.appealId, case_id: caseId, case_version: 1, outcome: 'APPEAL_OUTCOME_ACCEPTED' })).toEqual({ result: 'RESOLVE_APPEAL_RESULT_UNCHANGED' });
  expect((await unary(labels, 'ApplyLabel', { source_ref: caseId, source_version: 1, source: 'LABEL_SOURCE_APPEAL_ACCEPTED', label: 'LABEL_HUMAN', event_id: eventId, pid, acted_by: 'cs-agent-1' })).changed).toBe(false);
  blocked = false;
}, 60_000);

test('B-T10 ④ 기각하면 BLOCKED로 끝나고 trust-svc 라벨 기록이 늘지 않는다', async () => {
  const { eventId } = await openEvent();
  const pid = `${PID}-b104`;
  const ticket = hashOf(`rej-${eventId}`);
  await qcmd(keys.dup(pid, eventId), ['SET', keys.dup(pid, eventId), numberDup(2, ticket)]);
  await qcmd(keys.verify(eventId), ['HSET', keys.verify(eventId), ticket, `VERIFYING:${Date.now()}:NETWORK`]);
  const before = (await trustKeys('tr:lbl:*')).length;
  const out = await new SubmitAppeal(new RedisVerificationStore(queueRedis), new RedisEventSchedules(queueRedis, systemClock), recordingCases('ok'), TEST_OPTIONS, systemClock, recordingSignals()).run({ eventId, accountId: ACCOUNT, pid, text: '' });
  if (out.kind !== 'RECEIVED') throw new Error('접수되지 않았다');
  expect(await unary(appeals, 'ResolveVerificationAppeal', { appeal_id: out.appealId, case_id: `case-${eventId}`, case_version: 1, outcome: 'APPEAL_OUTCOME_REJECTED' })).toEqual({ result: 'RESOLVE_APPEAL_RESULT_APPLIED' });
  expect(String(await qcmd(keys.verify(eventId), ['HGET', keys.verify(eventId), ticket]))).toMatch(/^BLOCKED:\d+:NETWORK$/);
  expect((await trustKeys('tr:lbl:*')).length).toBe(before);
  expect(turnstileSeen.length).toBeGreaterThan(0);
});
