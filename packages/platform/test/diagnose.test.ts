// 진단 수집(RB-31, ADR-0070 결정 1 '수동' 1~6, docs/devops.md D-T18 ①, docs/infra.md RB-31, BUILD_ORDER BAS-080, ADR-0303 결정 3).
// 실제 파일(임시 폴더)과 가짜 저장소·힙·기다리기로 차례와 경계를 본다. 실제 kind·moto S3에서 끝까지 보는 것은 tools/local/e2e/diagnose.e2e.mjs다.
// 기다리기는 주입한 sleep이 받은 값으로 본다(구현 보고 판정 4): 준비를 내린 뒤 40,000ms [가정](준비 프로브 5초 × (6회 + 1) + 퍼짐 여유 5초,
// 리뷰 RV-01·SEC-07 ①로 30초에서 고침, ADR-0303 결정 3), 마감 10,000ms [가정].
import 'reflect-metadata';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DIAGNOSE_DEFAULTS,
  DIAGNOSE_HANDLED_FILE,
  PlatformConfigError,
  PlatformMetrics,
  Readiness,
  createService,
  diagnoseConfigFromEnv,
  fakeClock,
  startDiagnose,
  type EvidenceStore,
  type StartDiagnoseOptions,
} from '../src/index.js';
import { collector, sample } from './fixture.js';

