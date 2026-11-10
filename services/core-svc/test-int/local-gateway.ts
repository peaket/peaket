// 로컬 파트너 스택의 게이트웨이 대역(ADR-0264 결정 14). 시험 폴더에만 있고 운영 빌드에 들지 않는다.
// 파트너 콘솔 출처의 요청만 받아(CORS, 자격 증명 허용) /v1/partner/ 경로를 core-svc로 넘기고, 쿠키 local_as=admin|member로 시험 계정 둘의 내부 신원 머리를 단다.
// 대역 조작(/__local/…: 계정 바꾸기·파일 목록·멈추기)은 띄울 때 만든 열쇠(?key=, 정보 파일에만 적는다)가 맞을 때만 받고, 열쇠를 보기 전에는 상태를 바꾸지 않는다.
// Origin이 없는 API 요청(다른 프로그램·주소창·같은 PC의 다른 쪽)은 관리자 신원으로 넘기지 않고 거절한다.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface GatewayOptions {
  partnerOrigin: string;
  /** 넘길 곳(core-svc HTTP) */
  upstream: string;
  identity: { admin: Record<string, string>; member: Record<string, string> };
  /** 대역 조작(/__local/…)을 받기 위한 열쇠 */
  key: string;
  onStop: () => void;
  listFiles: () => Promise<string[]>;
  fetch?: typeof fetch;
}

const SAFE_HEADERS = ['content-type', 'etag', 'retry-after', 'cache-control', 'date'];
const FORWARD_HEADERS = ['content-type', 'if-match', 'x-requested-with', 'idempotency-key'];

/** 같은 길이로 견준다(열쇠를 한 글자씩 맞혀 보지 못하게) */
function sameKey(given: string | null, key: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 답을 한 번만 쓴다(이미 머리를 보냈으면 연결만 끊는다) */
function send(res: ServerResponse, status: number, headers: Record<string, string> = {}, body?: string | Buffer): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

export function gatewayHandler(o: GatewayOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const doFetch = o.fetch ?? fetch;
  const cors = (res: ServerResponse) => {
    res.setHeader('access-control-allow-origin', o.partnerOrigin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-expose-headers', 'ETag, Retry-After');
    res.setHeader('vary', 'Origin');
  };
  const roleOf = (req: IncomingMessage) => (/(?:^|;\s*)local_as=member(?:;|$)/.test(req.headers.cookie ?? '') ? 'member' : 'admin');
  const text = { 'content-type': 'text/plain; charset=utf-8' };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/__local/')) {
      // 열쇠를 먼저 본다. 틀리면 아무것도 바꾸지 않는다
      if (!sameKey(url.searchParams.get('key'), o.key)) return send(res, 403, text, '열쇠가 맞지 않는다\n');
      if (url.pathname === '/__local/as') {
        const role = url.searchParams.get('role') === 'member' ? 'member' : 'admin';
        return send(res, 200, { ...text, 'set-cookie': `local_as=${role}; Path=/; SameSite=Lax; HttpOnly` }, `시험 계정: 파트너 ${role === 'member' ? '실무자' : '관리자'}\n`);
      }
      if (url.pathname === '/__local/stop') {
        send(res, 200, text, '멈춘다\n');
        o.onStop();
        return;
      }
      if (url.pathname === '/__local/files') return send(res, 200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(await o.listFiles(), null, 2));
      return send(res, 404, text);
    }
    // 파트너 콘솔 출처만 받는다(Origin 없음도 거절: 쿠키 없이도 관리자 신원이 붙으므로)
    if (req.headers.origin !== o.partnerOrigin) return send(res, 403);
    cors(res);
    if (req.method === 'OPTIONS') {
      return send(res, 204, { 'access-control-allow-methods': 'GET, PUT, POST, PATCH, DELETE', 'access-control-allow-headers': 'content-type, if-match, x-requested-with, idempotency-key', 'access-control-max-age': '600' });
    }
    if (!url.pathname.startsWith('/v1/partner/')) return send(res, 404, { 'content-type': 'application/problem+json' }, JSON.stringify({ type: 'https://peaket.example/problems/not-found', status: 404 }));
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    // 보낸 신원 머리는 버리고 대역 계정 머리만 단다
    const headers: Record<string, string> = { ...(roleOf(req) === 'member' ? o.identity.member : o.identity.admin) };
    for (const k of FORWARD_HEADERS) {
      const v = req.headers[k];
      if (typeof v === 'string') headers[k] = v;
    }
    const upstream = await doFetch(`${o.upstream}${url.pathname}${url.search}`, { method: req.method ?? 'GET', headers, ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}) });
    const out: Record<string, string> = {};
    for (const k of SAFE_HEADERS) {
      const v = upstream.headers.get(k);
      if (v !== null) out[k] = v;
    }
    send(res, upstream.status, out, Buffer.from(await upstream.arrayBuffer()));
  };
  return async (req, res) => {
    try {
      await handle(req, res);
    } catch {
      // 넘길 곳이 죽었거나 요청이 끊겼다: 머리를 두 번 쓰지 않는다
      send(res, 502, text, '넘기지 못했다\n');
    }
  };
}
