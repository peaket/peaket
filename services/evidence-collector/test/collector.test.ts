// 증거 수집기 단위 시험(기능 F-01-1, OPS-030, 시험 D-T51 ②③④⑥).
// 정본: docs/observability.md §5 '진단 증거'(증거 수집기의 동작: 받는 길·토큰·수집하는 경보·간격·올리기·신호), docs/devops.md D-T51, ADR-0070 결정 1.
// 웹훅(HTTP inject) → 경보 고르기·간격 → 뜨기 → 저장소까지 부르는 쪽을 통째로 본다. 가짜는 저장소(바이트 모으기)와 시계뿐이다.
// 수집 대상은 접속할 수 없는 주소(닫힌 포트 127.0.0.1:1)다: 수집 시도는 실패해도 manifest.json 하나로 남으므로(⑥) 그 개수로 센다.
// 실제 PostgreSQL·Valkey를 뜨는 것은 test-int/collector.int.test.ts(D-T51 ①⑤⑥)가 본다.
import { afterEach, describe, expect, test } from 'vitest';
import { fakeClock, type FakeClock } from '@peaket/platform';
import { buildEvidenceCollector, type EvidenceCollectorApp } from '../src/collector-app.js';
import { causeSev2, envFor, logSink, type Manifest, MemoryBytesStore, metric, metricsText, send, TOKEN, webhook, WRONG_TOKEN } from './support.js';

// 정본 값(docs/observability.md §5 '진단 증거': 대상마다 마지막 수집을 시작한 뒤 10분 [가정] 안의 경보는 다시 뜨지 않는다)
const INTERVAL_MS = 10 * 60 * 1000;
const START = '2026-11-23T02:00:00.000Z';
// 비밀번호 표지(접속 주소에만 있다. 로그·객체 어디에도 나오면 안 된다)
const DB_PASSWORD = 'pw-db-31d7c0e9';
const REDIS_PASSWORD = 'pw-redis-5a92be41';
const DEAD_PG = `postgres://evidence:${DB_PASSWORD}@127.0.0.1:1/peaket`;
const DEAD_REDIS = `redis://evidence:${REDIS_PASSWORD}@127.0.0.1:1`;
// real-time: 닫힌 포트 접속 실패를 실제로 본다. Windows는 거절된 localhost 접속을 약 2초 다시 시도하므로 시험마다 시간 한도를 따로 준다 F-01-1
const T = { timeout: 60_000 };

interface Harness {
  app: EvidenceCollectorApp;
  store: MemoryBytesStore;
  clock: FakeClock;
  logs: ReturnType<typeof logSink>;
}
const open: EvidenceCollectorApp[] = [];
afterEach(async () => {
  for (const a of open.splice(0)) await a.service.close();
});

async function harness(env = envFor([['orders-db', 'postgres', DEAD_PG], ['hot-redis', 'redis', DEAD_REDIS]])): Promise<Harness> {
  const store = new MemoryBytesStore();
  const clock = fakeClock({ now: Date.parse(START), monotonic: 1_000_000 });
  const logs = logSink();
  const app = await buildEvidenceCollector({ env, store, clock, logDestination: logs.stream });
  open.push(app);
  return { app, store, clock, logs };
}

