// 관제 API 로컬 넘김(local·ci 전용 시험 도구, ADR-0360 결정 12). 로컬에는 gw-ops(Envoy)가 없어, 콘솔 개발·미리보기 서버가
// 같은 출처의 /v1/ops/ 요청을 실제 ops-svc 앱 포트로 넘긴다. SSE 흐름 둘도 그대로 흘려보낸다(버퍼에 모으지 않는다).
// - PEAKET_OPS_PROXY_TARGET(예: http://127.0.0.1:3000)이 없으면 켜지 않는다. PEAKET_ENV가 local·ci가 아니면 켜지 않는다
// - 바깥 요청의 신원 머리(x-user-*·x-session-id, 밑줄 이름 포함)와 게이트웨이가 정하는 머리(x-peaket-*·x-forwarded-*)는 늘 지운다
// - PEAKET_OPS_DEV_IDENTITY=<관리 계정 ID>:<세션 ID>를 주면 그 신원 머리를 싣는다(gw-ops의 JWT → 머리 바꾸기 대역. ops-svc가 identity에 역할을 묻는다)
// 운영의 인증·CORS·Origin 확인은 gw-ops가 한다(deploy/gateways/gw-ops.yaml). 이 대역은 그것을 흉내 내지 않는다.
import { request as httpRequest } from 'node:http';

const IDENTITY_HEADER = /^x[-_]user[-_]|^x[-_]session[-_]id$/i;
const GATEWAY_OWNED = /^(x[-_]peaket[-_]|x[-_]forwarded[-_]|forwarded$|x[-_]real[-_]ip$)/i;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 환경 값으로 넘김 처리기를 만든다. 켜지 않으면 undefined
 * @param {Record<string, string | undefined>} env
 * @returns {((req: import('node:http').IncomingMessage & { originalUrl?: string }, res: import('node:http').ServerResponse, next?: () => void) => void) | undefined}
 */
export function opsProxyMiddleware(env) {
  const target = env.PEAKET_OPS_PROXY_TARGET?.trim();
  if (!target) return undefined;
  const peaketEnv = env.PEAKET_ENV ?? 'local';
  if (peaketEnv !== 'local' && peaketEnv !== 'ci') throw new Error(`관제 API 로컬 넘김은 local·ci 전용이다(PEAKET_ENV=${peaketEnv})`);
  const base = new URL(target);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error(`넘길 곳은 루프백 http 주소여야 한다: ${target}`);
  let identity;
  if (env.PEAKET_OPS_DEV_IDENTITY) {
    const [accountId, sessionId] = env.PEAKET_OPS_DEV_IDENTITY.split(':');
    if (!UUID.test(accountId ?? '') || !UUID.test(sessionId ?? '')) throw new Error('PEAKET_OPS_DEV_IDENTITY는 <관리 계정 UUID>:<세션 UUID>다');
    identity = { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'ops', 'x-user-scope': '' };
  }
  return (req, res) => {
    const url = req.originalUrl ?? req.url ?? '/';
    if (!url.startsWith('/v1/ops/') && url !== '/v1/ops') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP.has(k) || IDENTITY_HEADER.test(k) || GATEWAY_OWNED.test(k)) continue;
      headers[k] = v;
    }
    Object.assign(headers, identity ?? {}, { 'x-peaket-app': 'console' });
    const up = httpRequest({ host: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || 80, method: req.method, path: url, headers }, (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !HOP.has(k)) out[k] = v;
      res.writeHead(r.statusCode ?? 502, out);
      // SSE는 조각마다 바로 내보낸다
      r.on('data', (c) => res.write(c));
      r.on('end', () => res.end());
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/problem+json' });
      res.end('{"type":"https://peaket.example/problems/upstream-unavailable","title":"관제 API에 닿지 못했습니다","status":502}');
    });
    // 브라우저가 끊으면 위로도 끊는다(SSE 흐름 닫힘)
    res.on('close', () => up.destroy());
    req.pipe(up);
  };
}
