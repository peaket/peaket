// 소비자 웹 앞의 얇은 서버: 캐시 화면(묶음 A)의 CSP에 응답 때 인라인 스크립트 해시를 채운다
// (소유자 결정 2026-11-04 '응답 때 해시', ADR-0193, docs/frontend.md §5.14.1, BUILD_ORDER HOT-290).
// - Next.js의 해시 방식(SRI)은 외부 스크립트에만 integrity를 달고, App Router가 HTML에 넣는 인라인 스크립트(화면 데이터 등)는
//   덮지 못한다(SRI PoC, tools/web-checks/csp/web.spec.mjs). 그 내용은 화면과 재생성마다 달라 빌드 때 해시를 정할 수 없다.
// - 정책 문자열은 proxy.ts가 packages/config/headers/security-headers.mjs 한 곳에서 만들어 안쪽 머리 x-peaket-csp-template에
//   해시 자리(HASH_SENTINEL)를 넣어 보낸다. 이 서버는 그 머리가 있는 HTML 응답만 끝까지 모아 해시를 채워 막는 CSP로 단다.
//   CDN은 본문과 그 CSP를 함께 캐시하므로 둘이 어긋나지 않는다. 그 밖의 응답은 그대로 흘려 보낸다.
// - 모은 HTML에 화면이 그린 상태 표시(404·410)가 있으면 상태 코드를 맞춘다(ADR-0201, markedStatus).
// - 해시는 Next.js·React가 넣는 모양의 인라인 스크립트에만 낸다(isFrameworkScript). HTML에 끼워 넣은 스크립트는 모양을 흉내 내도
//   해시를 받지 못해 막힌다(새 맥락 리뷰 2026-11-04: 모든 인라인 스크립트를 해시하면 주입된 스크립트도 허용 목록에 든다).
//   React 스트리밍 도우미 정의는 설치된 Next.js 운영 실행 파일에서 글자 그대로 읽은 것(reactRuntimeScripts)과 같아야 한다.
// - 해시는 압축 전 본문으로 내므로 위 서버(Next.js)에는 압축하지 말라고 보낸다(압축은 CDN이 한다).
// - 노드 기본 모듈만 쓴다(운영 이미지에서 Next.js standalone 서버 앞에 그대로 둔다).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CSP_TEMPLATE_HEADER, HASH_SENTINEL } from './csp-template.mjs';

export { CSP_TEMPLATE_HEADER, HASH_SENTINEL };

/** 해시를 낼 HTML 크기 상한 [가정]. 넘으면 해시 없이 막는 CSP로 그대로 흘려 보낸다(보호를 풀지 않고 메모리에 쌓지 않는다) */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

/** 실행되는 스크립트 종류(type 없음·자바스크립트·module). application/json 같은 데이터 블록은 CSP가 보지 않는다 */
const EXECUTABLE = /^(?:|text\/javascript|application\/javascript|module)$/i;

const FLIGHT_INIT = '(self.__next_f=self.__next_f||[]).push([0])';
const TURBOPACK_HEAD = '(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push(';

/** JSON 값이 문자열·숫자·null과 그것들의 배열로만 되어 있는가(함수·객체를 만들지 못하는 데이터) */
function plainData(v) {
  if (v === null || typeof v === 'string' || typeof v === 'number') return true;
  return Array.isArray(v) && v.every(plainData);
}

/** `$Rxx(인자…)`: React 스트리밍 도우미 부르기. 인자는 데이터(문자열·숫자·null·배열)만 */
function reactCall(s) {
  const m = /^\$R[A-Z]{1,2}\(([\s\S]*)\);?$/.exec(s);
  if (!m) return false;
  try {
    return plainData(JSON.parse(`[${m[1]}]`));
  } catch {
    return false;
  }
}

/** Next.js·React가 HTML에 넣는 인라인 스크립트인가(모양과 데이터를 엄격히 본다) */
export function isFrameworkScript(content, runtime = []) {
  if (content === FLIGHT_INIT) return true;
  // 화면 데이터: self.__next_f.push([종류 번호, "JSON 문자열"])
  const flight = /^self\.__next_f\.push\((\[[\s\S]*\])\)$/.exec(content);
  if (flight) {
    try {
      const a = JSON.parse(flight[1]);
      return Array.isArray(a) && a.length === 2 && Number.isInteger(a[0]) && typeof a[1] === 'string';
    } catch {
      return false;
    }
  }
  // Turbopack 시작 코드: 이 앱의 덩어리 경로와 모듈 번호만
  if (content.startsWith(TURBOPACK_HEAD) && /\);?$/.test(content)) {
    try {
      const o = JSON.parse(content.slice(TURBOPACK_HEAD.length).replace(/\);?$/, ''));
      const keys = Object.keys(o);
      return (
        keys.every((k) => k === 'otherChunks' || k === 'runtimeModuleIds') &&
        (o.otherChunks ?? []).every((c) => typeof c === 'string' && /^static\/chunks\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(c)) &&
        (o.runtimeModuleIds ?? []).every((n) => Number.isInteger(n))
      );
    } catch {
      return false;
    }
  }
  // React 스트리밍 도우미: 알려진 정의(설치된 Next.js 실행 파일과 글자까지 같음)를 앞에서 떼어 낸 뒤, 남은 것은 없거나 부르기 하나
  let rest = content;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const d of runtime) {
      if (d && rest.startsWith(d)) {
        rest = rest.slice(d.length);
        stripped = true;
      }
    }
  }
  if (rest !== content) return rest === '' || reactCall(rest);
  return reactCall(content);
}

