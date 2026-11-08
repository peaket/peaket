// payment-svc 앱 프로세스(dist/main.js, 운영 시작 명령과 같은 node --import @peaket/platform/telemetry/register)를 자식으로 띄워 실제 PostgreSQL 18에 붙인다(BUILD_ORDER PRF-180).
// 정본: docs/features/payment.md §2 '승인 명령 접수의 첫 구현' 프로세스·지표·연결 풀, src/main.ts 머리 주석(풀 두 이름·종료 차례), docs/security/asvs/payment.md 16.2.5.
// 약속:
// - src/main.ts를 처음 부를 때 tsc로 빌드해 dist/main.js를 띄운다(지난 빌드를 돌리지 않게). @peaket/platform은 패키지 내보내기(dist)를 쓴다(CI는 turbo build 뒤에 이 시험을 돈다).
// - 포트 셋(앱·관리·gRPC)은 시험이 빈 포트를 골라 환경 값으로 준다. 프로세스 하나를 시험들이 나눠 쓰고, SIGTERM 시험이 맨 뒤에 끝낸다.
// - Windows는 child.kill('SIGTERM')이 처리기를 부르지 않고 바로 끝내므로 IPC로 SIGTERM을 낸다(sigterm-bridge.mjs). Linux는 진짜 신호다.
// - 로그는 자식의 표준 출력·오류를 모은 글이다. 결제 키·토큰이 없는지 본다(드라이버 오류 글에 문장 값이 실리는 길을 포함해).
import 'reflect-metadata';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { createDatabase, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePayment } from '../scripts/migrate.mjs';
import { freePort } from './kafka.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { failure, issuedSecrets, ledgerOf, outcomeCount, paymentClient, type PaymentClient, portoneConfirm, tossConfirm, unary, until } from './support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR = join(HERE, '..');
const CONFIRMS = 'payment_confirm_commands_total';

let pgc: PostgresContainer | undefined;
let admin: Database;

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 3, applicationName: 'payment-process-it-admin' });
  await ensureOutboxPartitions(admin, systemClock);
  await admin.pool.query(`
    create schema test_hooks;
    create table test_hooks.fail_order (order_id uuid primary key);
    create function test_hooks.fail_payment() returns trigger language plpgsql as $f$
    begin
      if exists (select 1 from test_hooks.fail_order f where f.order_id = new.order_id) then
        raise exception 'test-forced-failure';
      end if;
      return new;
    end $f$;
    -- payment INSERT에서 실패시킨다: Drizzle 오류 글에 실리는 값은 실패한 문장의 값이라, 결제 참조·토큰을 넣는 이 문장이어야 새는 길을 볼 수 있다
    create trigger test_fail_payment before insert on public.payment for each row execute function test_hooks.fail_payment();
  `);
}, 180_000);

