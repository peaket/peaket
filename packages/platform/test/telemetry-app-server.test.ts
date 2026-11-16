// 앱 서버 모드에서 내보내는 span에 주소의 쿼리가 남지 않는다(웨이브 끝 리뷰 W7-SEC-02, docs/observability.md §7 '서버 span', V-T31 ②).
// Next.js 16 서버 span은 옛 이름 속성 http.target에 쿼리까지 싣고, 경로 틀을 못 찾으면 끝날 때 span 이름을 '메서드 req.url'로 바꾼다.
// 나가는 fetch span은 http.url에 전체 주소를 싣는다. 그래서 결제 복귀(/booking/{eventId}/checkout/return)의 결제 키나 본인확인 복귀(/verify/return)의
// 쿼리가 OTLP로 나갈 수 있다. 이 시험은 실제 앱 서버 시작(startAppServerTelemetry)과 실제 OTLP 내보내기를 쓰고, 받은 OTLP 몸통을 풀어 본다.
// 기대 값(쿼리를 뗀 경로, 출처만 남은 주소, '메서드 경로 틀'·'메서드' 이름)은 정본 규칙을 시험에 직접 적는다.
import { createServer } from 'node:http';
import { SpanKind, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startAppServerTelemetry } from '../src/telemetry-app-server.js';

// ---- 작은 protobuf 풀기(OTLP ExportTraceServiceRequest의 필요한 칸만) ----
type Field = { no: number; wire: number; value: bigint | Uint8Array };
function fields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let shift = 0n;
    let r = 0n;
    for (;;) {
      const b = buf[i++]!;
      r |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return r;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const no = key >> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ no, wire, value: varint() });
    else if (wire === 1) {
      out.push({ no, wire, value: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const len = Number(varint());
      out.push({ no, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ no, wire, value: buf.subarray(i, i + 4) });
      i += 4;
    } else throw new Error(`모르는 wire type ${wire}`);
  }
  return out;
}
const sub = (f: Field[], no: number) => f.filter((x) => x.no === no && x.wire === 2).map((x) => x.value as Uint8Array);
const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');
/** AnyValue의 글자 값(string_value = 1) */
const anyString = (b: Uint8Array) => {
  const s = sub(fields(b), 1);
  return s.length ? text(s[0]!) : undefined;
};
type OtlpSpan = { name: string; attributes: Record<string, string | undefined> };
/** ExportTraceServiceRequest → ResourceSpans(1) → ScopeSpans(2) → Span(2): name(5), attributes(9: KeyValue key 1, value 2) */
function decodeSpans(body: Uint8Array): OtlpSpan[] {
  const out: OtlpSpan[] = [];
  for (const rs of sub(fields(body), 1))
    for (const ss of sub(fields(rs), 2))
      for (const sp of sub(fields(ss), 2)) {
        const f = fields(sp);
        const attributes: Record<string, string | undefined> = {};
        for (const kv of sub(f, 9)) {
          const k = fields(kv);
          const key = text(sub(k, 1)[0] ?? new Uint8Array());
          const v = sub(k, 2)[0];
          attributes[key] = v ? anyString(v) : undefined;
        }
        out.push({ name: text(sub(f, 5)[0] ?? new Uint8Array()), attributes });
      }
  return out;
}

