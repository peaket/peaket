// 지표 이름·라벨 규칙(docs/features/control-tower.md C-T76 ①②③, ADR-0334 결정 6, docs/observability.md §8 '메트릭 카디널리티 규칙', NFR-011, ADR-0077).
// - 금지 라벨 이름과 맞추는 법은 정본(ADR-0334 결정 6)의 목록과 문장(소문자로 바꾸고 `_`·`-`를 뺀 뒤 견준다, `token`·`ip`로 끝나는 이름도 금지)을 그대로 적는다.
// - 허용 라벨은 docs/observability.md §8 '허용 라벨' 목록이다.
// - ①②는 공용 서버 패키지가 등록하는 지표 전부(서비스 뼈대 + 공용 지표 묶음)를 실제 레지스트리에서 읽고, 서비스 아홉은 원본에 적힌 지표 선언을 읽는다.
//   서비스가 띄울 때 등록하는 지표 전부는 ③의 시작 검사(listen)가 본다.
import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller, Get, Module } from '@nestjs/common';
import { Registry } from '@prometheus-io/client';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CircuitBreakerMetrics,
  ControlSyncMetrics,
  Counter,
  Gauge,
  Histogram,
  HotPathMetrics,
  KeyedConsumerMetrics,
  OutboxRelayMetrics,
  PlatformConfigError,
  Roles,
  createService,
  fakeClock,
  invRefKeyInfoGauge,
  isForbiddenMetricLabel,
  maintenanceMetrics,
  telemetryDroppedCounter,
  validateMetricRegistry,
  type PlatformService,
} from '../src/index.js';
import { collector } from './fixture.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVICE = 'rules-svc';
const LOG_KEY = Buffer.alloc(32, 9).toString('base64');

/** ADR-0334 결정 6: docs/observability.md §8 '사용 금지 라벨'을 이름으로 옮긴 것 */
const FORBIDDEN = ['accountid', 'userid', 'pid', 'sid', 'sessionid', 'ci', 'token', 'queueseq', 'seq', 'seatid', 'ip', 'clientip', 'useragent', 'ua', 'orderid'];
const FORBIDDEN_SUFFIXES = ['token', 'ip'];
/** 정본 문장 그대로의 판정(소문자, `_`·`-` 뺌, 목록 또는 꼬리) */
const forbiddenByCanon = (label: string) => {
  const n = label.toLowerCase().replace(/[_-]/g, '');
  return FORBIDDEN.includes(n) || FORBIDDEN_SUFFIXES.some((s) => n.endsWith(s));
};
/** docs/observability.md §8 '허용 라벨' */
const ALLOWED = ['service', 'route', 'method', 'status_class', 'event_id', 'pod', 'az', 'dependency', 'tier', 'stage', 'outcome'];
/** Prometheus 이름 규칙(ADR-0334 결정 6) */
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** 업무 서비스 전부(docs/architecture.md §3.1). 정본 C-T76의 '서비스 아홉'보다 넓게 core-svc까지 읽는다 */
const SERVICES = ['queue-svc', 'admission-ctrl', 'purchase-svc', 'payment-svc', 'ticket-svc', 'realtime-gw', 'identity-svc', 'trust-svc', 'ops-svc', 'core-svc'];

@Controller('v1/rules')
class OpenController {
  @Get('ping')
  @Roles(['public'])
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [OpenController] })
class RulesModule {}

const started: PlatformService[] = [];
afterEach(async () => {
  while (started.length) await started.pop()!.close();
});

async function boot(env: Record<string, string> = { PEAKET_ENV: 'ci' }) {
  const svc = await createService({
    name: SERVICE,
    module: RulesModule,
    env: { PEAKET_LOG_SAMPLE_ONE_IN: '1', PEAKET_LOG_PSEUDONYM_KEY: LOG_KEY, PORT: '0', PEAKET_MANAGEMENT_PORT: '0', ...env },
    clock: fakeClock(),
    logDestination: collector().stream,
  });
  started.push(svc);
  return svc;
}

/** 공용 서버 패키지가 서비스 레지스트리에 거는 지표 묶음을 모두 건다(서비스 뼈대가 이미 건 것에 더해) */
function registerPlatformMetrics(registry: Registry) {
  new ControlSyncMetrics(registry, SERVICE);
  new HotPathMetrics(SERVICE).register(registry);
  CircuitBreakerMetrics.for(registry);
  KeyedConsumerMetrics.for(registry, SERVICE);
  maintenanceMetrics(registry, SERVICE);
  new OutboxRelayMetrics(registry, SERVICE);
  telemetryDroppedCounter(registry);
  invRefKeyInfoGauge(registry, SERVICE);
}

