// 캐시 화면(A) 응답 때 해시 서버 시험(소유자 결정 2026-11-04 '응답 때 해시', ADR-0193, docs/frontend.md §5.14.1, BUILD_ORDER HOT-290).
// 실행: pnpm --filter @peaket/web test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { gzipSync } from 'node:zlib';
import { CSP_TEMPLATE_HEADER, HASH_SENTINEL, MAX_HTML_BYTES, createCspHashServer, inlineScriptHashes, reactRuntimeScripts } from './csp-hash-server.mjs';

const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
const TEMPLATE = `default-src 'self'; script-src 'self' ${HASH_SENTINEL}; style-src 'self'; object-src 'none'; report-to csp`;

/** 위 서버(Next.js 자리)를 띄우고 그 앞에 해시 서버를 띄운다. handler(req, res)가 위 서버의 응답이다 */
async function pair(handler) {
  const up = createServer(handler);
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const front = createCspHashServer({ upstream: `http://127.0.0.1:${up.address().port}`, runtime: RUNTIME });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const port = front.address().port;
  const get = (path, headers = {}, method = 'GET', body = undefined) =>
    new Promise((resolve, reject) => {
      const rq = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        // 응답 도중 연결이 끊기면 끝(end)이 오지 않고 aborted·error가 온다
        res.on('aborted', () => reject(new Error('aborted')));
        res.on('error', reject);
      });
      rq.on('error', reject);
      rq.end(body);
    });
  return { get, port, close: () => Promise.all([new Promise((r) => { up.closeAllConnections?.(); up.close(r); }), new Promise((r) => { front.closeAllConnections?.(); front.close(r); })]) };
}

/** 시험용 React 스트리밍 도우미 정의(실제 값은 start.mjs가 설치된 Next.js 실행 파일에서 읽는다) */
const RS_DEF = '$RS=function(a,b){a=document.getElementById(a)};';
const RUNTIME = [RS_DEF, 'requestAnimationFrame(function(){$RT=performance.now()});'];
const FLIGHT0 = '(self.__next_f=self.__next_f||[]).push([0])';
const FLIGHT1 = 'self.__next_f.push([1,"1:\\"$Sreact.fragment\\"\\n"])';
const TURBO = '(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push({"otherChunks":["static/chunks/a1.js"],"runtimeModuleIds":[90106]});';
const HTML = `<html><head><script src="/_next/a.js" async=""></script><script>${FLIGHT0}</script></head><body><script id="_R_">${TURBO}</script><script type="application/json">{"x":1}</script><script>${FLIGHT1}</script></body></html>`;

test('[ASVS v5.0.0-3.4.3] Next.js·React가 넣는 모양의 인라인 스크립트만 해시한다(src 있는 것·JSON 블록 제외, 같은 것은 한 번)', () => {
  assert.deepEqual(inlineScriptHashes(HTML + `<script>${FLIGHT0}</script>`, RUNTIME), [sha(FLIGHT0), sha(TURBO), sha(FLIGHT1)]);
  // React 도우미: 정의(설치된 Next.js에서 읽은 것과 글자까지 같음) + 문자열·숫자·배열만 넘기는 부르기
  const rs = `${RS_DEF}$RS("S:1","P:1")`;
  assert.deepEqual(inlineScriptHashes(`<script>${rs}</script><script>$RC("B:1","S:1")</script><script>$RR("B:0","S:0",[["/a.css","high"]])</script>`, RUNTIME), [sha(rs), sha('$RC("B:1","S:1")'), sha('$RR("B:0","S:0",[["/a.css","high"]])')]);
  assert.deepEqual(inlineScriptHashes(`<script>${RUNTIME[1]}</script>`, RUNTIME), [sha(RUNTIME[1])]);
});

