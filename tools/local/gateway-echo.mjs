// 게이트웨이 kind 시험의 대역 백엔드(BUILD_ORDER HOT-400, 묶음 BAT-055 계획 §5 '시험 대역 백엔드'). 의존 없는 Node 파일 하나다.
// cluster.mjs gateways가 ConfigMap으로 실어 고정 Node 이미지에서 띄운다. 시험 약속은 tools/local/e2e/gateway-client.mjs 머리 주석이다.
// - 아무 경로·메서드: 받은 요청을 JSON { method, path, headers }로 돌려준다(머리 이름은 소문자, 같은 이름이 여럿이면 쉼표로 이음)
// - 응답 고르기(시험만 쓴다): 요청 머리 x-e2e-status(상태)·x-e2e-response-headers(JSON 객체, 값은 글이나 글 배열)·x-e2e-body(본문 글)·
//   x-e2e-body-b64(UTF-8 본문을 base64로, 한글 본문용. 있으면 x-e2e-body보다 먼저 쓴다),
//   머리를 달 수 없는 브라우저 요청은 쿼리 e2e-status·e2e-header=이름:값(여럿)
// - 늦은 응답 흉내(BAT-060, W7-CON-02 경로별 시간 상한): 요청 머리 x-e2e-delay-ms: <밀리초>(0~60000)가 있으면 그만큼 기다린 뒤 답한다
// - 서비스가 낸 Problem 흉내(BAT-060, D-T43 ②): 요청 머리 x-e2e-problem-status: <상태>가 있으면 그 상태와 application/problem+json 본문
//   {type: https://peaket.example/problems/e2e-backend, title: E2E Backend, status, traceId: 받은 traceparent의 trace-id}를 돌려준다
//   (서비스 템플릿 Problem의 traceId와 같은 규칙, docs/api/guidelines.md §2). 경로는 가리지 않는다
// - GET /internal/jwks/{fan|admin|staff|admission}.json: 환경 값 PEAKET_E2E_JWKS(JSON { 이름: 공개키 묶음 })의 그 묶음(identity 공개키 배포의 대역)
// 게이트웨이의 라우트는 /internal/을 내지 않으므로 이 경로는 프록시의 공개키 묶음 읽기만 닿는다.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const JWKS = JSON.parse(process.env.PEAKET_E2E_JWKS || '{}');

/** 받은 머리(소문자 이름 → 값, 여럿은 쉼표로 이음) */
function headersOf(req) {
  const out = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i].toLowerCase();
    const v = req.rawHeaders[i + 1];
    out[k] = out[k] === undefined ? v : `${out[k]}, ${v}`;
  }
  return out;
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const delay = Number(req.headers['x-e2e-delay-ms']);
    if (Number.isInteger(delay) && delay > 0 && delay <= 60000) setTimeout(() => answer(req, res, chunks), delay);
    else answer(req, res, chunks);
  });
}).listen(PORT, '0.0.0.0', () => console.log(JSON.stringify({ msg: 'gateway-echo listening', port: PORT })));

/** 받은 요청에 답한다(위 응답 고르기) */
function answer(req, res, chunks) {
  {
    const url = new URL(req.url ?? '/', 'http://echo.local');
    const jwks = /^\/internal\/jwks\/([a-z]+)\.json$/.exec(url.pathname);
    if (req.method === 'GET' && jwks) {
      const set = JWKS[jwks[1]];
      res.writeHead(set ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'max-age=300' });
      res.end(JSON.stringify(set ?? { error: 'unknown key set' }));
      return;
    }
    const headers = headersOf(req);
    const problemStatus = Number(headers['x-e2e-problem-status']);
    if (Number.isInteger(problemStatus) && problemStatus >= 400 && problemStatus <= 599) {
      const traceId = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(headers.traceparent ?? '')?.[1];
      res.writeHead(problemStatus, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ type: 'https://peaket.example/problems/e2e-backend', title: 'E2E Backend', status: problemStatus, ...(traceId ? { traceId } : {}) }));
      return;
    }
    const status = Number(headers['x-e2e-status'] ?? url.searchParams.get('e2e-status') ?? 200) || 200;
    const out = { 'content-type': 'application/json' };
    if (headers['x-e2e-response-headers']) {
      try {
        Object.assign(out, JSON.parse(headers['x-e2e-response-headers']));
      } catch {
        // 시험이 틀린 JSON을 보내면 머리 없이 답한다
      }
    }
    for (const h of url.searchParams.getAll('e2e-header')) {
      const i = h.indexOf(':');
      if (i > 0) out[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
    }
    // Set-Cookie 전달 시험(게이트웨이가 지우거나 다시 쓰지 않는지, I-T52 ①). 값이 'two'면 관리 쿠키 둘을, JSON이면 그 값을 쓴다
    const cookieHeader = headers['x-e2e-set-cookie'];
    if (cookieHeader !== undefined) {
      if (cookieHeader === '' || cookieHeader === 'two') {
        out['set-cookie'] = ['__Host-peaket_ops_at=e2e-access; Path=/; HttpOnly; Secure; SameSite=Lax', '__Host-peaket_ops_rt=e2e-refresh; Path=/v1/ops/auth/access-tokens; HttpOnly; Secure; SameSite=Lax'];
      } else {
        try {
          const parsed = JSON.parse(cookieHeader);
          out['set-cookie'] = Array.isArray(parsed) ? parsed : [String(parsed)];
        } catch {
          out['set-cookie'] = [cookieHeader];
        }
      }
    }
    const b64 = headers['x-e2e-body-b64'];
    const body = b64 !== undefined ? Buffer.from(b64, 'base64') : headers['x-e2e-body'] ?? JSON.stringify({ method: req.method, path: req.url, headers, bodyBytes: Buffer.concat(chunks).length });
    res.writeHead(status, out);
    res.end(status === 204 || status === 304 || req.method === 'HEAD' ? undefined : body);
  }
}