/** 레지스트리의 지표마다 이름·종류·라벨 이름(지표 객체의 labelNames) */
function metricsOf(registry: Registry) {
  return registry.getMetricsAsArray().map((m) => {
    const labelNames: unknown = Reflect.get(m, 'labelNames');
    return { name: String(m.name), type: String(m.type), labels: Array.isArray(labelNames) ? labelNames.map(String) : [] };
  });
}

/** services/<이름>/src 아래 .ts 파일 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('C-T76 ① 라벨 이름', () => {
  test('C-T76 ① 공용 서버 패키지가 등록하는 지표 전부(서비스 뼈대·제어 토픽·핫패스·차단기·키 단위 소비·유지보수·Outbox 릴레이·텔레메트리·키 정보)의 라벨에 금지 라벨이 없다', async () => {
    const svc = await boot();
    registerPlatformMetrics(svc.metrics.registry);
    const all = metricsOf(svc.metrics.registry);
    // 빈 결과가 통과로 새지 않게: 묶음마다 대표 지표가 실제로 들었다
    for (const name of ['http_server_request_duration_seconds', 'control_sync_skipped_total', 'outbox_relay_published_total', 'circuit_breaker_state']) {
      expect(all.map((m) => m.name), name).toContain(name);
    }
    expect(all.length).toBeGreaterThanOrEqual(30);
    const labels = [...new Set(all.flatMap((m) => m.labels))].sort();
    expect(labels.length).toBeGreaterThan(5);
    expect(labels.filter(forbiddenByCanon)).toEqual([]);
    expect(validateMetricRegistry(svc.metrics.registry)).toEqual([]);
  });

  test('C-T76 ① 서비스 아홉과 core-svc의 원본에 적힌 지표 라벨 이름(labelNames)에 금지 라벨이 없다', () => {
    const found: { file: string; label: string }[] = [];
    let declared = 0;
    for (const s of SERVICES) {
      for (const file of sourceFiles(join(ROOT, 'services', s, 'src'))) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/labelNames:\s*\[([^\]]*)\]/g)) {
          declared += 1;
          for (const l of m[1]!.matchAll(/['"]([^'"]+)['"]/g)) found.push({ file: relative(ROOT, file), label: l[1]! });
        }
      }
    }
    expect(declared).toBeGreaterThanOrEqual(50);
    expect(found.filter((f) => forbiddenByCanon(f.label))).toEqual([]);
  });

  test('C-T76 ① 정본 금지 이름은 철자 꼴(대소문자·밑줄·붙임표)과 관계없이 모두 금지이고, token·ip로 끝나는 이름도 금지이며, 허용 라벨은 통과한다', () => {
    const spelled = [
      'account_id', 'accountId', 'ACCOUNT-ID', 'user_id', 'userId', 'pid', 'PID', 'sid', 'session_id', 'sessionId', 'ci', 'CI', 'token', 'queue_seq', 'queueSeq', 'seq', 'seat_id', 'seatId',
      'ip', 'IP', 'client_ip', 'clientIp', 'client-ip', 'user_agent', 'userAgent', 'user-agent', 'ua', 'UA', 'order_id', 'orderId', 'order-id',
      // 꼬리 규칙
      'refresh_token', 'accessToken', 'session-token', 'remote_ip', 'forwardedIp', 'x_real_ip',
    ];
    for (const label of spelled) expect(isForbiddenMetricLabel(label), label).toBe(true);
    for (const label of ALLOWED) expect(isForbiddenMetricLabel(label), label).toBe(false);
  });

  test('C-T76 ① 금지 라벨을 단 지표는 이름마다 하나씩 금지 라벨로 걸리고, 허용 라벨만 단 지표는 걸리지 않는다', () => {
    const asLabel = ['account_id', 'user_id', 'pid', 'sid', 'session_id', 'ci', 'token', 'queue_seq', 'seq', 'seat_id', 'ip', 'client_ip', 'clientIp', 'user_agent', 'ua', 'order_id', 'refresh_token', 'remote_ip'];
    for (const label of asLabel) {
      const registry = new Registry();
      new Counter({ name: 'demo_lookups_total', help: 'h', labelNames: ['route', label], registers: [registry] });
      expect(validateMetricRegistry(registry), label).toEqual([{ metric: 'demo_lookups_total', label, rule: 'forbidden-label' }]);
    }
    const ok = new Registry();
    new Counter({ name: 'demo_lookups_total', help: 'h', labelNames: ALLOWED, registers: [ok] });
    new Gauge({ name: 'demo_depth', help: 'h', labelNames: ['service', 'event_id'], registers: [ok] });
    expect(validateMetricRegistry(ok)).toEqual([]);
  });
});

describe('C-T76 ② 지표 이름', () => {
  test('C-T76 ② 공용 서버 패키지가 등록하는 지표 전부의 이름이 Prometheus 이름 규칙을 따르고 Counter는 _total로 끝난다', async () => {
    const svc = await boot();
    registerPlatformMetrics(svc.metrics.registry);
    const all = metricsOf(svc.metrics.registry);
    expect(all.filter((m) => m.type === 'counter').length).toBeGreaterThanOrEqual(10);
    expect(all.filter((m) => !METRIC_NAME.test(m.name)).map((m) => m.name)).toEqual([]);
    expect(all.filter((m) => m.labels.some((l) => !LABEL_NAME.test(l))).map((m) => m.name)).toEqual([]);
    expect(all.filter((m) => m.type === 'counter' && !m.name.endsWith('_total')).map((m) => m.name)).toEqual([]);
  });

  test('C-T76 ② 서비스 아홉과 core-svc의 원본에 적힌 Counter 이름은 _total로 끝나고 이름 규칙을 따른다', () => {
    const counters: { file: string; name: string }[] = [];
    for (const s of SERVICES) {
      for (const file of sourceFiles(join(ROOT, 'services', s, 'src'))) {
        for (const m of readFileSync(file, 'utf8').matchAll(/new Counter(?:<[^>]*>)?\(\{\s*name:\s*['"]([^'"]+)['"]/g)) counters.push({ file: relative(ROOT, file), name: m[1]! });
      }
    }
    expect(counters.length).toBeGreaterThanOrEqual(20);
    expect(counters.filter((c) => !c.name.endsWith('_total') || !METRIC_NAME.test(c.name))).toEqual([]);
  });

  test('C-T76 ② _total로 끝나지 않는 Counter는 걸리고, Gauge·Histogram은 _total 없이도 걸리지 않는다', () => {
    const registry = new Registry();
    new Counter({ name: 'demo_lookups', help: 'h', labelNames: ['route'], registers: [registry] });
    new Gauge({ name: 'demo_depth', help: 'h', registers: [registry] });
    new Histogram({ name: 'demo_wait_seconds', help: 'h', buckets: [0.1, 1], registers: [registry] });
    new Counter({ name: 'demo_hits_total', help: 'h', registers: [registry] });
    expect(validateMetricRegistry(registry)).toEqual([{ metric: 'demo_lookups', rule: 'counter-total' }]);
  });
});

describe('C-T76 ③ 시작 검사(listen)', () => {
  test('C-T76 ③ 금지 라벨 지표와 _total 없는 Counter를 일부러 더한 서비스는 환경과 관계없이(ci·local·demo·staging·prod) listen에서 PlatformConfigError로 실패하고, 오류가 그 지표 이름과 라벨을 모두 들며 두 포트 모두 듣지 않는다', async () => {
    for (const env of ['ci', 'local', 'demo', 'staging', 'prod']) {
      const svc = await boot({ PEAKET_ENV: env });
      new Counter({ name: 'demo_lookups_total', help: 'h', labelNames: ['route', 'account_id'], registers: [svc.metrics.registry] });
      new Gauge({ name: 'demo_clients', help: 'h', labelNames: ['clientIp'], registers: [svc.metrics.registry] });
      new Counter({ name: 'demo_misses', help: 'h', registers: [svc.metrics.registry] });
      const listening = svc.listen('127.0.0.1');
      await expect(listening, env).rejects.toThrow(PlatformConfigError);
      const message = await listening.then(
        () => '',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      for (const part of ['demo_lookups_total', 'account_id', 'demo_clients', 'clientIp', 'demo_misses']) expect(message, `${env}: ${part}`).toContain(part);
      expect(message, env).not.toContain('demo_lookups_total의 라벨 route');
      expect(svc.http.server.listening, env).toBe(false);
      expect(svc.management.server.listening, env).toBe(false);
    }
  });

  test('C-T76 ③ 등록된 지표가 하나도 없으면 규칙을 볼 수 없어 listen이 PlatformConfigError로 실패한다', async () => {
    const svc = await boot();
    svc.metrics.registry.clear();
    await expect(svc.listen('127.0.0.1')).rejects.toThrow(PlatformConfigError);
    expect(svc.http.server.listening).toBe(false);
  });

  test('C-T76 ③ 규칙을 지킨 지표만 더한 서비스는 listen이 두 포트를 연다', async () => {
    const svc = await boot({ PEAKET_ENV: 'staging' });
    registerPlatformMetrics(svc.metrics.registry);
    new Counter({ name: 'demo_lookups_total', help: 'h', labelNames: ['route', 'event_id'], registers: [svc.metrics.registry] });
    // real-time: listen이 규칙 검사를 지나 실제로 듣는지는 포트를 열어야 보인다(빈 포트 0, 127.0.0.1) BAT-215
    await svc.listen('127.0.0.1');
    expect(svc.http.server.listening).toBe(true);
    expect(svc.management.server.listening).toBe(true);
  });
});
