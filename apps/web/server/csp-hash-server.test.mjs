// 캐시 화면(A) 응답 때 해시 서버 시험(소유자 결정 2026-11-04 '응답 때 해시', ADR-0193, docs/frontend.md §5.14.1, BUILD_ORDER HOT-290).
// 실행: pnpm --filter @peaket/web test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CSP_TEMPLATE_HEADER, HASH_SENTINEL, MAX_HTML_BYTES, createCspHashServer, inlineScriptHashes, reactRuntimeScripts } from './csp-hash-server.mjs';
// BAT-177-r2(ADR-0359)의 새 내보내기는 이름공간으로 읽는다: 내보내기가 없는 트리에서도 파일이 읽혀 T3·T4의 단언 실패가 보인다(계획 §6)
import * as front from './csp-hash-server.mjs';

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
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          // raw: 받은 날 바이트(압축된 본문을 풀지 않고 본다)
          resolve({ status: res.statusCode, headers: res.headers, body: raw.toString('utf8'), raw });
        });
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

// ADR-0201: 캐시 화면은 응답 상태를 바꾸지 못해(Cache Components가 본문을 먼저 흘린다) 화면이 상태 표시를 그리고 앞 서버가 맞춘다
const statusPage = (code, extra = '') => `<html><head><meta name="peaket-status" content="${code}"/></head><body>${extra}<script>${FLIGHT0}</script></body></html>`;

test('화면의 상태 표시(404·410)를 읽어 상태 코드와 짧은 캐시로 맞추고, 해시도 그대로 채운다(ADR-0201)', async () => {
  for (const code of [404, 410]) {
    const p = await pair((_q, r) => {
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', [CSP_TEMPLATE_HEADER]: TEMPLATE, 'cache-control': 's-maxage=31536000' });
      r.end(statusPage(code));
    });
    try {
      const res = await p.get('/events/x');
      assert.equal(res.status, code);
      assert.equal(res.headers['cache-control'], 'public, max-age=60');
      assert.ok(res.headers['content-security-policy'].includes(sha(FLIGHT0)));
    } finally {
      await p.close();
    }
  }
});

test('상태 표시가 없거나, 허용 밖 값이거나, 위 서버가 200이 아니거나, 글로 쓰인 표시면 상태를 바꾸지 않는다(ADR-0201)', async () => {
  const cases = [
    { body: HTML, upstream: 200, want: 200 },
    { body: statusPage(500), upstream: 200, want: 200 },
    { body: statusPage(301), upstream: 200, want: 200 },
    { body: statusPage(410), upstream: 503, want: 503 },
    // 본문 글은 React가 < 를 바꿔 쓰고, 인라인 화면 데이터는 <로 싣는다: 그 꼴은 표시가 아니다
    { body: `<html><head></head><body><p>&lt;meta name="peaket-status" content="410"/&gt;</p><script>self.__next_f.push([1,"\u003cmeta name=\\"peaket-status\\" content=\\"410\\"/\u003e"])</script></body></html>`, upstream: 200, want: 200 },
  ];
  for (const c of cases) {
    const p = await pair((_q, r) => {
      r.writeHead(c.upstream, { 'content-type': 'text/html; charset=utf-8', [CSP_TEMPLATE_HEADER]: TEMPLATE, 'cache-control': 's-maxage=300' });
      r.end(c.body);
    });
    try {
      const res = await p.get('/x');
      assert.equal(res.status, c.want, c.body.slice(0, 80));
      if (c.want === 200) assert.equal(res.headers['cache-control'], 's-maxage=300');
    } finally {
      await p.close();
    }
  }
});

// ---- BAT-177-r2(OPEN[52] (나), ADR-0359): 정적 덩어리(/_next/static/)만 손님의 압축 요청을 위 서버에 넘긴다 ----
// 단언 값은 계획 docs/review/plans/BAT-177-r2.md §4·§5에서 가져온다. 시험용 CSS는 임의 글이다.

