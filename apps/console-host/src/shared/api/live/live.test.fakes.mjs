// connection*.test.mjs가 함께 쓰는 가짜 관제 API(시험 전용, F-03-1). 전역 fetch 자리에 끼워, 늘 여는 흐름·위젯 흐름은 조각을 미는 SSE 응답으로,
// REST는 정한 JSON으로 답하고 받은 요청을 적는다. 응답 모양은 계약(openapi ops)의 꼴을 따른다. 이름이 *.test.mjs로 끝나지 않아 시험 파일로 돌지 않는다.
const enc = new TextEncoder();

/** 조각을 미는 SSE 응답 하나 */
function sseResponse(signal) {
  let ctl;
  let closed = false;
  const body = new ReadableStream({
    start(c) {
      ctl = c;
    },
  });
  const stream = {
    aborted: false,
    push(text) {
      if (!closed) ctl.enqueue(enc.encode(text));
    },
    end() {
      if (closed) return;
      closed = true;
      ctl.close();
    },
    fail() {
      if (closed) return;
      closed = true;
      ctl.error(new TypeError('network'));
    },
  };
  signal?.addEventListener('abort', () => {
    stream.aborted = true;
    if (!closed) {
      closed = true;
      ctl.error(new DOMException('aborted', 'AbortError'));
    }
  });
  return { stream, response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }) };
}

/**
 * 가짜 관제 API. rest(method, path) 처리기를 바꿔 끼울 수 있다.
 * @returns requests(받은 요청), live()·widgets()(지금까지 연 흐름), install()
 */
export function fakeOpsApi() {
  const requests = [];
  const liveStreams = [];
  const widgetStreams = [];
  const rest = new Map();
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? (typeof input === 'string' ? 'GET' : input.method) ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers)).entries());
    const req = { method, path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), headers };
    requests.push(req);
    if (method === 'GET' && url.pathname === '/v1/ops/live') {
      const { stream, response } = sseResponse(init.signal);
      liveStreams.push({ ...req, stream });
      return response;
    }
    if (method === 'GET' && /^\/v1\/ops\/events\/[^/]+\/live$/.test(url.pathname)) {
      const { stream, response } = sseResponse(init.signal);
      widgetStreams.push({ ...req, stream });
      return response;
    }
    const h = rest.get(`${method} ${url.pathname}`);
    if (h) return h(req);
    return new Response(JSON.stringify({ type: 'https://peaket.example/problems/not-found', title: '찾을 수 없습니다', status: 404 }), { status: 404, headers: { 'content-type': 'application/problem+json' } });
  };
  return {
    requests,
    live: () => liveStreams,
    widgets: () => widgetStreams,
    /** REST 처리기(method 'POST', path '/v1/ops/auth/access-tokens' 같은 것) */
    on(method, path, handler) {
      rest.set(`${method} ${path}`, handler);
    },
    install() {
      globalThis.fetch = fetchImpl;
    },
  };
}

export const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });

/** 대기 중인 Promise·I/O 차례를 비운다(시간이 아니라 일 차례만 돌린다) */
export const drain = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
};