const AT = '2026-11-19T01:02:03Z';
const MB = 1024 * 1024;
const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const until = async (what: string, cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`기다림 한도: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/** Downward API 파일 꼴(줄마다 key="value") */
const annotationText = (value: string) => `kubernetes.io/config.seen="2026-11-19T00:00:00Z"\npeaket.io/diagnose=${JSON.stringify(value)}\n`;

function stage() {
  const root = mkdtempSync(join(tmpdir(), 'peaket-diag-'));
  dirs.push(root);
  const diagDir = join(root, 'diag');
  const annotationsFile = join(root, 'annotations');
  mkdirSync(diagDir, { recursive: true });
  return { root, diagDir, annotationsFile, annotate: (v: string) => writeFileSync(annotationsFile, annotationText(v)) };
}

/** 올린 파일의 이름·내용을 모으는 저장소. failOn이 이름에 든 파일은 실패한다 */
function memoryStore(failOn?: RegExp) {
  const puts: { key: string; file: string; body: string }[] = [];
  const store: EvidenceStore = {
    async put(key, file) {
      if (failOn?.test(file)) throw new Error('S3 503');
      puts.push({ key, file, body: readFileSync(file, 'utf8') });
    },
  };
  return { store, puts };
}

function logs() {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const at = (level: string) => (obj: unknown, msg?: string) => void lines.push({ level, obj: (obj ?? {}) as Record<string, unknown>, msg: msg ?? '' });
  return { lines, logger: { info: at('info'), warn: at('warn'), error: at('error') } as unknown as StartDiagnoseOptions['logger'] };
}

/** 기다리기를 손으로 푼다: 받은 ms를 차례로 적는다 */
function manualSleep(events: string[]) {
  const pending: { ms: number; resolve: () => void }[] = [];
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      events.push(`sleep:${ms}`);
      pending.push({ ms, resolve });
    });
  return { sleep, pending };
}

function boot(o: Partial<StartDiagnoseOptions> & { diagDir: string; annotationsFile: string; store: EvidenceStore }) {
  const readiness = new Readiness();
  const metrics = new PlatformMetrics('example-svc');
  const exits = { n: 0 };
  const l = logs();
  const d = startDiagnose({
    service: 'example-svc',
    pod: 'p-1',
    readiness,
    clock: fakeClock({ now: Date.parse('2026-11-19T02:00:00Z') }),
    exit: () => void exits.n++,
    pollMs: 10,
    logger: l.logger,
    metrics,
    heap: { used: () => 100 * MB, rss: () => 200 * MB, snapshot: async (f) => writeFileSync(f, '{"snapshot":{}}') },
    sleep: async () => {},
    ...o,
  });
  stops.push(() => d.stop());
  return { readiness, metrics, exits, logs: l.lines, d };
}
const results = async (m: PlatformMetrics, result: string) => sample(await m.registry.metrics(), 'diagnose_collections_total', { service: 'example-svc', result });

describe('D-T18 ① 진단 수집 차례(RB-31)', () => {
  test('D-T18 ①_기본값은_읽기5000ms·준비내린뒤40000ms·마감10000ms다(RV-01)', () => {
    // 준비 프로브 주기 5초 × (연속 실패 6회 + 첫 실패까지 한 주기) + 끝점 퍼짐 여유 5초 = 40초 [가정]. 30초면 여유가 0이다
    expect(DIAGNOSE_DEFAULTS).toEqual({ pollMs: 5_000, unreadyWaitMs: 40_000, drainMs: 10_000 });
    expect(DIAGNOSE_DEFAULTS.unreadyWaitMs).toBeGreaterThanOrEqual(5_000 * (6 + 1) + 5_000);
  });

  test('D-T18 ①_heap요청은_준비내림·새일멈춤→40000ms기다림→마감→보고서→스냅샷→올리기→지우기→끝내기한번_차례다', async () => {
    const s = stage();
    const events: string[] = [];
    const sl = manualSleep(events);
    const { store, puts } = memoryStore();
    let readyAtWait: string | undefined;
    const { readiness, exits } = boot({
      ...s,
      store: { put: async (k, f) => (events.push(`put:${f.includes('heap') ? 'heap' : 'report'}`), store.put(k, f)) },
      memoryLimitBytes: 1024 * MB,
      sleep: (ms) => {
        if (ms === 40_000) readyAtWait = readiness.status();
        return sl.sleep(ms);
      },
      onStopWork: async () => void events.push('stopWork'),
      report: (f) => (events.push('report'), writeFileSync(f, '{"header":{}}')),
      heap: { used: () => 100 * MB, rss: () => 200 * MB, snapshot: async (f) => (events.push('snapshot'), writeFileSync(f, '{}')) },
      exit: () => (events.push(`exit:${readdirSync(s.diagDir).filter((n) => !n.startsWith('.')).length}`), void exits.n++),
    });
    await settle(50);
    expect(readiness.status()).toBe('ready');
    s.annotate(`heap@${AT}`);
    await until('준비 내림', () => sl.pending.length === 1);
    expect(readyAtWait).toBe('diagnosing');
    expect(readiness.pending()).toEqual(['diagnosing']);
    // 기다리는 동안(39,999ms까지)은 보고서를 쓰지 않는다
    expect(events).toEqual(['stopWork', 'sleep:40000']);
    await settle(50);
    expect(events).toEqual(['stopWork', 'sleep:40000']);
    sl.pending[0]!.resolve();
    await until('마감 기다림', () => sl.pending.length === 2);
    expect(sl.pending[1]!.ms).toBe(10_000);
    await until('끝내기', () => exits.n === 1);
    expect(events).toEqual(['stopWork', 'sleep:40000', 'sleep:10000', 'report', 'snapshot', 'put:report', 'put:heap', 'exit:0']);
    expect(puts).toHaveLength(2);
    await settle(100);
    expect(exits.n).toBe(1);
  });

  test('D-T18 ①_마감은_진행중일이먼저끝나면기다리지않고_끝나지않으면10000ms에서끊는다', async () => {
    const s = stage();
    const events: string[] = [];
    const sl = manualSleep(events);
    const { store } = memoryStore();
    let finishWork!: () => void;
    const { exits } = boot({ ...s, store, sleep: sl.sleep, onStopWork: () => new Promise<void>((r) => (finishWork = r)) });
    s.annotate(`report@${AT}`);
    await until('준비 내림', () => sl.pending.length === 1);
    sl.pending[0]!.resolve();
    await until('마감', () => sl.pending.length === 2);
    await settle(50);
    // 진행 중 일도 마감도 끝나지 않았으면 보고서로 가지 않는다
    expect(exits.n).toBe(0);
    finishWork();
    await until('끝내기', () => exits.n === 1);
  });

  test('D-T18 ①_report요청도_준비를내린뒤40000ms를기다린다음에야_보고서를쓰고끝낸다(RV-01, Service에서빠질여유)', async () => {
    const s = stage();
    const events: string[] = [];
    const sl = manualSleep(events);
    const { store } = memoryStore();
    const { exits, readiness } = boot({
      ...s,
      store: { put: async (k, f) => (events.push('put'), store.put(k, f)) },
      sleep: sl.sleep,
      report: (f) => (events.push('report'), writeFileSync(f, '{"header":{}}')),
      exit: () => (events.push('exit'), void exits.n++),
    });
    s.annotate(`report@${AT}`);
    await until('준비 내림', () => sl.pending.length === 1);
    expect(readiness.pending()).toEqual(['diagnosing']);
    expect(events).toEqual(['sleep:40000']);
    sl.pending[0]!.resolve();
    await until('마감 기다림', () => sl.pending.length === 2);
    sl.pending[1]!.resolve();
    await until('끝내기', () => exits.n === 1);
    expect(events).toEqual(['sleep:40000', 'sleep:10000', 'report', 'put', 'exit']);
  });
});

describe('D-T18 ① 힙 스냅샷 메모리 경계', () => {
  const cases: [string, number | undefined, boolean, string][] = [
    // 한도 1000MB, RSS 400MB → 여유 600MB. 힙 300MB면 정확히 2배(건너뜀), 여유가 2배 + 1바이트면 뜬다
    ['여유가정확히2배', 1000 * MB, false, 'heap_skipped_low_memory'],
    ['여유가2배더하기1바이트', 1000 * MB + 1, true, 'heap'],
    ['한도값없음', undefined, false, 'heap_skipped_no_limit'],
  ];
  for (const [name, limit, snapshot, result] of cases) {
    test(`D-T18 ①_${name}이면_스냅샷${snapshot ? '을뜬다' : '없이보고서만올리고_건너뛴까닭을로그·지표에남긴다'}`, async () => {
      const s = stage();
      const { store, puts } = memoryStore();
      const { exits, metrics, logs: lines } = boot({
        ...s,
        store,
        ...(limit === undefined ? {} : { memoryLimitBytes: limit }),
        heap: { used: () => 300 * MB, rss: () => 400 * MB, snapshot: async (f) => writeFileSync(f, '{}') },
        report: (f) => writeFileSync(f, '{"header":{}}'),
      });
      s.annotate(`heap@${AT}`);
      await until('끝내기', () => exits.n === 1);
      expect(puts.map((p) => p.key.split('/').at(-1)!.split('-')[0])).toEqual(snapshot ? ['report', 'heap'] : ['report']);
      expect(await results(metrics, result)).toBe(1);
      expect(await results(metrics, 'report')).toBe(1);
      if (!snapshot) {
        expect(lines.some((l) => l.level === 'warn' && l.obj.reason === (limit === undefined ? 'no-memory-limit' : 'low-memory'))).toBe(true);
        expect(await results(metrics, 'heap')).toBeUndefined();
      }
    });
  }
});

describe('D-T18 ① 되풀이와 틀린 값', () => {
  test('D-T18 ①_처리한값으로다시뜨면_아무것도하지않고_다른시각의새값은한번더수집한다', async () => {
    const s = stage();
    const { store, puts } = memoryStore();
    s.annotate(`report@${AT}`);
    const first = boot({ ...s, store });
    await until('첫 수집', () => first.exits.n === 1);
    first.d.stop();
    expect(puts).toHaveLength(1);
    // 다시 뜬 프로세스(같은 /diag, 남은 주석)
    const again = boot({ ...s, store });
    await settle(200);
    expect(again.exits.n).toBe(0);
    expect(again.readiness.status()).toBe('ready');
    expect(puts).toHaveLength(1);
    // 운영자가 새 시각으로 다시 단다
    s.annotate('report@2026-11-19T03:00:00Z');
    await until('둘째 수집', () => again.exits.n === 1);
    expect(puts).toHaveLength(2);
    expect(puts[1]!.key).toContain('/2026-11-19T03:00:00Z/');
  });

  test('D-T18 ①_분까지적은시각(ADR-0070보기_heap@2026-11-02T20:10Z)도받아_한번수집하고_객체이름에그시각을쓴다(SEC-05)', async () => {
    const s = stage();
    const { store, puts } = memoryStore();
    const { exits, metrics } = boot({ ...s, store, memoryLimitBytes: 4096 * MB, report: (f) => writeFileSync(f, '{"header":{}}') });
    s.annotate('heap@2026-11-02T20:10Z');
    await until('끝내기', () => exits.n === 1);
    expect(puts.map((p) => p.key.split('/').slice(0, 3).join('/'))).toEqual(['example-svc/p-1/2026-11-02T20:10Z', 'example-svc/p-1/2026-11-02T20:10Z']);
    expect(await results(metrics, 'invalid_request')).toBeUndefined();
  });

  for (const bad of ['heap@어제', 'dump@2026-11-19T01:02:03Z', 'heap@2026-02-30T00:00:00Z', 'heap 2026-11-19T01:02:03Z', 'heap@2026-11-19T01:02:03+09:00']) {
    test(`D-T18 ①_틀린값_${bad}는_경고한번과invalid_request한번만남기고_수집하지않는다(되풀이읽기에도한번)`, async () => {
      const s = stage();
      const { store, puts } = memoryStore();
      s.annotate(bad);
      const { exits, readiness, metrics, logs: lines } = boot({ ...s, store });
      await settle(300);
      expect(exits.n).toBe(0);
      expect(readiness.status()).toBe('ready');
      expect(puts).toHaveLength(0);
      expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1);
      // 런북대로 달았는데 받지 않은 값을 지표로도 본다(SEC-05)
      expect(await results(metrics, 'invalid_request')).toBe(1);
    });
  }
});

describe('D-T18 ① 증거 이름·내용과 지우기', () => {
  test('D-T18 ①_올린객체이름은_서비스/파드/요청시각/파일뿐이고_보고서에환경변수·네트워크칸이없다 [ASVS v5.0.0-14.2.1]', async () => {
    const s = stage();
    const { store, puts } = memoryStore();
    process.env.PEAKET_DIAG_TEST_SECRET = 'should-not-leak-1234';
    try {
      // 보고서는 기본 쓰기(process.report)로 쓴다
      const { exits } = boot({ ...s, store, memoryLimitBytes: 4096 * MB });
      s.annotate(`heap@${AT}`);
      await until('끝내기', () => exits.n === 1, 15_000);
    } finally {
      delete process.env.PEAKET_DIAG_TEST_SECRET;
    }
    expect(puts.length).toBe(2);
    for (const p of puts) {
      const parts = p.key.split('/');
      expect(parts.slice(0, 3)).toEqual(['example-svc', 'p-1', AT]);
      expect(parts).toHaveLength(4);
      expect(parts[3]).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(parts[3]).not.toContain('@');
    }
    const report = JSON.parse(puts.find((p) => p.key.includes('/report'))!.body) as Record<string, unknown> & { header?: Record<string, unknown> };
    expect(report).toHaveProperty('header');
    expect(report).not.toHaveProperty('environmentVariables');
    expect(report.header).not.toHaveProperty('networkInterfaces');
    expect(JSON.stringify(report)).not.toContain('should-not-leak-1234');
  }, 20_000);

  test('D-T18 ①_올리기에실패한파일만남기고_성공한파일은지우며_그래도끝내기한번_다음시작때남은파일을올리고지운다 [ASVS v5.0.0-14.2.2]', async () => {
    const s = stage();
    const failing = memoryStore(/heap/);
    const first = boot({ ...s, store: failing.store, memoryLimitBytes: 4096 * MB, report: (f) => writeFileSync(f, '{"header":{}}') });
    s.annotate(`heap@${AT}`);
    await until('끝내기', () => first.exits.n === 1);
    const left = readdirSync(s.diagDir).filter((n) => !n.startsWith('.'));
    expect(failing.puts.map((p) => p.key.split('/').at(-1)!.split('-')[0])).toEqual(['report']);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^heap/);
    expect(first.logs.some((l) => l.level === 'error')).toBe(true);
    expect(await results(first.metrics, 'upload_failed')).toBe(1);
    first.d.stop();
    await settle(50);
    expect(first.exits.n).toBe(1);

    // 다시 뜬 프로세스는 남은 파일을 올리고 지운다(같은 수집은 되풀이하지 않는다)
    const ok = memoryStore();
    const again = boot({ ...s, store: ok.store });
    await until('남은 파일 올림', () => ok.puts.length === 1);
    await settle(100);
    expect(ok.puts[0]!.key).toMatch(/^example-svc\/p-1\/[^/]+\/heap[^/]*$/);
    expect(readdirSync(s.diagDir).filter((n) => !n.startsWith('.'))).toEqual([]);
    expect(await results(again.metrics, 'leftover_uploaded')).toBe(1);
    expect(again.exits.n).toBe(0);
    expect(existsSync(join(s.diagDir, left[0]!))).toBe(false);
  });

  test('D-T18 ①_시작할때남은보고서도_환경변수·네트워크칸을지운뒤올린다(SEC-02, M23) [ASVS v5.0.0-14.2.1]', async () => {
    const s = stage();
    writeFileSync(
      join(s.diagDir, 'report.20261119.010203.1.001.json'),
      JSON.stringify({ header: { nodejsVersion: 'v24', networkInterfaces: [{ name: 'eth0', address: '10.0.0.7' }] }, environmentVariables: { PEAKET_LOG_PSEUDONYM_KEY: 'leak-me-5678' } }),
    );
    const { store, puts } = memoryStore();
    boot({ ...s, store });
    await until('남은 보고서 올림', () => puts.length === 1);
    const body = JSON.parse(puts[0]!.body) as Record<string, unknown> & { header: Record<string, unknown> };
    expect(body).not.toHaveProperty('environmentVariables');
    expect(body.header).not.toHaveProperty('networkInterfaces');
    expect(puts[0]!.body).not.toContain('leak-me-5678');
    expect(body.header.nodejsVersion).toBe('v24');
  });

  test('D-T18 ①_시작할때남은보고서를읽지못하면_올리지않고경고한다(SEC-02) [ASVS v5.0.0-14.2.1]', async () => {
    const s = stage();
    writeFileSync(join(s.diagDir, 'report.20261119.010203.1.002.json'), '{"environmentVariables":{"SECRET":"cut-off');
    const { store, puts } = memoryStore();
    const { logs: lines } = boot({ ...s, store });
    await settle(200);
    expect(puts).toHaveLength(0);
    expect(lines.some((l) => l.level === 'warn')).toBe(true);
  });

  // --- BAT-080 DG-09: 남은 증거의 객체 키는 파일 이름의 '요청 시각'이다(시작 시각·표시 파일의 처리 시각이 아니다) ---
  // 정본: ADR-0303 결정 3, 계획 BAT-080 B5·12 — <서비스>/<파드>/<요청 시각>/<파일>. 시작 시각을 쓰면 다시 뜰 때마다
  // 같은 증거가 다른 접두사에 쌓인다. 파일 이름의 시각을 읽지 못하면 올리지 않고 leftover_unreadable로 센다.

  test('DG-09 D-T18 ①_남은보고서키는_파일이름의요청시각이고_시작시각(02:00)·표시파일시각(09:09)이아니다', async () => {
    const s = stage();
    // 표시 파일은 '이미 처리한' 다른 요청이다. 남은 파일의 요청 시각과 다르다
    writeFileSync(join(s.diagDir, DIAGNOSE_HANDLED_FILE), 'report@2026-11-19T09:09:09Z');
    writeFileSync(join(s.diagDir, 'report-2026-11-19T01-02-03Z.json'), JSON.stringify({ header: { nodejsVersion: 'v24' } }));
    const { store, puts } = memoryStore();
    boot({ ...s, store }); // clock.now는 2026-11-19T02:00:00Z다
    await until('남은 보고서 올림', () => puts.length === 1);
    expect(puts[0]!.key).toBe('example-svc/p-1/2026-11-19T01:02:03Z/report-2026-11-19T01-02-03Z.json');
    expect(puts[0]!.key).not.toContain('2026-11-19T02:00:00');
    expect(puts[0]!.key).not.toContain('2026-11-19T09:09:09Z');
    // 표시 파일은 그대로 두고, 올린 파일은 지운다. 다음에 떠도 두 번 올리지 않는다
    expect(readFileSync(join(s.diagDir, DIAGNOSE_HANDLED_FILE), 'utf8')).toBe('report@2026-11-19T09:09:09Z');
    await until('올린 파일 지움', () => !existsSync(join(s.diagDir, 'report-2026-11-19T01-02-03Z.json')));
    expect(existsSync(join(s.diagDir, 'report-2026-11-19T01-02-03Z.json'))).toBe(false);
    const first = boot({ ...s, store });
    await settle(200);
    expect(puts).toHaveLength(1);
    expect(first.exits.n).toBe(0);
  });

  test('DG-09 D-T18 ①_Node치명오류보고서이름(report.YYYYMMDD.HHMMSS)의시각을_요청시각으로쓴다', async () => {
    const s = stage();
    writeFileSync(join(s.diagDir, 'report.20261119.010203.1.001.json'), JSON.stringify({ header: {} }));
    const { store, puts } = memoryStore();
    boot({ ...s, store });
    await until('남은 보고서 올림', () => puts.length === 1);
    expect(puts[0]!.key).toBe('example-svc/p-1/2026-11-19T01:02:03Z/report.20261119.010203.1.001.json');
    expect(puts[0]!.key).not.toContain('2026-11-19T02:00:00');
  });

  test('DG-09 D-T18 ①_파일이름에시각이없으면_표시파일의@시각을쓰고_그것도없으면올리지않고leftover_unreadable로센다', async () => {
    // 표시 파일의 @ 시각으로 올린다
    const s = stage();
    writeFileSync(join(s.diagDir, DIAGNOSE_HANDLED_FILE), 'report@2026-11-19T05:06:07Z');
    writeFileSync(join(s.diagDir, 'leftover.bin'), 'saved');
    const withMarker = memoryStore();
    const first = boot({ ...s, store: withMarker.store });
    await until('표시 파일 시각으로 올림', () => withMarker.puts.length === 1);
    expect(withMarker.puts[0]!.key).toBe('example-svc/p-1/2026-11-19T05:06:07Z/leftover.bin');
    await settle(150);
    expect(await results(first.metrics, 'leftover_uploaded')).toBe(1);

    // 둘 다 없으면 올리지 않고 남긴다(이름을 지어내지 않는다)
    const t = stage();
    writeFileSync(join(t.diagDir, 'report.json'), JSON.stringify({ header: {} }));
    const none = memoryStore();
    const second = boot({ ...t, store: none.store });
    await settle(200);
    expect(none.puts).toHaveLength(0);
    expect(await results(second.metrics, 'leftover_unreadable')).toBe(1);
    expect(second.logs.some((l) => l.level === 'warn')).toBe(true);
    expect(existsSync(join(t.diagDir, 'report.json'))).toBe(true);
  });

  test('D-T18 ①_진단을켜면시작하자마자_process.report의excludeEnv·excludeNetwork를켠다(SEC-02, 치명오류보고서도두겹) [ASVS v5.0.0-14.2.1]', async () => {
    const report = process.report as NodeJS.ProcessReport & { excludeEnv?: boolean; excludeNetwork?: boolean };
    const before = { excludeEnv: report.excludeEnv, excludeNetwork: report.excludeNetwork };
    report.excludeEnv = false;
    report.excludeNetwork = false;
    try {
      const s = stage();
      boot({ ...s, store: memoryStore().store });
      await settle(50);
      expect({ excludeEnv: report.excludeEnv, excludeNetwork: report.excludeNetwork }).toEqual({ excludeEnv: true, excludeNetwork: true });
    } finally {
      report.excludeEnv = before.excludeEnv ?? false;
      report.excludeNetwork = before.excludeNetwork ?? false;
    }
  });

  test('D-T18 ①_스냅샷도중죽은뒤같은값으로다시뜨면_수집을되풀이하지않고interrupted로세며_partial은올리지않고지운다(SEC-03)', async () => {
    const s = stage();
    s.annotate(`heap@${AT}`);
    const snapshotFiles: string[] = [];
    const first = boot({
      ...s,
      store: memoryStore().store,
      memoryLimitBytes: 4096 * MB,
      report: (f) => writeFileSync(f, '{"header":{}}'),
      // 스냅샷을 쓰는 도중에 멈춘다(생존 프로브 재시작·OOM으로 죽은 것과 같다)
      heap: { used: () => 100 * MB, rss: () => 200 * MB, snapshot: (f) => (snapshotFiles.push(f), writeFileSync(f, '{"snapshot":'), new Promise<void>(() => {})) },
    });
    await until('스냅샷 시작', () => snapshotFiles.length === 1);
    first.d.stop();
    // 쓰는 도중의 스냅샷은 끝난 이름이 아니다
    expect(snapshotFiles[0]).toMatch(/\.partial$/);
    expect(first.exits.n).toBe(0);

    const ok = memoryStore();
    const events: string[] = [];
    const again = boot({ ...s, store: ok.store, memoryLimitBytes: 4096 * MB, sleep: async (ms) => void events.push(`sleep:${ms}`) });
    await settle(300);
    expect(events).toEqual([]);
    expect(again.exits.n).toBe(0);
    expect(again.readiness.status()).toBe('ready');
    expect(await results(again.metrics, 'interrupted')).toBe(1);
    expect(ok.puts.filter((p) => /partial|heapsnapshot/.test(p.key))).toEqual([]);
    expect(readdirSync(s.diagDir).filter((n) => n.endsWith('.partial'))).toEqual([]);
  });

  test('D-T18 ①_끝까지쓴스냅샷만_heapsnapshot이름으로올린다(SEC-03)', async () => {
    const s = stage();
    const { store, puts } = memoryStore();
    const written: string[] = [];
    const { exits } = boot({ ...s, store, memoryLimitBytes: 4096 * MB, report: (f) => writeFileSync(f, '{"header":{}}'), heap: { used: () => 100 * MB, rss: () => 200 * MB, snapshot: async (f) => (written.push(f), writeFileSync(f, '{}')) } });
    s.annotate(`heap@${AT}`);
    await until('끝내기', () => exits.n === 1);
    expect(written[0]).toMatch(/\.partial$/);
    const heapKeys = puts.map((p) => p.key).filter((k) => k.includes('heap'));
    expect(heapKeys).toHaveLength(1);
    expect(heapKeys[0]).toMatch(/\.heapsnapshot$/);
  });
});

describe('BAS-080 증거 저장소 설정이 없을 때(ADR-0303 결정 3, 구현 보고 판정 1)', () => {
  @Module({})
  class EmptyModule {}
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  async function boot2(env: Record<string, string>) {
    const out = collector();
    const exits = { n: 0 };
    const svc = await createService({
      name: 'example-svc',
      module: EmptyModule,
      env,
      clock: fakeClock(),
      logDestination: out.stream,
      sigtermReadiness: false,
      diagnose: { pollMs: 10, sleep: async () => {}, exit: () => void exits.n++, report: (f) => writeFileSync(f, '{}') },
    });
    closers.push(() => svc.close());
    return { svc, out, exits };
  }

  for (const [name, extra] of [
    ['버킷없음', {}],
    ['버킷만있고moto주소없음', { PEAKET_DIAG_BUCKET: 'peaket-diag' }],
  ] as const) {
    for (const peaketEnv of ['local', 'ci']) {
      test(`${peaketEnv}에서_주석파일은있고_${name}이면_경고한줄과함께수집을끄고_시작한다`, async () => {
        const s = stage();
        const { svc, out, exits } = await boot2({ PEAKET_ENV: peaketEnv, PEAKET_DIAG_ANNOTATIONS_FILE: s.annotationsFile, PEAKET_DIAG_DIR: s.diagDir, ...extra });
        s.annotate(`report@${AT}`);
        await settle(200);
        const warns = out.lines.filter((l) => l.level === 'warn' && JSON.stringify(l).includes('PEAKET_DIAG_'));
        expect(warns).toHaveLength(1);
        expect(svc.readiness.status()).toBe('ready');
        expect(exits.n).toBe(0);
      });
    }
  }

  for (const peaketEnv of ['staging', 'prod', 'demo'] as const) {
    test(`${peaketEnv}에서_주석파일은있고_버킷이없으면_빠진이름을대며_시작하지않는다`, () => {
      const env = { PEAKET_DIAG_ANNOTATIONS_FILE: '/etc/podinfo/annotations' };
      expect(() => diagnoseConfigFromEnv(env, peaketEnv)).toThrow(PlatformConfigError);
      expect(() => diagnoseConfigFromEnv(env, peaketEnv)).toThrow(/PEAKET_DIAG_BUCKET/);
      // 버킷이 있으면 moto 주소 없이 켠다(운영은 진짜 S3)
      expect(diagnoseConfigFromEnv({ ...env, PEAKET_DIAG_BUCKET: 'b' }, peaketEnv)).toMatchObject({ bucket: 'b', missing: [] });
    });

    test(`${peaketEnv}에서_흉내S3주소를주면_증거를전용버킷밖으로보내지않게_시작하지않는다(SEC-01)`, () => {
      const env = { PEAKET_DIAG_ANNOTATIONS_FILE: '/etc/podinfo/annotations', PEAKET_DIAG_BUCKET: 'b' };
      for (const endpoint of ['http://aws.peaket-local.svc.cluster.local:5000', 'https://s3.example.net']) {
        expect(() => diagnoseConfigFromEnv({ ...env, PEAKET_DIAG_S3_ENDPOINT: endpoint }, peaketEnv), endpoint).toThrow(PlatformConfigError);
        expect(() => diagnoseConfigFromEnv({ ...env, PEAKET_DIAG_S3_ENDPOINT: endpoint }, peaketEnv), endpoint).toThrow(/PEAKET_DIAG_S3_ENDPOINT/);
      }
    });
  }

  test('staging서비스는_주석파일이있고버킷이없으면_createService가시작실패한다', async () => {
    const s = stage();
    await expect(createService({ name: 'example-svc', module: EmptyModule, env: { PEAKET_ENV: 'staging', PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 1).toString('base64'), PEAKET_DIAG_ANNOTATIONS_FILE: s.annotationsFile }, clock: fakeClock(), logDestination: collector().stream, sigtermReadiness: false })).rejects.toThrow(
      /PEAKET_DIAG_BUCKET/,
    );
  });

  test('주석파일환경값이없으면_local·ci·staging모두_수집하지않고_시작한다', async () => {
    for (const peaketEnv of ['local', 'ci', 'staging'] as const) expect(diagnoseConfigFromEnv({}, peaketEnv), peaketEnv).toBeUndefined();
    for (const peaketEnv of ['local', 'ci']) {
      const { svc, out } = await boot2({ PEAKET_ENV: peaketEnv });
      await settle(50);
      expect(svc.readiness.status()).toBe('ready');
      expect(out.lines.filter((l) => JSON.stringify(l).includes('PEAKET_DIAG_'))).toHaveLength(0);
    }
  });

  test('local에서_버킷과moto주소가있으면_수집을켠다(저장소를S3로만든다)', async () => {
    const s = stage();
    const cfg = diagnoseConfigFromEnv({ PEAKET_DIAG_ANNOTATIONS_FILE: s.annotationsFile, PEAKET_DIAG_DIR: s.diagDir, PEAKET_DIAG_BUCKET: 'peaket-diag', PEAKET_DIAG_S3_ENDPOINT: 'http://127.0.0.1:9' }, 'local');
    expect(cfg).toMatchObject({ annotationsFile: s.annotationsFile, diagDir: s.diagDir, bucket: 'peaket-diag', s3Endpoint: 'http://127.0.0.1:9', missing: [] });
  });
});
