// ops-svc CS 처리함 내부 HTTP(POST /internal/v1/cs-cases)의 로컬 대역(BAT-420 다시 보기 2 N1·N2, 시험 담당 l3w8-420-n-test).
// 실제 HttpRefundFailureNotice·HttpDeductionGapNotice·HttpEntryFlagNotice가 실제 HTTP(5초 한도)로 부르게 하고, 답을 고른다:
// 'hang'은 요청을 붙잡고 답하지 않는다(부르는 쪽 시간 초과), { slowMs, status }는 늦게 답한다, 숫자는 바로 그 상태 코드다.
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type OpsCsMode = 'hang' | number | { readonly slowMs: number; readonly status: number };
export interface OpsCsRequest {
  readonly atMs: number;
  readonly token: string | undefined;
  readonly body: { readonly eventKey: string; readonly kind: string; readonly sourceId: string; readonly category: string };
}

/** log를 주면 요청이 닿을 때마다 `ops:{category}:{sourceId}`를 덧붙인다(호출 차례 기록) */
export async function startOpsCsDouble(log?: string[]): Promise<{ state: { mode: OpsCsMode; requests: OpsCsRequest[]; accepted: boolean }; url: string; close(): Promise<void> }> {
  const state = { mode: 202 as OpsCsMode, requests: [] as OpsCsRequest[], accepted: true };
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as OpsCsRequest['body'];
      const token = req.headers['x-peaket-internal-token'];
      state.requests.push({ atMs: Date.now(), token: typeof token === 'string' ? token : undefined, body });
      log?.push(`ops:${body.category}:${body.sourceId}`);
      const m = state.mode;
      if (m === 'hang') return;
      // BAT-420-rest 리뷰 반영 RV-01(시험 담당 l3-b420-test): 실제 ops-svc처럼 2xx 본문에 accepted를 싣는다(state.accepted, 기본 참, transfer-refund §3.1 ⑥ '실패 기록')
      const answer = (status: number) => (status >= 200 && status <= 299 ? JSON.stringify({ accepted: state.accepted }) : '{}');
      if (typeof m === 'object') {
        setTimeout(() => {
          if (!res.destroyed) res.writeHead(m.status, { 'content-type': 'application/json' }).end(answer(m.status));
        }, m.slowMs);
        return;
      }
      res.writeHead(m, { 'content-type': 'application/json' }).end(answer(m));
    });
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
