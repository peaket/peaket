// 모의 본인확인기관(docs/features/identity.md §5 '모의 기관과 기관 창 흐름', BUILD_ORDER BOT-010, I-T45). local·ci 전용 시험 서버다.
// 실제 기관 없이 기관 창 흐름(팝업·페이지 이동·POST 본문 복귀·쿼리 복귀)을 끝까지 돌리려고, 공개된 연동 방식을 흉내 낸다.
// - POST /verify(기관 창 양식, 칸 verificationId): 결과를 고르는 '모의 본인확인기관' 화면을 그린다
// - POST /verify/complete(그 화면의 버튼): 서명한 결과 값(verificationId·result·mac)을 돌아올 주소로 보낸다.
//   POST 본문이면 스스로 제출되는 양식, 쿼리면 303 이동이다
// - 돌아올 주소는 시작할 때 받는다(실제 기관에 미리 등록하는 것과 같다). 브라우저가 고칠 수 있는 칸에는 싣지 않는다
// - 127.0.0.1에만 묶고, Host가 루프백 이름이 아니면 421(DNS 리바인딩)
// - 결과 값 형식은 시험 어댑터(src/modules/verification/adapters/test-agency.ts)와 같다. 바깥 기관이라 따로 구현하고, 시험이 두 쪽이 맞는지 본다
// 실행: PEAKET_ENV=local PEAKET_TEST_VERIFICATION_RETURN_URL=http://localhost:3000/verify/return node scripts/mock-idv.mjs [포트]
//   비밀은 PEAKET_TEST_VERIFICATION_SECRET(base64, identity-svc와 같은 값), 없으면 개발용 값
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const LABEL = 'peaket-test-idv-result:v1:';
const DEV_SECRET = 'peaket-test-verification-secret-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIRTH = /^\d{4}-\d{2}-\d{2}$/;
const ACTIONS = /** @type {const} */ ({ complete: 'VERIFIED', cancel: 'CANCELLED', fail: 'FAILED', down: 'DOWN' });
const MAX_BODY = 8 * 1024;

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * 결과 본문을 봉한다(시험 어댑터의 sealTestAgencyResult와 같은 형식)
 * @param {Uint8Array} secret
 * @param {{ v: 1, tx: string, outcome: string, person?: string, birth?: string, iat: number }} body
 */
export function sealResult(secret, body) {
  const result = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return { verificationId: body.tx, result, mac: createHmac('sha256', secret).update(LABEL + result).digest('base64url') };
}

/**
 * @param {number} status
 * @param {string} body
 * @param {Record<string, string>} [headers]
 */