describe('D-T51 증거 수집기(단위)', () => {
  test('D-T51 ② 같은 대상은 10분 안에 다시 뜨지 않고 10분 뒤 뜨며 동시 둘은 한 번이다', T, async () => {
    const h = await harness();

    // 첫 수집: 202로 바로 답하고, 답한 뒤에 수집한다
    const first = await send(h.app, webhook([causeSev2('orders-db')]));
    expect(first.statusCode).toBe(202);
    expect(first.json).toEqual({ accepted: 1 });
    await h.app.idle();
    expect(h.store.manifests('orders-db')).toEqual([`evidence-collector/orders-db/${START}/manifest.json`]);

    // 9분 59초 뒤: throttled, 객체가 늘지 않는다
    h.clock.advance(INTERVAL_MS - 1000);
    expect((await send(h.app, webhook([causeSev2('orders-db')]))).statusCode).toBe(202);
    await h.app.idle();
    expect(h.store.manifests('orders-db')).toHaveLength(1);
    let m = await metricsText(h.app);
    expect(metric(m, 'evidence_collections_total', { target: 'orders-db', result: 'throttled' })).toBe(1);

    // 첫 수집 시작부터 10분: 새로 뜬다
    h.clock.advance(1000);
    expect((await send(h.app, webhook([causeSev2('orders-db')]))).statusCode).toBe(202);
    await h.app.idle();
    const later = new Date(Date.parse(START) + INTERVAL_MS).toISOString();
    expect(h.store.manifests('orders-db')).toEqual([`evidence-collector/orders-db/${START}/manifest.json`, `evidence-collector/orders-db/${later}/manifest.json`]);

    // 다른 대상에 동시 웹훅 둘: 수집 한 번
    const [a, b] = await Promise.all([send(h.app, webhook([causeSev2('hot-redis')])), send(h.app, webhook([causeSev2('hot-redis')]))]);
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    await h.app.idle();
    expect(h.store.manifests('hot-redis')).toHaveLength(1);

    m = await metricsText(h.app);
    // 접속할 수 없는 대상의 수집은 failed로 센다(⑥). 지표로도 같은 수
    expect(metric(m, 'evidence_collections_total', { target: 'orders-db', result: 'failed' })).toBe(2);
    expect(metric(m, 'evidence_collections_total', { target: 'orders-db', result: 'throttled' })).toBe(1);
    expect(metric(m, 'evidence_collections_total', { target: 'hot-redis', result: 'failed' })).toBe(1);
    expect(metric(m, 'evidence_collections_total', { target: 'orders-db', result: 'uploaded' })).toBe(0);
    expect(metric(m, 'evidence_webhook_alerts_total', { decision: 'collect' })).toBe(5);
    // 이 시험의 객체는 manifest.json 셋뿐이다(뜨지 못한 대상은 다른 파일을 올리지 않는다)
    expect(h.store.keys()).toHaveLength(3);
  });

  test('D-T51 ③ 해제·sev3·cause 아닌 sev2는 뜨지 않고, 모르는 의존성은 unknown_dependency, dependency 없는 sev1·IncidentDeclared는 모든 대상을 뜬다', T, async () => {
    const h = await harness();

    // 앞의 셋: 해제 경보, sev3, kind가 cause가 아닌 sev2(모두 수집 대상 orders-db의 dependency를 단다)
    const ignored = await send(
      h.app,
      webhook([
        { status: 'resolved', labels: { alertname: 'DependencySaturated', severity: 'sev2', kind: 'cause', dependency: 'orders-db' } },
        { labels: { alertname: 'DependencySaturated', severity: 'sev3', kind: 'cause', dependency: 'orders-db' } },
        { labels: { alertname: 'LoginFlowDrop', severity: 'sev2', kind: 'flow', dependency: 'orders-db' } },
      ]),
    );
    expect(ignored.statusCode).toBe(202);
    expect(ignored.json).toEqual({ accepted: 3 });
    await h.app.idle();
    let m = await metricsText(h.app);
    expect(metric(m, 'evidence_webhook_alerts_total', { decision: 'ignored' })).toBe(3);
    expect(h.store.keys()).toEqual([]);

    // 넷째: 수집 대상에 없는 dependency의 sev2 cause
    expect((await send(h.app, webhook([causeSev2('search-db')]))).statusCode).toBe(202);
    await h.app.idle();
    m = await metricsText(h.app);
    expect(metric(m, 'evidence_webhook_alerts_total', { decision: 'unknown_dependency' })).toBe(1);
    expect(h.store.keys()).toEqual([]);
    expect(metric(m, 'evidence_webhook_alerts_total', { decision: 'collect' })).toBe(0);

    // 다섯째: dependency 없는 sev1 → 모든 대상
    expect((await send(h.app, webhook([{ labels: { alertname: 'OnsaleBudgetBurn', severity: 'sev1', kind: 'budget' } }]))).statusCode).toBe(202);
    await h.app.idle();
    expect(h.store.manifests('orders-db')).toHaveLength(1);
    expect(h.store.manifests('hot-redis')).toHaveLength(1);

    // 여섯째: 인시던트 선언(간격에 걸리지 않게 10분 민다) → 모든 대상
    h.clock.advance(INTERVAL_MS);
    expect((await send(h.app, webhook([{ labels: { alertname: 'IncidentDeclared' } }]))).statusCode).toBe(202);
    await h.app.idle();
    expect(h.store.manifests('orders-db')).toHaveLength(2);
    expect(h.store.manifests('hot-redis')).toHaveLength(2);

    m = await metricsText(h.app);
    expect(metric(m, 'evidence_webhook_alerts_total', { decision: 'ignored' })).toBe(3);
    expect(metric(m, 'evidence_webhook_alerts_total', { decision: 'unknown_dependency' })).toBe(1);
    expect(metric(m, 'evidence_webhook_alerts_total', { decision: 'collect' })).toBe(2);
    // 인시던트 선언 manifest는 그 경보를 싣는다
    const latest = h.store.manifests('orders-db').at(-1)!;
    expect((h.store.json(latest) as Manifest).alerts.map((x) => x.alertname)).toEqual(['IncidentDeclared']);
  });

  test('D-T51 ④ [ASVS v5.0.0-16.3.3] 토큰이 없거나 틀린 웹훅은 401이고 수집 없이 보안 사건으로 남는다', T, async () => {
    const h = await harness();

    const missing = await send(h.app, webhook([causeSev2('orders-db')]), null);
    const mismatch = await send(h.app, webhook([causeSev2('orders-db')]), WRONG_TOKEN);
    for (const r of [missing, mismatch]) {
      expect(r.statusCode).toBe(401);
      expect(r.contentType).toMatch(/^application\/problem\+json/);
    }
    await h.app.idle();
    expect(h.store.keys()).toEqual([]);

    const rejected = h.logs.lines().filter((l) => l.kind === 'security' && l.event === 'evidence_webhook_rejected');
    expect(rejected.map((l) => l.reason).sort()).toEqual(['mismatch', 'missing']);
    let m = await metricsText(h.app);
    expect(metric(m, 'evidence_webhook_rejected_total', { reason: 'missing' })).toBe(1);
    expect(metric(m, 'evidence_webhook_rejected_total', { reason: 'mismatch' })).toBe(1);
    expect(metric(m, 'evidence_webhook_alerts_total', { decision: 'collect' })).toBe(0);

    // 맞는 토큰은 받는다(가드가 늘 거절하는 결함을 잡는다)
    const ok = await send(h.app, webhook([causeSev2('orders-db')]), TOKEN);
    expect(ok.statusCode).toBe(202);
    await h.app.idle();
    expect(h.store.manifests('orders-db')).toHaveLength(1);
    m = await metricsText(h.app);
    expect(metric(m, 'evidence_webhook_rejected_total', { reason: 'missing' })).toBe(1);
    expect(metric(m, 'evidence_webhook_rejected_total', { reason: 'mismatch' })).toBe(1);

    // 모은 로그 바이트 어디에도 보낸 토큰(틀린 것·맞는 것)이 없다
    const text = h.logs.text();
    expect(text).not.toContain(WRONG_TOKEN);
    expect(text).not.toContain(TOKEN);
    expect(m).not.toContain(WRONG_TOKEN);
    expect(m).not.toContain(TOKEN);
  });

  test('D-T51 ⑥ 접속할 수 없는 대상은 failed이고 manifest만 올라가며 환경 값이 빠지면 시작하지 않는다', T, async () => {
    const h = await harness();
    expect((await send(h.app, webhook([causeSev2('orders-db', { fingerprint: 'fp-dead-orders' }), causeSev2('hot-redis')]))).statusCode).toBe(202);
    await h.app.idle();

    // 대상마다 manifest.json 하나뿐
    expect(h.store.keys()).toEqual([`evidence-collector/hot-redis/${START}/manifest.json`, `evidence-collector/orders-db/${START}/manifest.json`]);
    const m = await metricsText(h.app);
    expect(metric(m, 'evidence_collections_total', { target: 'orders-db', result: 'failed' })).toBe(1);
    expect(metric(m, 'evidence_collections_total', { target: 'hot-redis', result: 'failed' })).toBe(1);

    for (const [target, kind] of [
      ['orders-db', 'postgres'],
      ['hot-redis', 'redis'],
    ] as const) {
      const key = `evidence-collector/${target}/${START}/manifest.json`;
      const man = h.store.json(key) as Manifest;
      expect(man.target).toBe(target);
      expect(man.kind).toBe(kind);
      expect(man.collectedAt).toBe(START);
      expect(man.files.filter((f) => f !== 'manifest.json')).toEqual([]);
      // 뜨지 못한 것의 오류는 종류 이름(code)만 싣는다. 오류 글(주소·비밀번호가 섞인다)은 싣지 않는다
      expect(man.errors.length).toBeGreaterThanOrEqual(1);
      for (const e of man.errors) {
        expect(Object.keys(e).filter((k) => k !== 'file' && k !== 'code')).toEqual([]);
        expect(e.code).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
      }
      const raw = h.store.text(key);
      expect(raw).not.toContain('127.0.0.1');
      expect(raw).not.toContain(DB_PASSWORD);
      expect(raw).not.toContain(REDIS_PASSWORD);
    }
    // manifest의 경보 칸은 지문·이름·severity·kind·dependency뿐이다(경보 설명 글 등 다른 칸 없음)
    expect((h.store.json(`evidence-collector/orders-db/${START}/manifest.json`) as Manifest).alerts).toContainEqual({
      fingerprint: 'fp-dead-orders',
      alertname: 'DependencySaturated',
      severity: 'sev2',
      kind: 'cause',
      dependency: 'orders-db',
    });

    // 수집마다 정보 로그 한 줄(kind evidence, 대상·결과)
    const evidence = h.logs.lines().filter((l) => l.kind === 'evidence');
    expect(evidence).toHaveLength(2);
    for (const target of ['orders-db', 'hot-redis']) {
      const line = evidence.find((l) => Object.values(l).includes(target));
      expect(line, `${target} 수집 로그 줄`).toBeDefined();
      expect(Object.values(line!)).toContain('failed');
    }
    const logText = h.logs.text();
    expect(logText).not.toContain(DB_PASSWORD);
    expect(logText).not.toContain(REDIS_PASSWORD);

    // 환경 값: 모두 있으면 시작한다(아래 실패가 다른 까닭이 아니다)
    const base = envFor([['orders-db', 'postgres', DEAD_PG], ['hot-redis', 'redis', DEAD_REDIS]]);
    const ok = await buildEvidenceCollector({ env: base, store: new MemoryBytesStore(), logDestination: logSink().stream });
    open.push(ok);

    const without = (name: string) => Object.fromEntries(Object.entries(base).filter(([k]) => k !== name));
    const targets = (list: unknown) => ({ ...base, PEAKET_EVIDENCE_TARGETS: JSON.stringify(list) });
    const broken: Array<[string, Record<string, string>]> = [
      ['토큰 없음', without('PEAKET_EVIDENCE_WEBHOOK_TOKEN')],
      ['토큰 빈 값', { ...base, PEAKET_EVIDENCE_WEBHOOK_TOKEN: '' }],
      ['대상 목록 없음', without('PEAKET_EVIDENCE_TARGETS')],
      ['대상 목록이 빔', targets([])],
      ['대상 목록이 JSON이 아님', { ...base, PEAKET_EVIDENCE_TARGETS: 'orders-db=postgres' }],
      ['접속 주소 환경 값 없음', without('EV_TARGET_0_URL')],
      ['접속 주소 빈 값', { ...base, EV_TARGET_1_URL: '' }],
      [
        '이름이 겹침',
        targets([
          { name: 'orders-db', kind: 'postgres', urlEnv: 'EV_TARGET_0_URL' },
          { name: 'orders-db', kind: 'redis', urlEnv: 'EV_TARGET_1_URL' },
        ]),
      ],
      ['이름 꼴이 틀림', targets([{ name: 'Orders_DB', kind: 'postgres', urlEnv: 'EV_TARGET_0_URL' }])],
      ['모르는 종류', targets([{ name: 'orders-db', kind: 'mysql', urlEnv: 'EV_TARGET_0_URL' }])],
    ];
    for (const [why, env] of broken) {
      await expect(buildEvidenceCollector({ env, store: new MemoryBytesStore(), logDestination: logSink().stream }), why).rejects.toThrow();
    }
  });
});