/** HTML의 실행되는 인라인 스크립트 가운데 Next.js·React 모양인 것마다 'sha256-…'(나온 차례, 같은 것은 한 번) */
export function inlineScriptHashes(html, runtime = []) {
  const out = [];
  // 속성 값 안의 >를 꼬리표 끝으로 보지 않게 따옴표를 인정한다(CodeQL js/bad-tag-filter). 끝 꼬리표는 이름 뒤에 공백·속성이 와도 받는다
  for (const m of html.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {
    const attrs = m[1];
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const type = /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (type && !EXECUTABLE.test((type[1] ?? type[2] ?? type[3] ?? '').trim())) continue;
    if (!isFrameworkScript(m[2], runtime)) continue;
    const h = `'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`;
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/** 자바스크립트 문자열 리터럴 본문(따옴표 안)을 푼다: \n \t \r \\ \' \" \xHH \uHHHH \u{…} */
function decodeJsString(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    if (e.startsWith('u{')) return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if (e[0] === 'u' && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }[e] ?? e;
  });
}

/**
 * 설치된 Next.js 운영 실행 파일(next/dist/compiled/next-server/app-page*.runtime.prod.js)에서 React 스트리밍 도우미 정의 문자열을 읽는다.
 * `$RS=function…`·`$RB=[];$RV=…`·`$RX=…`·`$RM=new Map;$RR=…`·`requestAnimationFrame(function(){$RT=…})` 같은 문자열 상수다.
 * @param {string | URL} appDir 소비자 웹 앱 폴더(next를 이 폴더 기준으로 찾는다)
 */
export function reactRuntimeScripts(appDir) {
  const dir = appDir instanceof URL ? fileURLToPath(appDir) : appDir;
  const nextDir = dirname(createRequire(join(dir, 'package.json')).resolve('next/package.json'));
  const serverDir = join(nextDir, 'dist', 'compiled', 'next-server');
  const out = new Set();
  for (const f of readdirSync(serverDir).filter((n) => /^app-page.*\.runtime\.prod\.js$/.test(n))) {
    const s = readFileSync(join(serverDir, f), 'utf8');
    for (const m of s.matchAll(/(['"])(?=\$R[A-Z][A-Za-z]?=|requestAnimationFrame\(function\(\)\{\$RT=)/g)) {
      const q = m[1];
      let i = m.index + 1;
      let raw = '';
      for (; i < s.length && s[i] !== q; i++) {
        if (s[i] === '\\') {
          raw += s[i] + s[i + 1];
          i++;
        } else raw += s[i];
      }
      // React는 정의 끝에 부르기 앞머리($RS(" 같은 것)를 붙여 두고 인자를 이어 쓴다. 정의만 남긴다
      const v = decodeJsString(raw).replace(/\$R[A-Z]{1,2}\("$/, '');
      if (/(?:=function\(|=\[\];|=new Map;|requestAnimationFrame\(function)/.test(v)) out.add(v);
    }
    // 메타데이터를 흘려 보낼 때 아이콘 링크를 head로 옮기는 스크립트(템플릿 글 안의 <script>…</script>)
    // (`<script${nonce}>…</script>`꼴이라 여는 태그 끝 > 뒤부터 </script> 앞까지를 읽는다)
    for (const m of s.matchAll(/>(document\.querySelectorAll\('body link\[rel="icon"\][^<]*)<\/script>/g)) out.add(m[1]);
  }
  // 긴 정의부터 맞춘다(짧은 정의가 긴 정의의 앞머리일 때)
  return [...out].sort((a, b) => b.length - a.length);
}

const fill = (template, hashes) => (hashes.length ? template.replace(HASH_SENTINEL, hashes.join(' ')) : template.replace(` ${HASH_SENTINEL}`, ''));

/** 위 서버 응답 머리를 그대로 옮기되 뺄 머리를 뺀다 */
function copyHeaders(upstream, drop) {
  const h = {};
  for (const [k, v] of Object.entries(upstream)) if (v !== undefined && !drop.includes(k)) h[k] = v;
  return h;
}

const CSP_INTERNAL = [CSP_TEMPLATE_HEADER, 'content-security-policy-report-only'];

/**
 * 화면이 그린 상태 표시(ADR-0201): 캐시 화면은 Cache Components가 본문을 먼저 흘려 응답 상태를 바꾸지 못한다. 그래서 not-found 화면은 404,
 * 공연 상세의 판매 중지 안내는 410 표시 태그를 그리고, 이 서버가 모은 HTML에서 처음 나온 태그를 읽어 상태를 맞춘다.
 * 화면 글은 이 태그를 만들 수 없다(본문 글은 React가 <를 바꿔 쓰고, 인라인 화면 데이터는 Next.js가 <로 싣는다).
 */
const STATUS_MARK = /<meta name="peaket-status" content="(\d{3})"\s*\/?>/;
const MARKED_STATUS = new Set([404, 410]);
/** 표시로 바꾼 응답의 캐시 [가정]: 공개가 시작되거나 판매가 다시 열리면 1분 안에 보이게, CDN도 같은 시간만 담는다 */
export const MARKED_CACHE_CONTROL = 'public, max-age=60';

/** 위 서버가 200일 때만, 허용한 표시 값이면 그 상태 */
export function markedStatus(html, upstreamStatus) {
  if (upstreamStatus !== 200) return undefined;
  const m = STATUS_MARK.exec(html);
  const code = m ? Number(m[1]) : undefined;
  return code !== undefined && MARKED_STATUS.has(code) ? code : undefined;
}

/**
 * @param {{ upstream: string, runtime?: string[] }} o upstream: Next.js 서버 주소(예: http://127.0.0.1:3001). runtime: reactRuntimeScripts 결과
 */
export function createCspHashServer({ upstream, runtime = [] }) {
  const base = new URL(upstream);
  return createServer((req, res) => {
    const headers = { ...req.headers, 'accept-encoding': 'identity', 'x-forwarded-host': req.headers['x-forwarded-host'] ?? req.headers.host ?? '' };
    const up = httpRequest({ host: base.hostname, port: base.port, method: req.method, path: req.url, headers }, (ur) => {
      // 손님이 이미 떠났으면 받지 않는다(닫힌 응답에 잇다가 예외로 프로세스가 죽던 결함, HOT-290 확인 리뷰 뒤 재현 시험)
      if (res.destroyed || res.writableEnded) {
        ur.destroy();
        return;
      }
      const template = ur.headers[CSP_TEMPLATE_HEADER];
      const html = /^text\/html\b/i.test(String(ur.headers['content-type'] ?? ''));
      if (typeof template !== 'string' || !html || req.method === 'HEAD' || ur.statusCode === 304) {
        // 틀이 없으면 그대로, 틀이 있어도 HTML 본문이 없거나(304·HEAD) HTML이 아니면(화면 데이터 RSC 등) CSP 안쪽 머리만 뺀다
        res.writeHead(ur.statusCode ?? 502, typeof template === 'string' ? copyHeaders(ur.headers, CSP_INTERNAL) : ur.headers);
        pipeline(ur, res, () => {});
        return;
      }
      const chunks = [];
      let size = 0;
      let streaming = false;
      const encoded = Boolean(ur.headers['content-encoding']) && ur.headers['content-encoding'] !== 'identity';
      const onData = (c) => {
        size += c.length;
        chunks.push(c);
        if (size > MAX_HTML_BYTES || encoded) {
          // 해시를 낼 수 없는 본문: 해시 없이 막는 CSP로 머리를 쓰고 모아 둔 것을 내보낸 뒤 나머지는 흘려 보낸다
          streaming = true;
          ur.off('data', onData);
          ur.off('end', onEnd);
          if (res.destroyed) return ur.destroy();
          const out = copyHeaders(ur.headers, [...CSP_INTERNAL, 'content-length']);
          out['content-security-policy'] = fill(template, []);
          res.writeHead(ur.statusCode ?? 200, out);
          for (const x of chunks) res.write(x);
          chunks.length = 0;
          pipeline(ur, res, () => {});
        }
      };
      const onEnd = () => {
        if (streaming) return;
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        const out = copyHeaders(ur.headers, [...CSP_INTERNAL, 'content-length', 'transfer-encoding']);
        out['content-security-policy'] = fill(template, inlineScriptHashes(text, runtime));
        out['content-length'] = String(body.length);
        const marked = markedStatus(text, ur.statusCode);
        if (marked) out['cache-control'] = MARKED_CACHE_CONTROL;
        res.writeHead(marked ?? ur.statusCode ?? 200, out);
        res.end(body);
      };
      ur.on('data', onData);
      ur.on('end', onEnd);
      // 본문 도중 위 서버가 끊으면: 머리를 아직 안 썼으면 502, 썼으면 손님 응답도 끊는다
      const broken = () => {
        if (res.headersSent) return res.destroy();
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('위 서버 응답이 끊겼습니다');
      };
      ur.on('aborted', broken);
      ur.on('error', broken);
    });
    up.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('위 서버에 닿지 못했습니다');
      } else res.destroy();
    });
    // 손님이 응답을 다 받기 전에 끊으면(요청 도중이든 답을 기다리는 중이든) 위 서버 요청·응답도 끊는다
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    pipeline(req, up, () => {});
  });
}