const bodies: Uint8Array[] = [];
let server: ReturnType<typeof createServer>;
let telemetry: { shutdown(): Promise<void> };
let spans: OtlpSpan[] = [];
const byCase = (c: string) => {
  const s = spans.find((x) => x.attributes['e2e.case'] === c);
  expect(s, `내보낸 span ${c}이 없다`).toBeDefined();
  return s!;
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      bodies.push(new Uint8Array(Buffer.concat(chunks)));
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  // OTLP 내보내기는 시작할 때 환경 값을 읽는다
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${port}/v1/traces`;
  delete process.env.OTEL_TRACES_EXPORTER;
  telemetry = startAppServerTelemetry({ defaultServiceName: 'web', env: {} });

  const tracer = trace.getTracer('next.js');
  // ① 결제 복귀의 서버 span: 옛 이름 속성 http.target에 쿼리가 실린다
  tracer.startSpan('GET /booking/[eventId]/checkout/return', { kind: SpanKind.SERVER, attributes: { 'e2e.case': 'target', 'http.method': 'GET', 'http.target': '/booking/e1/checkout/return?paymentKey=pk', 'next.route': '/booking/[eventId]/checkout/return' } }).end();
  // ② 끝날 때 원래 주소로 바뀐 이름: 경로 틀(next.route)이 있으면 '메서드 경로 틀'
  const withRoute = tracer.startSpan('GET', { kind: SpanKind.SERVER, attributes: { 'e2e.case': 'renamed-route', 'http.method': 'GET', 'next.route': '/booking/[eventId]/checkout/return' } });
  withRoute.updateName('GET /booking/e1/checkout/return?paymentKey=pk');
  withRoute.end();
  // ②' 경로 틀이 없으면 '메서드'
  const withoutRoute = tracer.startSpan('GET', { kind: SpanKind.SERVER, attributes: { 'e2e.case': 'renamed-plain', 'http.method': 'GET' } });
  withoutRoute.updateName('GET /verify/return?result=secret-verify');
  withoutRoute.end();
  // ③ 나가는 HTTP 클라이언트 span: http.url은 출처만
  tracer.startSpan('fetch POST https://api.tosspayments.com/v1/payments/confirm', { kind: SpanKind.CLIENT, attributes: { 'e2e.case': 'client', 'http.method': 'POST', 'http.url': 'https://api.tosspayments.com/v1/payments/confirm?paymentKey=pk-client' } }).end();

  // ④ Next.js 서버 쪽 fetch 계측의 클라이언트 span: 이름과 next.span_name이 'fetch <메서드> <전체 주소>'다(리뷰 RV-29, next/dist/server/lib/patch-fetch.js)
  const fetchName = 'fetch GET https://core.example/v1/search?q=비밀검색어';
  tracer.startSpan(fetchName, { kind: SpanKind.CLIENT, attributes: { 'e2e.case': 'fetch-name', 'next.span_name': fetchName, 'next.span_type': 'AppRender.fetch', 'http.method': 'GET', 'http.url': 'https://core.example/v1/search?q=비밀검색어', 'net.peer.name': 'core.example' } }).end();
  // ⑤ 서버 span의 next.span_name에 쿼리가 실린 경우(지금 Next.js는 서버 span을 '메서드'나 '메서드 경로 틀'로 짓지만 속성 규칙은 같다)
  tracer.startSpan('GET /booking/[eventId]/checkout/return', { kind: SpanKind.SERVER, attributes: { 'e2e.case': 'server-span-name', 'http.method': 'GET', 'next.route': '/booking/[eventId]/checkout/return', 'next.span_name': 'GET /booking/e1/checkout/return?orderToken=ot-span-name' } }).end();

  await telemetry.shutdown();
  spans = bodies.flatMap(decodeSpans);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('앱 서버 모드에서 내보낸 span의 주소(W7-SEC-02)', () => {
  test('V-T31 ② W7-SEC-02 내보낸 몸통이 있고 네 span이 모두 실렸다(빈 결과가 통과로 새지 않게)', () => {
    expect(bodies.length).toBeGreaterThan(0);
    for (const c of ['target', 'renamed-route', 'renamed-plain', 'client', 'fetch-name', 'server-span-name']) byCase(c);
  });

  test('V-T31 ② W7-SEC-02 앱 서버 모드에서 내보낸 서버 span의 http.target에 쿼리가 없다', () => {
    expect(byCase('target').attributes['http.target']).toBe('/booking/e1/checkout/return');
  });

  test("V-T31 ② W7-SEC-02 끝날 때 원래 주소로 바뀐 서버 span 이름은 next.route가 있으면 '메서드 경로 틀', 없으면 '메서드'로 나간다", () => {
    expect(byCase('renamed-route').name).toBe('GET /booking/[eventId]/checkout/return');
    expect(byCase('renamed-plain').name).toBe('GET');
  });

  test('V-T31 ② W7-SEC-02 HTTP 클라이언트 span의 http.url은 출처만 나간다', () => {
    expect(byCase('client').attributes['http.url']).toBe('https://api.tosspayments.com');
  });

  test('V-T31 ② W7-SEC-02 내보낸 몸통 어디에도 결제 키·본인확인 쿼리 값이 없다', () => {
    const all = bodies.map((b) => Buffer.from(b).toString('latin1')).join('\n');
    for (const secret of ['paymentKey=pk', 'pk-client', 'secret-verify']) expect(all.includes(secret), secret).toBe(false);
  });
});

describe('앱 서버 모드에서 내보낸 fetch 클라이언트 span의 이름과 속성(리뷰 RV-29)', () => {
  test('V-T31 ② RV-29 Next.js fetch 클라이언트 span의 이름과 next.span_name은 쿼리 없이 출처까지만 나간다', () => {
    const s = byCase('fetch-name');
    expect(s.name).toBe('fetch GET https://core.example');
    expect(s.attributes['next.span_name']).toBe('fetch GET https://core.example');
  });

  test('V-T31 ② RV-29 fetch 클라이언트 span과 서버 span의 다른 문자열 속성 어디에도 쿼리 값이 없다', () => {
    for (const c of ['fetch-name', 'server-span-name']) {
      const s = byCase(c);
      for (const [k, v] of Object.entries(s.attributes)) {
        if (typeof v !== 'string') continue;
        for (const secret of ['비밀검색어', 'q=', 'orderToken', 'ot-span-name']) expect(v.includes(secret), `${c} ${k}=${v}`).toBe(false);
      }
      for (const secret of ['비밀검색어', 'orderToken']) expect(s.name.includes(secret), `${c} 이름 ${s.name}`).toBe(false);
    }
  });

  test('V-T31 ② RV-29 내보낸 몸통 어디에도 fetch 쿼리 값과 서버 span 이름 속성의 쿼리 값이 없다', () => {
    const all = bodies.map((b) => Buffer.from(b).toString('utf8')).join('\n');
    for (const secret of ['비밀검색어', 'ot-span-name']) expect(all.includes(secret), secret).toBe(false);
  });
});
