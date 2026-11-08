// 구매 세션 서명기 세 엔진 검사의 작은 서버(FE-T7, ADR-0221 결정 7). 의존성 없이 Node http만 쓴다. 실행: node purchase/server.mjs [--port 4220]
// - GET /                 빈 페이지(시험이 page.evaluate로 모듈을 불러 쓴다)
// - GET /m/<이름>         packages/api-client/src/purchase/<이름>.ts를 Node 타입 지우기(module.stripTypeScriptTypes)로 JS로 바꿔 준다.
//                         묶지 않고 원본을 그대로 내므로 화면이 쓰는 코드와 같다(모듈 안의 './crypto'는 /m/crypto로 풀린다)
// - GET /vectors.json     서버와 같은 시험 벡터(docs/api/vectors/purchase-request-mac.v1.json)
// - POST /sink?d=<ms>     받은 X-Purchase-Seq를 받은 차례대로 적고 d밀리초 뒤 204로 답한다. 동시에 처리 중인 요청 수의 최댓값도 잰다
//                         (잠금이 응답까지 쥐고 있으면 1이다)
// - GET /sink · DELETE /sink  적은 차례와 최댓값 읽기·비우기
// 보안 맥락이어야 crypto.subtle·Web Locks가 있으므로 127.0.0.1에 붙는다(PEAKET_SERVE_HOST로 바꿀 수 있다: 컨테이너는 같은 곳에서 띄운다).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4220' } } });
const port = Number(values.port);
const host = process.env.PEAKET_SERVE_HOST ?? '127.0.0.1';
const SRC = new URL('../../../packages/api-client/src/purchase/', import.meta.url);
const VECTORS = new URL('../../../docs/api/vectors/purchase-request-mac.v1.json', import.meta.url);
const MODULES = new Set(['crypto', 'store', 'signer', 'index']);
/** @type {string[]} */
let sink = [];
let inflight = 0;
let maxInflight = 0;

// 타입 지우기는 실험 기능이라 경고를 한 번 낸다. 검사 출력에 섞이지 않게 그 경고만 끈다
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><title>purchase signer</title><p>구매 세션 서명기 검사</p>');
    if (req.method === 'GET' && u.pathname.startsWith('/m/')) {
      const name = u.pathname.slice(3);
      if (!MODULES.has(name)) return send(res, 404, 'text/plain', 'no module');
      const ts = await readFile(fileURLToPath(new URL(`${name}.ts`, SRC)), 'utf8');
      return send(res, 200, 'text/javascript; charset=utf-8', stripTypeScriptTypes(ts));
    }
    if (req.method === 'GET' && u.pathname === '/vectors.json') return send(res, 200, 'application/json', await readFile(fileURLToPath(VECTORS)));
    if (u.pathname === '/sink') {
      if (req.method === 'DELETE') {
        sink = [];
        inflight = 0;
        maxInflight = 0;
        return send(res, 204, 'text/plain', '');
      }
      if (req.method === 'GET') return send(res, 200, 'application/json', JSON.stringify({ seqs: sink, maxInflight }));
      if (req.method === 'POST') {
        sink.push(String(req.headers['x-purchase-seq'] ?? ''));
        const d = Math.min(200, Math.max(0, Number(u.searchParams.get('d')) || 0));
        req.resume();
        maxInflight = Math.max(maxInflight, ++inflight);
        return setTimeout(() => {
          inflight--;
          send(res, 204, 'text/plain', '');
        }, d);
      }
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    send(res, 500, 'text/plain', String(e));
  }
}).listen(port, host, () => console.log(`purchase signer check server http://${host}:${port}/`));
