// 파트너 콘솔 앱 서버의 계측 진입점(instrumentation.ts register)이 텔레메트리를 앱 서버 모드로 시작하는지(V-T31 ②, BUILD_ORDER HOT-400).
// 정본: docs/observability.md §6 '신뢰 경계의 추적 문맥'(같은 출처 앱 서버는 PEAKET_TRACE_INBOUND=untrusted, 브라우저 traceparent는 링크로만)과
// 묶음 BAT-055 계획 §5 '앱 서버 계측'(Node 실행기에서만 시작, untrusted가 아닌 값이 적혀 있으면 던짐, 빌드 작업자·개발 서버는 건너뜀).
// OTel 전역 상태는 프로세스마다 하나라 경우마다 새 프로세스에서 register()를 부른다. 시작했는지는 전역 전파기로 본다:
// 시작하면 전파기가 traceparent 칸을 갖고, 앱 서버 모드는 받은 traceparent를 부모로 꺼내지 않는다(메시 모드는 꺼낸다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ENTRY = new URL('./instrumentation.ts', import.meta.url).href;
// @opentelemetry/api는 platform 패키지의 것을 읽는다(전역 상태는 같은 주 판끼리 하나다)
const PLATFORM_PKG = fileURLToPath(new URL('../../packages/platform/package.json', import.meta.url));
const CHILD = `
import { createRequire } from 'node:module';
const out = { error: null };
try {
  const m = await import(${JSON.stringify(ENTRY)});
  await m.register();
} catch (e) { out.error = String(e?.message ?? e); }
const api = createRequire(${JSON.stringify(PLATFORM_PKG)})('@opentelemetry/api');
out.fields = api.propagation.fields();
const ctx = api.propagation.extract(api.ROOT_CONTEXT, { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' });
out.parent = api.trace.getSpanContext(ctx)?.traceId ?? null;
console.log('@@' + JSON.stringify(out));
process.exit(0);
`;

/** 운영 서버(next start, Node 실행기)의 환경 */
const PROD = { NEXT_RUNTIME: 'nodejs', NODE_ENV: 'production', NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64'), OTEL_TRACES_EXPORTER: 'none' };

function run(env) {
  const base = { ...process.env };
  for (const k of ['NEXT_RUNTIME', 'NODE_ENV', 'NEXT_PHASE', 'PEAKET_TRACE_INBOUND', 'OTEL_SERVICE_NAME', 'NODE_OPTIONS']) delete base[k];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000 });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `자식 프로세스가 결과를 내지 않았다: ${r.stderr}`);
  return JSON.parse(line.slice(2));
}
const started = (o) => o.fields.includes('traceparent');

test('V-T31 ② partner 계측은 운영 Node 서버에서 텔레메트리를 앱 서버 모드(untrusted)로 시작한다(PEAKET_TRACE_INBOUND 없음)', () => {
  const o = run(PROD);
  assert.equal(o.error, null);
  assert.ok(started(o), `텔레메트리를 시작하지 않았다: ${JSON.stringify(o)}`);
  assert.equal(o.parent, null, '받은 traceparent를 부모로 꺼낸다(메시 모드)');
});

test('V-T31 ② partner 계측은 PEAKET_TRACE_INBOUND=untrusted면 앱 서버 모드로 시작한다', () => {
  const o = run({ ...PROD, PEAKET_TRACE_INBOUND: 'untrusted' });
  assert.equal(o.error, null);
  assert.ok(started(o));
  assert.equal(o.parent, null);
});

test('V-T31 ② partner 계측은 PEAKET_TRACE_INBOUND가 untrusted가 아닌 값(mesh·none)이면 시작하지 않고 던진다', () => {
  for (const v of ['mesh', 'none']) {
    const o = run({ ...PROD, PEAKET_TRACE_INBOUND: v });
    assert.match(o.error ?? '', /PEAKET_TRACE_INBOUND/, `${v}: 던지지 않았다`);
    assert.equal(started(o), false, `${v}: 텔레메트리를 시작했다`);
  }
});

test('V-T31 ② partner 계측은 빌드 작업자·개발 서버·Edge 실행기에서는 텔레메트리를 시작하지 않는다', () => {
  for (const env of [
    { ...PROD, NEXT_PHASE: 'phase-production-build' },
    { ...PROD, NODE_ENV: 'development' },
    { ...PROD, NEXT_RUNTIME: 'edge' },
  ]) {
    const o = run(env);
    assert.equal(o.error, null, JSON.stringify(env));
    assert.equal(started(o), false, JSON.stringify(env));
  }
});
