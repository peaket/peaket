// 증거 수집기 통합 시험(기능 F-01-1, OPS-030, 시험 D-T51 ①⑤⑥). 실제 PostgreSQL 18·Valkey 8.1 컨테이너를 수집 대상으로 둔다.
// 정본: docs/observability.md §5 '진단 증거'(뜨는 것·올리기·신호), docs/devops.md D-T51, docs/security/data-classification.md '진단 증거' 행, ADR-0070 결정 1.
// 가짜는 진단 증거 저장소(바이트를 모으는 짝 가짜, test/support.ts)뿐이다. Docker 엔진이 없으면 실패한다(건너뛰지 않는다).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildEvidenceCollector, type EvidenceCollectorApp } from '../src/collector-app.js';
import { causeSev2, envFor, KEY_SHAPE, logSink, type Manifest, MemoryBytesStore, metric, metricsText, send, TOKEN, webhook } from '../test/support.js';
import { type PostgresTarget, startPostgres, startValkey, type ValkeyTarget } from './containers.js';

// 표지 글자: 실행마다 다르게 만든다(다른 시험 실행과 섞이지 않게)
const run = randomBytes(4).toString('hex');
const QUERY_MARK = `ev-query-${run}`;
const KEY_MARK = `ev-key-${run}`;
const SLOT = `ev_slot_${run}`;
const DESC_MARK = `ev-desc-${run}`;
const MONITOR = { user: 'evidence_ro', password: `pw-pg-${run}` };
const RESTRICTED = { user: 'evidence', password: `pw-valkey-${run}` };

const PG_FILES = ['pg-activity.json', 'pg-blocking.json', 'pg-replication-slots.json'];
const REDIS_FILES = ['redis-info.txt', 'redis-slowlog.json', 'redis-client-list.txt'];

let pgT: PostgresTarget | undefined;
let valkey: ValkeyTarget | undefined;
let holder: pg.Client | undefined;
let waiter: pg.Client | undefined;
let waiting: Promise<unknown> | undefined;
let app: EvidenceCollectorApp | undefined;
let pidHolder = 0;
let pidWaiter = 0;
const store = new MemoryBytesStore();
const logs = logSink();
let accepted: { statusCode: number; json: unknown } | undefined;
let metrics = '';

/** JSON 안의 모든 객체(깊이와 상관없이) */
function* objectsIn(v: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(v)) for (const x of v) yield* objectsIn(x);
  else if (v && typeof v === 'object') {
    yield v as Record<string, unknown>;
    for (const x of Object.values(v)) yield* objectsIn(x);
  }
}
const same = (a: unknown, b: number) => String(a) === String(b);
const hasPid = (o: Record<string, unknown>, pid: number) => Object.values(o).some((x) => same(x, pid) || (Array.isArray(x) && x.some((y) => same(y, pid))));

/** 한 대상의 키: 수집 시각 폴더 하나 아래 파일 이름 목록 */
function folderOf(target: string): { folders: string[]; files: string[] } {
  const keys = store.keys().filter((k) => k.startsWith(`evidence-collector/${target}/`));
  const folders = [...new Set(keys.map((k) => k.split('/').slice(0, 3).join('/')))];
  return { folders, files: keys.map((k) => k.split('/')[3]!).sort() };
}
const keyOf = (target: string, file: string) => store.keys().find((k) => k.startsWith(`evidence-collector/${target}/`) && k.endsWith(`/${file}`))!;