test('BAT-177-r2 T1 정적 덩어리 경로 판정 표: GET·HEAD이고 ? 앞 경로가 대소문자까지 /_next/static/으로 시작하며 %·역슬래시·빈 마디·점 마디가 없을 때만 참', () => {
  assert.equal(typeof front.isStaticAssetRequest, 'function', 'isStaticAssetRequest를 내보내야 한다');
  assert.equal(front.STATIC_ASSET_PREFIX, '/_next/static/');
  const yes = [
    ['GET', '/_next/static/chunks/a1.css'],
    ['GET', '/_next/static/chunks/1yvvqr7d-lx4r.css?dpl=050711fb'],
    ['HEAD', '/_next/static/media/x.woff2'],
    ['GET', '/_next/static/abc/_buildManifest.js'],
    // 쿼리는 판정에 쓰지 않는다(쿼리 속 %·..는 경로가 아니다)
    ['GET', '/_next/static/chunks/a.js?v=%2e%2e/../x'],
  ];
  const no = [
    ['POST', '/_next/static/a.css'],
    ['PUT', '/_next/static/a.css'],
    ['get', '/_next/static/a.css'],
    ['head', '/_next/static/a.css'],
    [undefined, '/_next/static/a.css'],
    ['GET', '/_next/static'],
    ['GET', '/_next/static?x=/a.css'],
    ['GET', '/_next/static/'],
    ['GET', '/_next/static/?a.css'],
    ['GET', '/_next/staticx/a.css'],
    ['GET', '/_NEXT/static/a.css'],
    ['GET', '/_next/Static/a.css'],
    ['GET', '/_next/STATIC/a.css'],
    ['GET', '//_next/static/a.css'],
    ['GET', 'http://h/_next/static/a.css'],
    ['GET', '/_next/static/../../events/e-1'],
    ['GET', '/_next/static/a/../b.css'],
    ['GET', '/_next/static/a/..'],
    ['GET', '/_next/static/./a.css'],
    ['GET', '/_next/static/a/.'],
    ['GET', '/_next/static//a.css'],
    ['GET', '/_next/static/a//b.css'],
    ['GET', '/_next/static/a/'],
    ['GET', '/_next/static/%2e%2e/events/e-1'],
    ['GET', '/_next/static/a%2Fb.css'],
    ['GET', '/_next/static/a%20b.css'],
    ['GET', '/_next/static/a\\b.css'],
    ['GET', '/_next/static/..\\..\\events'],
    ['GET', '/x?/_next/static/a.css'],
    ['GET', '/_next/image?url=/_next/static/a.png'],
    ['GET', '/seed-color-mode.js'],
    ['GET', '/'],
    ['GET', '/my/tickets'],
    ['GET', ''],
    ['GET', undefined],
  ];
  for (const [m, u] of yes) assert.equal(front.isStaticAssetRequest(m, u), true, `${m} ${u}`);
  for (const [m, u] of no) assert.equal(front.isStaticAssetRequest(m, u), false, `${m} ${u}`);
});

test('BAT-177-r2 T2 위로 넘기는 accept-encoding: 정적 요청의 빈 글 아닌 손님 값만 글자 그대로, 그 밖은 identity', () => {
  assert.equal(typeof front.upstreamAcceptEncoding, 'function', 'upstreamAcceptEncoding을 내보내야 한다');
  const css = '/_next/static/chunks/a1.css?dpl=1';
  const cases = [
    [{ method: 'GET', url: css, headers: { 'accept-encoding': 'gzip, deflate, br' } }, 'gzip, deflate, br'],
    [{ method: 'HEAD', url: css, headers: { 'accept-encoding': 'br;q=1.0, gzip;q=0.8' } }, 'br;q=1.0, gzip;q=0.8'],
    [{ method: 'GET', url: css, headers: {} }, 'identity'],
    [{ method: 'GET', url: css, headers: { 'accept-encoding': '' } }, 'identity'],
    [{ method: 'GET', url: css, headers: { 'accept-encoding': ['gzip', 'br'] } }, 'identity'],
    [{ method: 'GET', url: '/my/tickets', headers: { 'accept-encoding': 'gzip' } }, 'identity'],
    [{ method: 'GET', url: '/', headers: { 'accept-encoding': 'gzip, br' } }, 'identity'],
    [{ method: 'POST', url: css, headers: { 'accept-encoding': 'gzip' } }, 'identity'],
    [{ method: 'GET', url: '/_next/static/../../my/tickets', headers: { 'accept-encoding': 'gzip' } }, 'identity'],
    [{ headers: { 'accept-encoding': 'gzip' } }, 'identity'],
  ];
  for (const [req, want] of cases) assert.equal(front.upstreamAcceptEncoding(req), want, JSON.stringify(req));
});

/**
 * Next.js 기본 압축처럼 받은 accept-encoding에 gzip이 있으면 gzip으로 주는 위 서버 처리기.
 * seen에 (메서드, 경로, 받은 accept-encoding)를, sent에 실제로 보낸 바이트를 남긴다.
 */
function compressingUpstream(seen, sent, respond) {
  return (req, res) => {
    req.resume();
    const ae = req.headers['accept-encoding'];
    seen.push({ method: req.method, url: req.url, ae });
    const { body, headers } = respond(req);
    const gz = typeof ae === 'string' && /\bgzip\b/.test(ae);
    const out = gz ? gzipSync(body) : Buffer.from(body);
    sent.push(out);
    res.writeHead(200, { ...headers, ...(gz ? { 'content-encoding': 'gzip' } : {}), vary: 'Accept-Encoding', 'content-length': String(out.length) });
    res.end(req.method === 'HEAD' ? undefined : out);
  };
}