test('[ASVS v5.0.0-3.4.3] 끼워 넣은 스크립트는 해시하지 않는다(모양을 흉내 내도): 응답 때 해시가 주입된 스크립트를 허용 목록에 넣지 않는다', () => {
  const evil = [
    'evil()',
    'self.__next_f.push([1,"x"]);evil()',
    'self.__next_f.push([1,"x"].concat(evil()))',
    '$RS=function(a,b){evil()};$RS("S:1","P:1")',
    `${RS_DEF}$RS("S:1",evil())`,
    '$RC("B:1","S:1");evil()',
    '(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push({"otherChunks":["https://evil.example/x.js"],"runtimeModuleIds":[1]});',
    '(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push(evil());',
  ];
  for (const e of evil) assert.deepEqual(inlineScriptHashes(`<script>${e}</script>`, RUNTIME), [], e);
  assert.deepEqual(inlineScriptHashes('<script type="module">m()</script><script type="text/javascript">t()</script>', RUNTIME), []);
});

test('[ASVS v5.0.0-3.4.3] 설치된 Next.js 운영 실행 파일에서 React 스트리밍 도우미 정의를 읽는다(판을 올려 모양이 바뀌면 이 시험이 먼저 알린다)', () => {
  const defs = reactRuntimeScripts(new URL('..', import.meta.url));
  for (const head of ['$RS=function(', '$RB=[];$RV=function(', '$RX=function(', '$RM=new Map;$RR=function(', 'requestAnimationFrame(function(){$RT=performance.now()});', "document.querySelectorAll('body link[rel=\"icon\"]"]) {
    assert.ok(defs.some((d) => d.startsWith(head)), `${head}로 시작하는 정의가 없다`);
  }
  // 정의는 부르기 앞머리($RS(" 같은 것)를 품지 않는다(React는 정의 뒤에 부르기를 이어 붙인다)
  for (const d of defs) assert.doesNotMatch(d, /\$R[A-Z]{1,2}\("$/, d.slice(-30));
});

test('[ASVS v5.0.0-3.4.3] React가 실제로 내는 첫 도우미 스크립트(설치된 Next.js의 정의 + 부르기)에 해시가 붙는다', () => {
  const defs = reactRuntimeScripts(new URL('..', import.meta.url));
  const def = (head) => defs.find((d) => d.startsWith(head));
  const cases = [
    `${def('$RS=function(')}$RS("S:1","P:1")`,
    `${def('$RB=[];$RV=function(')}$RC("B:0","S:0")`,
    `${def('$RX=function(')}$RX("B:2","digest","","","")`,
    `${def('$RM=new Map;$RR=function(')}$RR("B:3","S:3",[["/_next/static/a.css","high"]])`,
    `${def('$RB=[];$RV=function(')}${def('$RM=new Map;$RR=function(')}$RR("B:4","S:4",[])`,
    def("document.querySelectorAll('body link[rel=\"icon\"]"),
  ];
  for (const c of cases) assert.deepEqual(inlineScriptHashes(`<script>${c}</script>`, defs), [sha(c)], c.slice(0, 40));
  // 실제 정의 뒤에 데이터가 아닌 것을 붙이면 안 된다
  assert.deepEqual(inlineScriptHashes(`<script>${def('$RS=function(')}$RS("S:1",evil())</script>`, defs), []);
});

test('[ASVS v5.0.0-3.4.3] 캐시 화면 HTML은 다 받은 뒤 인라인 해시로 막는 CSP를 달고, 보고 모드·안쪽 머리는 지운다', async () => {
  const p = await pair((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', [CSP_TEMPLATE_HEADER]: TEMPLATE, 'content-security-policy-report-only': 'x', 'cache-control': 's-maxage=60' });
    // 조각으로 흘려 보내도 다 모은 뒤 해시를 낸다
    res.write(HTML.slice(0, 40));
    setTimeout(() => res.end(HTML.slice(40)), 20);
  });
  try {
    const r = await p.get('/events/e-1');
    assert.equal(r.status, 200);
    assert.equal(r.body, HTML);
    assert.equal(r.headers['content-security-policy'], TEMPLATE.replace(HASH_SENTINEL, [sha(FLIGHT0), sha(TURBO), sha(FLIGHT1)].join(' ')));
    assert.equal(r.headers[CSP_TEMPLATE_HEADER], undefined);
    assert.equal(r.headers['content-security-policy-report-only'], undefined);
    assert.equal(r.headers['content-length'], String(Buffer.byteLength(HTML)));
    assert.equal(r.headers['cache-control'], 's-maxage=60');
  } finally {
    await p.close();
  }
});

test('[ASVS v5.0.0-3.4.3] 인라인 스크립트가 없으면 해시 자리를 지운다(script-src는 self만)', async () => {
  const p = await pair((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', [CSP_TEMPLATE_HEADER]: TEMPLATE });
    res.end('<html><body>정적</body></html>');
  });
  try {
    const r = await p.get('/');
    assert.equal(r.headers['content-security-policy'], TEMPLATE.replace(` ${HASH_SENTINEL}`, ''));
  } finally {
    await p.close();
  }
});

test('[ASVS v5.0.0-3.4.3] 틀 머리가 없는 응답(요청 화면·처리기·자산)은 그대로 흘려 보낸다', async () => {
  const p = await pair((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src 'nonce-abc'" });
    res.end('<script nonce="abc">x()</script>');
  });
  try {
    const r = await p.get('/my/settings');
    assert.equal(r.headers['content-security-policy'], "script-src 'nonce-abc'");
    assert.equal(r.body, '<script nonce="abc">x()</script>');
  } finally {
    await p.close();
  }
});

test('[ASVS v5.0.0-3.4.3] GET이 아닌 HTML 응답(본인확인 기관의 POST 복귀)에도 해시를 채운 막는 CSP를 단다', async () => {
  const p = await pair((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/html', [CSP_TEMPLATE_HEADER]: TEMPLATE, 'content-security-policy-report-only': 'x' });
    res.end(`<script>${FLIGHT0}</script>`);
  });
  try {
    const r = await p.get('/verify/return', { 'content-type': 'application/x-www-form-urlencoded' }, 'POST', 'a=1');
    assert.equal(r.headers['content-security-policy'], TEMPLATE.replace(HASH_SENTINEL, sha(FLIGHT0)));
    assert.equal(r.headers['content-security-policy-report-only'], undefined);
  } finally {
    await p.close();
  }
});

test('[ASVS v5.0.0-3.4.3] HTML이 아닌 응답(화면 데이터 RSC)·304·HEAD는 본문을 고치지 않고 CSP 머리를 모두 뺀다', async () => {
  const p = await pair((req, res) => {
    if (req.headers['if-none-match']) {
      res.writeHead(304, { [CSP_TEMPLATE_HEADER]: TEMPLATE, 'content-security-policy-report-only': 'x', etag: '"1"' });
      return res.end();
    }
    const html = req.headers.rsc !== '1';
    res.writeHead(200, { 'content-type': html ? 'text/html' : 'text/x-component', [CSP_TEMPLATE_HEADER]: TEMPLATE, 'content-security-policy-report-only': 'x' });
    res.end(html ? '<script>a()</script>' : '0:{"a":1}');
  });
  try {
    const rsc = await p.get('/events/e-1', { rsc: '1' });
    assert.equal(rsc.body, '0:{"a":1}');
    assert.equal(rsc.headers[CSP_TEMPLATE_HEADER], undefined);
    assert.equal(rsc.headers['content-security-policy'], undefined);
    const nm = await p.get('/events/e-1', { 'if-none-match': '"1"' });
    assert.equal(nm.status, 304);
    assert.equal(nm.headers['content-security-policy-report-only'], undefined);
    assert.equal(nm.headers[CSP_TEMPLATE_HEADER], undefined);
    const head = await p.get('/events/e-1', {}, 'HEAD');
    assert.equal(head.headers[CSP_TEMPLATE_HEADER], undefined);
    assert.equal(head.headers['content-security-policy'], undefined);
  } finally {
    await p.close();
  }
});

test('[ASVS v5.0.0-3.4.3] 위 서버에는 압축하지 말라고 보낸다(해시는 압축 전 본문으로 낸다). 압축된 HTML이 오면 해시 없이 막는 CSP를 단다', async () => {
  const seen = [];
  const p = await pair((req, res) => {
    seen.push(req.headers['accept-encoding']);
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', [CSP_TEMPLATE_HEADER]: TEMPLATE });
    res.end(gzipSync('<script>a()</script>'));
  });
  try {
    const r = await p.get('/', { 'accept-encoding': 'gzip, br' });
    assert.deepEqual(seen, ['identity']);
    assert.equal(r.headers['content-security-policy'], TEMPLATE.replace(` ${HASH_SENTINEL}`, ''));
  } finally {
    await p.close();
  }
});

test('[ASVS v5.0.0-3.4.3] 상한보다 큰 HTML은 해시를 내지 않고 해시 없이 막는 CSP로 흘려 보낸다(보호를 풀지 않고 메모리에 다 쌓지 않는다)', async () => {
  const big = `<script>${FLIGHT0}</script>${'x'.repeat(MAX_HTML_BYTES)}`;
  const p = await pair((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', [CSP_TEMPLATE_HEADER]: TEMPLATE });
    res.end(big);
  });
  try {
    const r = await p.get('/');
    assert.equal(r.headers['content-security-policy'], TEMPLATE.replace(` ${HASH_SENTINEL}`, ''));
    assert.equal(r.body.length, big.length);
  } finally {
    await p.close();
  }
});

test('요청 본문(POST)과 머리를 위 서버에 그대로 넘기고(원래 Host는 x-forwarded-host로), 위 서버가 죽었으면 502다', async () => {
  let got;
  const p = await pair((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got = { method: req.method, b, ct: req.headers['content-type'], fwd: req.headers['x-forwarded-host'] };
      res.writeHead(204);
      res.end();
    });
  });
  try {
    const r = await p.get('/logout', { 'content-type': 'application/x-www-form-urlencoded', host: 'www.peaket.example' }, 'POST', 'a=1');
    assert.equal(r.status, 204);
    assert.deepEqual(got, { method: 'POST', b: 'a=1', ct: 'application/x-www-form-urlencoded', fwd: 'www.peaket.example' });
  } finally {
    await p.close();
  }
  const front = createCspHashServer({ upstream: 'http://127.0.0.1:1' });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const status = await new Promise((resolve) => {
    const rq = request({ host: '127.0.0.1', port: front.address().port, path: '/', method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    rq.end();
  });
  await new Promise((r) => front.close(r));
  assert.equal(status, 502);
});

test('위 서버가 본문 도중 끊으면 손님 응답도 끊고, 손님이 끊으면 위 서버 요청도 끊는다', async () => {
  let upstreamClosed = false;
  const p = await pair((req, res) => {
    res.on('close', () => (upstreamClosed = true));
    if (req.url === '/cut') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('abc');
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('x');
  });
  try {
    const cut = await p.get('/cut').then(
      () => 'ended',
      () => 'error',
    );
    assert.equal(cut, 'error');
    // 손님이 먼저 끊는다
    await new Promise((resolve) => {
      const rq = request({ host: '127.0.0.1', port: p.port, path: '/hang', method: 'GET' }, (res) => {
        res.once('data', () => {
          rq.destroy();
          setTimeout(resolve, 100);
        });
      });
      rq.on('error', () => {});
      rq.end();
    });
    assert.equal(upstreamClosed, true);
  } finally {
    await p.close();
  }
});

test('손님이 위 서버의 답보다 먼저 끊어도 앞 서버는 죽지 않고 다음 요청을 받는다(위 서버 요청도 끊는다)', async () => {
  let upstreamReqClosed = false;
  const p = await pair((req, res) => {
    req.on('close', () => (upstreamReqClosed = true));
    // 늦게 답한다: 그 사이 손님이 끊는다
    setTimeout(() => {
      if (res.writable) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('late');
      }
    }, 300);
  });
  try {
    await new Promise((resolve) => {
      const rq = request({ host: '127.0.0.1', port: p.port, path: '/slow', method: 'GET' });
      rq.on('error', () => {});
      rq.end();
      setTimeout(() => {
        rq.destroy();
        resolve();
      }, 50);
    });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(upstreamReqClosed, true);
    const again = await p.get('/slow');
    assert.equal(again.status, 200);
    assert.equal(again.body, 'late');
  } finally {
    await p.close();
  }
});