const html = (status, body, headers = {}) => ({ status, body, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

/** 결과를 고르는 화면 @param {string} id @param {string} nonce */
function choosePage(id, nonce) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>모의 본인확인기관</title><style nonce="${nonce}">body{font-family:system-ui,sans-serif;margin:0;padding:24px;max-width:420px}h1{font-size:20px}
label{display:block;margin:12px 0 4px;font-size:14px}input[type=text],input[type=date]{width:100%;padding:8px;font-size:16px;box-sizing:border-box}
fieldset{margin:16px 0;border:1px solid #ccc;padding:8px 12px}.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
button{padding:10px 14px;font-size:15px}.note{color:#555;font-size:13px}</style></head><body>
<h1>모의 본인확인기관</h1>
<p class="note">시험용 기관 화면입니다. 실제 본인확인을 하지 않습니다(PEAKET 로컬·CI 전용).</p>
<form method="post" action="/verify/complete">
<input type="hidden" name="verificationId" value="${esc(id)}">
<label for="person">시험 사람 이름표(같은 이름표는 같은 사람)</label>
<input type="text" id="person" name="person" value="tester-1" maxlength="64" autocomplete="off">
<label for="birth">생년월일</label>
<input type="date" id="birth" name="birth" value="2000-01-01">
<fieldset><legend>돌려주는 방식</legend>
<label><input type="radio" name="returnStyle" value="post" checked> POST 본문으로 돌려주기</label>
<label><input type="radio" name="returnStyle" value="query"> 쿼리로 돌려주기</label>
</fieldset>
<div class="row">
<button type="submit" name="action" value="complete">본인확인 완료</button>
<button type="submit" name="action" value="cancel">취소</button>
<button type="submit" name="action" value="fail">실패</button>
<button type="submit" name="action" value="down">기관 장애</button>
</div></form></body></html>`;
}

/** 돌아올 주소로 스스로 제출되는 양식 @param {string} action @param {Record<string, string>} fields @param {string} nonce */
function autoSubmitPage(action, fields, nonce) {
  const inputs = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>모의 본인확인기관</title></head><body>
<form method="post" action="${esc(action)}">
${inputs}
<noscript><button type="submit">돌아가기</button></noscript>
</form>
<script nonce="${nonce}">document.forms[0].submit();</script>
</body></html>`;
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<URLSearchParams | null>} */
async function formOf(req) {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return null;
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) return null;
    chunks.push(c);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 모의 기관을 띄운다
 * @param {{ port?: number, returnUrl: string, secret?: Uint8Array, env?: Record<string, string | undefined>, now?: () => number }} o
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startMockIdv(o) {
  const peaketEnv = o.env?.PEAKET_ENV;
  if (peaketEnv !== 'local' && peaketEnv !== 'ci') throw new Error(`모의 기관은 PEAKET_ENV가 local·ci일 때만 돈다(지금 ${peaketEnv ?? '없음'})`);
  const ret = new URL(o.returnUrl);
  if (ret.protocol !== 'http:' && ret.protocol !== 'https:') throw new Error(`돌아올 주소는 http·https만 받는다: ${o.returnUrl}`);
  const returnUrl = ret.toString();
  const secret = o.secret ?? Buffer.from(DEV_SECRET);
  const now = o.now ?? Date.now;

  /** @type {number} */
  let boundPort = 0;

  /** @param {import('node:http').IncomingMessage} req */
  async function handle(req) {
    // DNS 리바인딩: 루프백 이름으로 온 요청만 받는다(게이트웨이 대역과 같다)
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) return html(421, '<!doctype html><p>Misdirected Request</p>', { 'cache-control': 'no-store' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const nonce = randomBytes(16).toString('base64');
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self' ${ret.origin}; base-uri 'none'; frame-ancestors 'none'`;
    const common = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': csp };
    if (req.method !== 'POST') return html(405, '<!doctype html><p>POST만 받는다</p>', { ...common, allow: 'POST' });
    const f = await formOf(req);
    if (!f) return html(400, '<!doctype html><p>양식이 틀렸다</p>', common);
    const id = f.get('verificationId') ?? '';
    if (!UUID.test(id)) return html(400, '<!doctype html><p>건 ID가 틀렸다</p>', common);
    if (url.pathname === '/verify') return html(200, choosePage(id, nonce), common);
    if (url.pathname !== '/verify/complete') return html(404, '<!doctype html><p>없는 주소</p>', common);
    const action = f.get('action') ?? '';
    const outcome = Object.hasOwn(ACTIONS, action) ? ACTIONS[/** @type {keyof typeof ACTIONS} */ (action)] : undefined;
    const style = f.get('returnStyle') ?? 'post';
    const person = f.get('person') ?? '';
    const birth = f.get('birth') ?? '';
    if (!outcome || (style !== 'post' && style !== 'query') || person.length > 64 || (birth !== '' && !BIRTH.test(birth))) return html(400, '<!doctype html><p>고른 값이 틀렸다</p>', common);
    if (outcome === 'VERIFIED' && person.length === 0) return html(400, '<!doctype html><p>이름표를 적어 주세요</p>', common);
    /** @type {{ v: 1, tx: string, outcome: string, person?: string, birth?: string, iat: number }} */
    const body = { v: 1, tx: id, outcome, iat: now() };
    if (outcome === 'VERIFIED') {
      body.person = person;
      if (birth) body.birth = birth;
    }
    const sealed = sealResult(secret, body);
    if (style === 'query') {
      const to = new URL(returnUrl);
      for (const [k, v] of Object.entries(sealed)) to.searchParams.set(k, v);
      return { status: 303, body: '', headers: { ...common, location: to.toString() } };
    }
    return html(200, autoSubmitPage(returnUrl, sealed, nonce), common);
  }

  const server = createServer((req, res) => {
    handle(req).then(
      (out) => {
        res.writeHead(out.status, out.headers);
        res.end(out.body);
      },
      () => {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('모의 기관 오류');
      },
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '127.0.0.1', () => resolve(undefined));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('주소를 얻지 못했다');
  boundPort = addr.port;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const returnUrl = process.env.PEAKET_TEST_VERIFICATION_RETURN_URL;
  if (!returnUrl) throw new Error('PEAKET_TEST_VERIFICATION_RETURN_URL이 없다(예: http://localhost:3000/verify/return)');
  const raw = process.env.PEAKET_TEST_VERIFICATION_SECRET;
  const started = await startMockIdv({
    port: Number(process.argv[2] ?? 18920),
    returnUrl,
    secret: raw ? Buffer.from(raw, 'base64') : undefined,
    env: process.env,
  });
  // identity-svc의 PEAKET_TEST_VERIFICATION_URL에 이 값을 넣는다
  console.log(`모의 기관: ${started.url}/verify (돌아올 주소 ${returnUrl})`);
}