test('BAT-177-r2 T3 정적 CSS는 손님 압축 요청을 위로 넘기고 gzip 바이트를 그대로 흘린다(HTML이 될 수 있는 경로는 identity)', async () => {
  const CSS = `.card-flat{display:grid;gap:8px}${'.w{color:#123456}'.repeat(200)}`;
  const seen = [];
  const sent = [];
  const p = await pair(compressingUpstream(seen, sent, () => ({ body: CSS, headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' } })));
  try {
    const gz = await p.get('/_next/static/chunks/a.css?dpl=1', { 'accept-encoding': 'gzip, br' });
    assert.deepEqual(seen.at(-1), { method: 'GET', url: '/_next/static/chunks/a.css?dpl=1', ae: 'gzip, br' });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'Accept-Encoding');
    assert.equal(gz.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(gz.headers['cache-control'], 'public, max-age=31536000, immutable');
    // 앞 서버는 풀거나 다시 싸지 않는다: 위 서버가 보낸 바이트와 같고, 풀면 원문이다
    assert.ok(gz.raw.length < Buffer.byteLength(CSS), `압축 본문 ${gz.raw.length}B는 원문 ${Buffer.byteLength(CSS)}B보다 작아야 한다`);
    assert.deepEqual(gz.raw, sent.at(-1));
    assert.equal(gz.headers['content-length'], String(gz.raw.length));
    assert.equal(gunzipSync(gz.raw).toString('utf8'), CSS);

    // HEAD도 넘긴다
    const head = await p.get('/_next/static/media/x.woff2', { 'accept-encoding': 'gzip' }, 'HEAD');
    assert.deepEqual(seen.at(-1), { method: 'HEAD', url: '/_next/static/media/x.woff2', ae: 'gzip' });
    assert.equal(head.headers['content-encoding'], 'gzip');

    // 손님이 압축을 청하지 않으면 지어 넣지 않는다
    const plain = await p.get('/_next/static/chunks/a.css?dpl=1');
    assert.deepEqual(seen.at(-1), { method: 'GET', url: '/_next/static/chunks/a.css?dpl=1', ae: 'identity' });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body, CSS);

    // HTML이 될 수 있는 경로(화면·public·이미지·접두만 닮은 것)는 손님이 gzip을 받아도 위 서버에 identity
    for (const path of ['/my/tickets', '/', '/seed-color-mode.js', '/_next/image?url=/_next/static/a.png', '/_next/staticx/a.css']) {
      const r = await p.get(path, { 'accept-encoding': 'gzip, br' });
      assert.deepEqual(seen.at(-1), { method: 'GET', url: path, ae: 'identity' }, path);
      assert.equal(r.headers['content-encoding'], undefined, path);
    }
    assert.equal(seen.length, 8);
  } finally {
    await p.close();
  }
});

test('BAT-177-r2 T4 HTML 경로는 그대로 해시를 받고, 정적 경로의 HTML+틀은 해시 없는 막는 CSP다', async () => {
  const seen = [];
  const sent = [];
  const p = await pair(
    compressingUpstream(seen, sent, () => ({ body: HTML, headers: { 'content-type': 'text/html; charset=utf-8', [CSP_TEMPLATE_HEADER]: TEMPLATE, 'content-security-policy-report-only': 'x' } })),
  );
  const hashed = TEMPLATE.replace(HASH_SENTINEL, [sha(FLIGHT0), sha(TURBO), sha(FLIGHT1)].join(' '));
  const noHash = TEMPLATE.replace(` ${HASH_SENTINEL}`, '');
  try {
    // ① 화면 경로: 손님이 gzip, br을 받아도 위 서버는 identity를 받고, 압축 전 본문으로 해시를 채운다(회귀)
    const page = await p.get('/events/e-1', { 'accept-encoding': 'gzip, br' });
    assert.deepEqual(seen.at(-1), { method: 'GET', url: '/events/e-1', ae: 'identity' });
    assert.equal(page.headers['content-encoding'], undefined);
    assert.equal(page.body, HTML);
    assert.equal(page.headers['content-security-policy'], hashed);
    assert.equal(page.headers[CSP_TEMPLATE_HEADER], undefined);

    // ② 정적 경로인데 위 서버가 틀 머리를 단 HTML을 gzip으로 주면: 해시 없는 막는 CSP, 안쪽 머리·보고 모드는 지운다(닫힘 실패)
    const odd = await p.get('/_next/static/x.html', { 'accept-encoding': 'gzip' });
    assert.deepEqual(seen.at(-1), { method: 'GET', url: '/_next/static/x.html', ae: 'gzip' });
    assert.equal(odd.headers['content-encoding'], 'gzip');
    assert.equal(odd.headers['content-security-policy'], noHash);
    assert.equal(odd.headers[CSP_TEMPLATE_HEADER], undefined);
    assert.equal(odd.headers['content-security-policy-report-only'], undefined);
    assert.deepEqual(odd.raw, sent.at(-1));
    assert.equal(gunzipSync(odd.raw).toString('utf8'), HTML);

    // ③ 같은 정적 경로라도 POST는 identity를 받고 해시를 채운다(회귀)
    const post = await p.get('/_next/static/x.html', { 'accept-encoding': 'gzip', 'content-type': 'application/x-www-form-urlencoded' }, 'POST', 'a=1');
    assert.deepEqual(seen.at(-1), { method: 'POST', url: '/_next/static/x.html', ae: 'identity' });
    assert.equal(post.headers['content-encoding'], undefined);
    assert.equal(post.headers['content-security-policy'], hashed);
    assert.equal(seen.length, 3);
  } finally {
    await p.close();
  }
});