/** tsc로 dist를 만든다(한 번만). 타입 오류면 그 글로 던진다 */
let built = false;
function build(): void {
  if (built) return;
  try {
    execFileSync(process.execPath, [join(SERVICE_DIR, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: SERVICE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`payment-svc 빌드 실패: ${(e as { stdout?: string }).stdout ?? String(e)}`);
  }
  built = true;
}

interface Running {
  child: ChildProcess;
  /** 표준 출력·오류를 받은 차례대로 이은 글 */
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** dist/main.js를 운영 시작 명령 그대로 띄운다 */
function spawnMain(env: Record<string, string | undefined>): Running {
  build();
  const { PEAKET_TEST_REPORT: _report, NODE_OPTIONS: _options, ...parent } = process.env;
  const child = spawn(process.execPath, ['--import', '@peaket/platform/telemetry/register', '--import', pathToFileURL(join(HERE, 'sigterm-bridge.mjs')).href, 'dist/main.js'], {
    cwd: SERVICE_DIR,
    env: { ...parent, PEAKET_ENV: 'local', OTEL_SERVICE_NAME: 'payment-svc', OTEL_TRACES_EXPORTER: 'none', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let text = '';
  child.stdout!.on('data', (d) => (text += String(d)));
  child.stderr!.on('data', (d) => (text += String(d)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, output: () => text, exited };
}

interface Service extends Running {
  managementPort: number;
  grpcPort: number;
  client: PaymentClient;
  exitedAt: () => { code: number | null; signal: NodeJS.Signals | null } | undefined;
}

let started: Promise<Service> | undefined;

async function startService(): Promise<Service> {
  const [appPort, managementPort, grpcPort] = [await freePort(), await freePort(), await freePort()];
  const running = spawnMain({
    PEAKET_DATABASE_URL: pgc!.url,
    PORT: String(appPort),
    PEAKET_MANAGEMENT_PORT: String(managementPort),
    PEAKET_GRPC_HOST: '127.0.0.1',
    PEAKET_GRPC_PORT: String(grpcPort),
    PEAKET_LOG_LEVEL: 'info',
  });
  let gone: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  void running.exited.then((e) => (gone = e));
  const live = async () => {
    if (gone) throw new Error(`프로세스가 일찍 끝났다(${JSON.stringify(gone)}): ${running.output().slice(-2000)}`);
    try {
      return (await fetch(`http://127.0.0.1:${managementPort}/ready`)).status === 200;
    } catch {
      return false;
    }
  };
  await until(live, '준비 프로브 /ready', 60_000, 100);
  const client = paymentClient(`127.0.0.1:${grpcPort}`);
  await new Promise<void>((resolve, reject) => client.waitForReady(new Date(Date.now() + 20_000), (e) => (e ? reject(e) : resolve())));
  return { ...running, managementPort, grpcPort, client, exitedAt: () => gone };
}

const service = (): Promise<Service> => (started ??= startService());
const metricsOf = async (s: Service) => (await fetch(`http://127.0.0.1:${s.managementPort}/metrics`)).text();

afterAll(async () => {
  const s = await started?.catch(() => undefined);
  s?.client.close();
  if (s && !s.exitedAt()) s.child.kill('SIGKILL');
  await Promise.allSettled([admin?.close()]);
  pgc?.stop();
});

/** 우아한 종료를 부른다(머리 주석) */
function sigterm(c: ChildProcess): void {
  if (process.platform === 'win32') c.send('SIGTERM');
  else c.kill('SIGTERM');
}

/** payment 표를 잠근 채 call을 부르고, 그 잠금을 기다리는 서비스 연결의 application_name을 돌려준다(호출이 어느 풀로 나갔는지 본다). 호출의 성패는 보지 않는다 */
async function poolWaitingOnLedger(call: () => Promise<unknown>): Promise<string[]> {
  const locker = await admin.pool.connect();
  let names: string[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  try {
    await locker.query('begin');
    await locker.query('lock table payment in access exclusive mode');
    pending = call().catch(() => undefined);
    await until(
      async () => {
        names = (await admin.pool.query<{ application_name: string }>(`select application_name from pg_stat_activity where application_name like 'payment-svc%' and wait_event_type = 'Lock'`)).rows.map((r) => r.application_name);
        return names.length > 0;
      },
      'payment 표 잠금을 기다리는 연결',
      5_000,
      10,
    );
  } finally {
    await locker.query('rollback').catch(() => {});
    locker.release();
  }
  await pending;
  return names;
}

describe('payment-svc 앱 프로세스', () => {
  test('PRF180_시작하면 /livez·/ready가 200이고 /metrics에 승인 명령·결과 조회 지표 이름이 있다', async () => {
    const s = await service();
    expect((await fetch(`http://127.0.0.1:${s.managementPort}/livez`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${s.managementPort}/ready`)).status).toBe(200);
    const text = await metricsOf(s);
    expect(text).toMatch(/^# TYPE payment_confirm_commands_total counter$/m);
    expect(text).toMatch(/^# TYPE payment_batch_get_requests_total counter$/m);
  }, 120_000);

  test('P-T53_프로세스의 gRPC 포트로 ConfirmPayment를 받아 원장을 쓰고 지표 accepted가 오르며, 다시 보내면 replayed다 [ASVS v5.0.0-2.3.3]', async () => {
    const s = await service();
    const before = await metricsOf(s);
    const f = tossConfirm();
    const reply = await unary(s.client, 'ConfirmPayment', f.request);
    const { payments, events, jobs } = await ledgerOf(admin, f.orderId);
    expect([payments.length, events.length, jobs.length]).toEqual([1, 1, 1]);
    expect(reply).toMatchObject({ result: 'CONFIRM_RESULT_IN_PROGRESS', payment_id: payments[0]!.id });
    await expect(unary(s.client, 'ConfirmPayment', f.request)).resolves.toEqual(reply);

    const after = await metricsOf(s);
    expect(outcomeCount(after, CONFIRMS, 'accepted') - outcomeCount(before, CONFIRMS, 'accepted')).toBe(1);
    expect(outcomeCount(after, CONFIRMS, 'replayed') - outcomeCount(before, CONFIRMS, 'replayed')).toBe(1);
  }, 60_000);

  test('P-T54_프로세스의 gRPC 포트로 BatchGetPayments를 답하고, 두 풀이 정해진 이름(payment-svc·payment-svc-batch)으로 붙어 있다', async () => {
    const s = await service();
    const f = tossConfirm();
    await unary(s.client, 'ConfirmPayment', f.request);
    const got = await unary(s.client, 'BatchGetPayments', { order_ids: [f.orderId] });
    expect(got.payments).toEqual([expect.objectContaining({ order_id: f.orderId, status: 'PAYMENT_STATUS_ACCEPTED' })]);

    const names = (await admin.pool.query<{ application_name: string }>(`select distinct application_name from pg_stat_activity where application_name like 'payment-svc%' order by 1`)).rows.map((r) => r.application_name);
    expect(names).toEqual(['payment-svc', 'payment-svc-batch']);
  }, 60_000);

  test('P-T53_P-T54_승인 명령 쓰기는 핫패스 풀(payment-svc), 결과 조회는 일반 풀(payment-svc-batch)의 연결로 나간다(main.ts가 둘을 맞바꾸면 실패한다)', async () => {
    const s = await service();
    const f = tossConfirm();
    expect(await poolWaitingOnLedger(() => unary(s.client, 'ConfirmPayment', f.request))).toEqual(['payment-svc']);
    expect(await poolWaitingOnLedger(() => unary(s.client, 'BatchGetPayments', { order_ids: [f.orderId] }))).toEqual(['payment-svc-batch']);
  }, 60_000);

  test('P-T53_다른 금액으로 다시 부르면 SEV2 로그 한 줄(kind payment-confirm-mismatch)이 프로세스 표준 출력에 나가고 주문 ID만 싣는다 [ASVS v5.0.0-16.2.5]', async () => {
    const s = await service();
    const f = tossConfirm();
    await unary(s.client, 'ConfirmPayment', f.request);
    const err = await failure(unary(s.client, 'ConfirmPayment', { ...f.request, amount: { krw: f.amount + 1 } }));
    expect(err.code).toBe(grpc.status.FAILED_PRECONDITION);

    const lines = () => s.output().split('\n').filter((l) => l.includes('payment-confirm-mismatch') && l.includes(f.orderId));
    await until(() => lines().length >= 1, '불일치 로그 줄', 5_000, 50);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).not.toContain(f.paymentKey);
  }, 60_000);

  test('P-T53_쓰기가 드라이버 오류로 실패해 INTERNAL로 답해도 프로세스 로그와 오류 글에 포트원 토큰·결제 키가 없다(오류 글에 문장 값이 실리는 길) [ASVS v5.0.0-16.2.5]', async () => {
    const s = await service();
    const f = portoneConfirm();
    await admin.pool.query('insert into test_hooks.fail_order (order_id) values ($1)', [f.orderId]);
    const mark = s.output().length;

    const err = await failure(unary(s.client, 'ConfirmPayment', f.request));

    expect(err.code).toBe(grpc.status.INTERNAL);
    expect(err.details).not.toContain('test-forced-failure');
    expect(err.details).not.toContain(f.paymentToken);
    // 서비스가 이유를 서버 쪽 기록에 남겼다(주문 ID는 값 칸으로 남아도 된다. 토큰·참조는 안 된다)
    await until(() => s.output().slice(mark).includes('test-forced-failure') || s.output().slice(mark).includes('ConfirmPayment'), '내부 오류 로그 줄', 5_000, 50);
    const logged = s.output().slice(mark);
    expect(logged).not.toContain(f.paymentToken);
    expect(logged).not.toContain(f.paymentId);
    expect((await ledgerOf(admin, f.orderId)).payments).toEqual([]);
  }, 60_000);

  test('PRF180_설정이 틀리면 뜨지 않고 빠진 이름을 알린다(PEAKET_DATABASE_URL 없음, PEAKET_GRPC_PORT 틀림)', async () => {
    const noUrl = spawnMain({ PEAKET_DATABASE_URL: undefined, PORT: '0', PEAKET_MANAGEMENT_PORT: '0' });
    const a = await noUrl.exited;
    expect(a.code).not.toBe(0);
    expect(noUrl.output()).toContain('PEAKET_DATABASE_URL');

    const badPort = spawnMain({ PEAKET_DATABASE_URL: pgc!.url, PEAKET_GRPC_PORT: '70000', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' });
    const b = await badPort.exited;
    expect(b.code).not.toBe(0);
    expect(badPort.output()).toContain('PEAKET_GRPC_PORT');
  }, 60_000);

  test('PRF180_프로세스 로그 전체에 결제 키·토큰이 없다(앞 시험들이 보낸 모든 값) [ASVS v5.0.0-16.2.5]', async () => {
    const s = await service();
    const text = s.output();
    expect(issuedSecrets.length).toBeGreaterThan(0);
    for (const v of issuedSecrets) expect(text).not.toContain(v);
  });

  test('PRF180_SIGTERM이면 gRPC·관리 포트를 닫고 DB 풀 둘을 닫은 뒤 코드 0으로 스스로 끝난다', async () => {
    const s = await service();
    sigterm(s.child);

    const result = await Promise.race([s.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000))]);
    expect(result, s.output().slice(-2000)).toEqual({ code: 0, signal: null });

    await expect(fetch(`http://127.0.0.1:${s.managementPort}/livez`)).rejects.toThrow();
    const err = await failure(unary(s.client, 'BatchGetPayments', { order_ids: [] }, 1_000));
    expect([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]).toContain(err.code);
    await until(
      async () => Number((await admin.pool.query<{ n: string }>(`select count(*) as n from pg_stat_activity where application_name like 'payment-svc%'`)).rows[0]!.n) === 0,
      'DB 연결 닫힘',
      10_000,
    );
  }, 60_000);
});