beforeAll(async () => {
  [pgT, valkey] = await Promise.all([startPostgres(MONITOR), startValkey(RESTRICTED)]);

  // PostgreSQL: 복제 슬롯 하나, 한 세션이 행 잠금을 쥐고 다른 세션이 같은 행을 기다린다
  const admin = new pg.Client({ connectionString: pgT.adminUrl });
  await admin.connect();
  await admin.query('create table it_rows (id int primary key, v int not null)');
  await admin.query('insert into it_rows values (1, 0)');
  await admin.query(`select pg_create_physical_replication_slot('${SLOT}', true)`);
  holder = new pg.Client({ connectionString: pgT.adminUrl, application_name: 'it-holder' });
  waiter = new pg.Client({ connectionString: pgT.adminUrl, application_name: 'it-waiter' });
  await Promise.all([holder.connect(), waiter.connect()]);
  pidHolder = Number((await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid);
  pidWaiter = Number((await waiter.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid);
  await holder.query('begin');
  await holder.query('update it_rows set v = v + 1 where id = 1');
  waiting = waiter.query(`update it_rows set v = v + 1 where id = 1 /* ${QUERY_MARK} */`).catch((err: unknown) => err);
  // 기다리는 세션이 잠금 대기에 들어갈 때까지 조건으로 기다린다
  for (let i = 0; ; i++) {
    const r = await admin.query<{ wait_event_type: string | null }>('select wait_event_type from pg_stat_activity where pid = $1', [pidWaiter]);
    if (r.rows[0]?.wait_event_type === 'Lock') break;
    if (i > 300) throw new Error('기다리는 세션이 잠금 대기에 들어가지 않았다');
    await new Promise((res) => setTimeout(res, 100));
  }
  await admin.end();

  // Valkey: 모든 명령을 느린 명령 기록에 남기고 표지 키를 하나 쓴다(SLOWLOG GET 답에 그 키 이름이 실린다)
  valkey.cli('CONFIG', 'SET', 'slowlog-log-slower-than', '0');
  valkey.cli('SET', KEY_MARK, '1');
  expect(valkey.cli('SLOWLOG', 'GET', '128')).toContain(KEY_MARK);

  // 수집 대상 셋: 실제 PostgreSQL, 실제 Valkey, 접속할 수 없는 PostgreSQL(⑥)
  const env = envFor([
    ['orders-db', 'postgres', pgT.monitorUrl],
    ['hot-redis', 'redis', valkey.restrictedUrl],
    ['dead-db', 'postgres', `postgres://${MONITOR.user}:${MONITOR.password}@127.0.0.1:1/peaket`],
  ]);
  app = await buildEvidenceCollector({ env, store, logDestination: logs.stream });
  const desc = { summary: `포화 ${DESC_MARK}`, description: `설명 ${DESC_MARK}`, runbook_url: `https://runbooks.example.test/${DESC_MARK}` };
  const r = await send(
    app,
    webhook([
      causeSev2('orders-db', { fingerprint: 'fp-orders', annotations: desc }),
      causeSev2('hot-redis', { fingerprint: 'fp-redis', annotations: desc }),
      causeSev2('dead-db', { fingerprint: 'fp-dead', annotations: desc }),
    ]),
    TOKEN,
  );
  accepted = { statusCode: r.statusCode, json: r.json };
  await app.idle();
  metrics = await metricsText(app);
}, 240_000);

afterAll(async () => {
  await holder?.query('rollback').catch(() => {});
  await waiting;
  await Promise.all([holder?.end().catch(() => {}), waiter?.end().catch(() => {})]);
  await app?.service.close();
  pgT?.stop();
  valkey?.stop();
}, 120_000);

describe('D-T51 증거 수집기(실제 PostgreSQL·Valkey)', () => {
  test('D-T51 ① 원인 SEV2 경보 하나로 PostgreSQL은 세션·막는 쪽·복제 슬롯을, Valkey는 세 명령의 답을 올린다', () => {
    expect(accepted).toEqual({ statusCode: 202, json: { accepted: 3 } });

    // 대상 이름 아래 한 수집 시각 폴더
    const orders = folderOf('orders-db');
    expect(orders.folders).toHaveLength(1);
    expect(orders.files).toEqual([...PG_FILES, 'manifest.json'].sort());
    const hot = folderOf('hot-redis');
    expect(hot.folders).toHaveLength(1);
    expect(hot.files).toEqual([...REDIS_FILES, 'manifest.json'].sort());

    // 막는 쪽: 기다리는 세션과 그 잠금을 쥔 세션의 pid
    const blocking = store.json(keyOf('orders-db', 'pg-blocking.json'));
    const blockedEntry = [...objectsIn(blocking)].find((o) => hasPid(o, pidWaiter) && hasPid(o, pidHolder));
    expect(blockedEntry, `pg-blocking.json에 기다리는 pid ${pidWaiter}와 막는 pid ${pidHolder}: ${JSON.stringify(blocking)}`).toBeDefined();

    // 세션 목록: 기다리는 세션의 쿼리 문장이 있고, 클라이언트 주소 칸과 수집기 자기 세션이 없다
    const activity = store.json(keyOf('orders-db', 'pg-activity.json'));
    const rows = [...objectsIn(activity)];
    const waiterRow = rows.find((o) => hasPid(o, pidWaiter));
    expect(waiterRow, 'pg-activity.json에 기다리는 세션').toBeDefined();
    expect(JSON.stringify(waiterRow)).toContain(QUERY_MARK);
    expect(rows.some((o) => hasPid(o, pidHolder))).toBe(true);
    for (const o of rows) {
      expect(Object.keys(o).filter((k) => ['client_addr', 'client_hostname', 'client_port'].includes(k))).toEqual([]);
      expect(o.application_name ?? o.applicationName).not.toBe('evidence-collector');
    }

    // 복제 슬롯
    expect(store.text(keyOf('orders-db', 'pg-replication-slots.json'))).toContain(SLOT);

    // Valkey 세 명령의 답(제한 사용자로 뜬다. 다른 명령을 보냈다면 NOPERM으로 partial이 된다)
    expect(store.text(keyOf('hot-redis', 'redis-info.txt'))).toMatch(/^# Server/m);
    expect(store.text(keyOf('hot-redis', 'redis-slowlog.json'))).toContain(KEY_MARK);
    expect(store.text(keyOf('hot-redis', 'redis-client-list.txt'))).toMatch(/^id=\d+ addr=/m);

    // manifest: 대상·종류·경보 칸, 뜬 것의 목록, 오류 없음
    const om = store.json(keyOf('orders-db', 'manifest.json')) as Manifest;
    expect({ target: om.target, kind: om.kind }).toEqual({ target: 'orders-db', kind: 'postgres' });
    expect(om.collectedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(orders.folders[0]).toBe(`evidence-collector/orders-db/${om.collectedAt}`);
    expect(om.files.filter((f) => f !== 'manifest.json').sort()).toEqual([...PG_FILES].sort());
    expect(om.errors).toEqual([]);
    expect(om.alerts).toContainEqual({ fingerprint: 'fp-orders', alertname: 'DependencySaturated', severity: 'sev2', kind: 'cause', dependency: 'orders-db' });
    const hm = store.json(keyOf('hot-redis', 'manifest.json')) as Manifest;
    expect({ target: hm.target, kind: hm.kind }).toEqual({ target: 'hot-redis', kind: 'redis' });
    expect(hm.files.filter((f) => f !== 'manifest.json').sort()).toEqual([...REDIS_FILES].sort());
    expect(hm.errors).toEqual([]);

    expect(metric(metrics, 'evidence_collections_total', { target: 'orders-db', result: 'uploaded' })).toBe(1);
    expect(metric(metrics, 'evidence_collections_total', { target: 'hot-redis', result: 'uploaded' })).toBe(1);
    expect(metric(metrics, 'evidence_webhook_alerts_total', { decision: 'collect' })).toBe(3);
  });

  test('D-T51 ⑤ [ASVS v5.0.0-14.1.1] [ASVS v5.0.0-14.2.1] [ASVS v5.0.0-14.2.2] [ASVS v5.0.0-14.2.4] 객체 이름에 경보 값이 없고 뜬 내용은 객체에만 있으며 분류 행에 있는 것만 뜬다', () => {
    const keys = store.keys();
    expect(keys.length).toBe(PG_FILES.length + REDIS_FILES.length + 3);
    for (const k of keys) {
      const target = k.split('/')[1]!;
      expect(k).toMatch(KEY_SHAPE(target));
      expect(k).not.toContain(DESC_MARK);
      expect(k).not.toContain('fp-');
    }

    // manifest.json에 경보 설명 글이 없다
    for (const t of ['orders-db', 'hot-redis', 'dead-db']) expect(store.text(keyOf(t, 'manifest.json'))).not.toContain(DESC_MARK);

    // 시험이 넣은 쿼리 문장·키 이름은 객체에만 있고 로그 바이트와 지표 본문에는 없다
    const objects = store.allText();
    expect(objects).toContain(QUERY_MARK);
    expect(objects).toContain(KEY_MARK);
    const logText = logs.text();
    expect(logText.length).toBeGreaterThan(0);
    for (const mark of [QUERY_MARK, KEY_MARK, SLOT, DESC_MARK, MONITOR.password, RESTRICTED.password, TOKEN]) {
      expect(logText).not.toContain(mark);
      expect(metrics).not.toContain(mark);
    }
    // 수집마다 정보 로그 한 줄(kind evidence)
    expect(logs.lines().filter((l) => l.kind === 'evidence')).toHaveLength(3);

    // 수집기는 파일 경로로 올리는 길을 쓰지 않는다(디스크에 쓰지 않고 바이트를 바로 올린다)
    expect(store.filePuts).toEqual([]);

    // 뜬 것의 종류는 모두 data-classification '진단 증거' 행(P1)에 있다(행 글귀는 문서에서 읽는다)
    const doc = readFileSync(new URL('../../../docs/security/data-classification.md', import.meta.url), 'utf8');
    const row = doc.split(/\r?\n/).find((l) => l.startsWith('| 진단 증거('));
    expect(row, 'data-classification.md의 진단 증거 행').toBeDefined();
    const cells = row!.split('|').map((c) => c.trim());
    // 칸: (빈칸) | 항목 명칭 | 수집 시점 | 필수 여부 | 보호 등급 | …
    expect(cells[4]).toBe('P1');
    const phraseOf: Record<string, string> = {
      'pg-activity.json': '세션 목록',
      'pg-blocking.json': '막는 쪽',
      'pg-replication-slots.json': '복제 슬롯',
      'redis-info.txt': '`INFO`',
      'redis-slowlog.json': '`SLOWLOG`',
      'redis-client-list.txt': '`CLIENT LIST`',
      'manifest.json': '`manifest.json`',
    };
    const uploaded = [...new Set(keys.map((k) => k.split('/')[3]!))].sort();
    expect(uploaded).toEqual(Object.keys(phraseOf).sort());
    for (const f of uploaded) expect(cells[1], `${f}의 종류가 분류 행에 있다`).toContain(phraseOf[f]);
  });

  test('D-T51 ⑥ 접속할 수 없는 대상은 failed이고 manifest만 올라가며 다른 대상은 그대로 올라간다', () => {
    const dead = folderOf('dead-db');
    expect(dead.files).toEqual(['manifest.json']);
    const dm = store.json(keyOf('dead-db', 'manifest.json')) as Manifest;
    expect(dm.errors.length).toBeGreaterThanOrEqual(1);
    for (const e of dm.errors) expect(e.code).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    expect(store.text(keyOf('dead-db', 'manifest.json'))).not.toContain('127.0.0.1');
    expect(metric(metrics, 'evidence_collections_total', { target: 'dead-db', result: 'failed' })).toBe(1);
    // 같은 웹훅의 다른 대상은 그대로 올라갔다
    expect(metric(metrics, 'evidence_collections_total', { target: 'orders-db', result: 'uploaded' })).toBe(1);
    expect(metric(metrics, 'evidence_collections_total', { target: 'hot-redis', result: 'uploaded' })).toBe(1);
    expect(folderOf('orders-db').files).toHaveLength(PG_FILES.length + 1);
    expect(folderOf('hot-redis').files).toHaveLength(REDIS_FILES.length + 1);
  });
});
