// 공지 화면 시험의 REST 대역(계획 docs/review/plans/F-03-5.md §4 '시험 대역').
// 가짜는 REST 경계(전역 fetch)만 바꾼다. 본문 만들기·검사·오류 글은 진짜 모듈을 쓴다.
export const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

export function problem(status, type = 'about:blank', title = '요청을 처리하지 못했습니다', detail = '서버 내부 문구') {
  return new Response(JSON.stringify({ type: `https://peaket.example/problems/${type}`, title, status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json; charset=utf-8' },
  });
}

/** 전역 fetch를 가로채 method·path로 답한다. install()/restore()는 시험마다 부른다 */
export function fakeRest() {
  const routes = [];
  const requests = [];
  let original;

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    let raw;
    let form;
    if (typeof init.body === 'string') raw = init.body;
    else if (init.body instanceof FormData) {
      form = init.body;
      raw = [...init.body.keys()].join(',');
    }
    const req = {
      method,
      path: url.pathname,
      url,
      headers,
      raw,
      bytes: init.body instanceof ArrayBuffer ? init.body.byteLength : undefined,
      form,
      body: raw && raw.startsWith('{') ? JSON.parse(raw) : undefined,
    };
    requests.push(req);
    const hit = routes.find((r) => r.method === method && (typeof r.path === 'string' ? r.path === req.path : r.path.test(req.path)));
    if (!hit) return problem(404, 'not-found');
    return hit.handler(req);
  };

  return {
    on(method, path, handler) {
      routes.push({ method, path, handler });
    },
    sent(method, path) {
      return requests.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path)));
    },
    requests,
    install() {
      original ??= globalThis.fetch;
      globalThis.fetch = fetchImpl;
    },
    restore() {
      if (original) globalThis.fetch = original;
    },
  };
}
