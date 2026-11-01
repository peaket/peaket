// V-T31 ③ 외부 호출 헤더 탐침(@peaket/platform/testing, docs/verification.md V-T31, openspec 변경 add-service-logging 결정 6).
// 외부 제공자 어댑터의 시험에서 쓴다: 기록하는 모의 서버를 띄우고, 표본 표시를 켠 span과 Baggage가 있는 맥락에서
// call(baseUrl)을 돌린 뒤 받은 요청의 헤더를 돌려준다. 어댑터가 기본 HTTP 클라이언트로 바뀌면 추적 헤더가 실려 시험이 실패한다.
import { type IncomingHttpHeaders, createServer } from 'node:http';
import { context, propagation, trace } from '@opentelemetry/api';
import type { ControlCodec, SessionTerminated, SettingChanged } from './control.js';

/** 제어 사건 값을 JSON으로 읽는 대역(Avro 디코더는 BAS-030). 시험과 로컬 실행에서만 쓴다 */
export const jsonControlCodec: ControlCodec = {
  setting: (value) => JSON.parse(value.toString('utf8')) as SettingChanged,
  sessionTerminated: (value) => JSON.parse(value.toString('utf8')) as SessionTerminated,
};

export { TRACE_PROPAGATION_HEADERS } from './http-client.js';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

export interface ProbeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

const CONTROL = '/__peaket_probe_control';

export async function probeTraceHeaders(
  call: (baseUrl: string) => Promise<unknown>,
  o: { respond?: (req: RecordedRequest) => ProbeResponse } = {},
): Promise<RecordedRequest[]> {
  const recorded: RecordedRequest[] = [];
  let control: IncomingHttpHeaders | undefined;
  const server = createServer((req, res) => {
    const r: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers };
    req.resume();
    req.on('end', () => {
      if (r.url === CONTROL) control = r.headers;
      else recorded.push(r);
      const out = r.url === CONTROL ? { status: 200 } : (o.respond?.(r) ?? { status: 200, body: '{}' });
      res.writeHead(out.status, out.headers);
      res.end(out.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const tracer = trace.getTracer('@peaket/platform/testing');
  try {
    await tracer.startActiveSpan('peaket.probe', async (span) => {
      const ctx = propagation.setBaggage(context.active(), propagation.createBaggage({ 'peaket.probe': { value: '1' } }));
      try {
        await context.with(ctx, async () => {
          // 대조: 기본 fetch가 traceparent·baggage를 싣지 않으면 텔레메트리가 서지 않은 것이라 탐침이 아무것도 잡지 못한다
          await (await fetch(`${baseUrl}${CONTROL}`)).text();
          if (!control?.traceparent || !control.baggage) {
            throw new Error('탐침: 기본 fetch에 traceparent·baggage가 실리지 않는다. OTel SDK(@peaket/platform/telemetry)를 먼저 시작하고, 전파를 끈 맥락 밖에서 부른다');
          }
          await call(baseUrl);
          // 어댑터가 모의 서버가 아닌 곳(설정의 실제 주소 등)으로 보내면 탐침이 아무것도 보지 못한 채 통과한다(코드 리뷰, 2026-11-01)
          if (recorded.length === 0) throw new Error('탐침: call이 모의 서버(baseUrl)로 요청을 보내지 않았다. 어댑터의 주소를 baseUrl로 바꿔 부른다');
        });
      } finally {
        span.end();
      }
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return recorded;
}
