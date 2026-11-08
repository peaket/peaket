import cf from 'cloudfront';
import crypto from 'crypto';
// 대기열 API 배포의 진입 경로(POST /v1/queues/{eventId}/entries) 시청자 요청 함수(CloudFront Functions 런타임 2.0, ADR-0219·ADR-0223).
// 저장소는 읽기만 한다. 키: sale:{회차 ID}, mode:entry, arr:cur, arr:key:{kid}
// import·Buffer·createHmac 꼴은 AWS의 런타임 2.0 예제와 같다. 실제 CloudFront에서는 돌려 보지 못했다(Q-T56, BUILD_ORDER HOT-012)
const kvs = cf.kvs();

var WEB_ORIGIN = 'https://www.peaket.example'; // 배포 때 환경마다 바꾼다
var ENTRY = /^\/v1\/queues\/([A-Za-z0-9_-]{1,64})\/entries$/;
var COOKIE = '__Host-peaket_arr';
var ACCESS_COOKIE = '__Secure-peaket_at';
var UNSIGNED_HEADER = 'x-peaket-arrival';
var TTL_MS = 600000;
var FUTURE_MS = 5000;
var KIND = 'PEAKET-arrival-v1';
var ID = /^[A-Za-z0-9_-]{1,64}$/;
var KID = /^[A-Za-z0-9_-]{1,32}$/;
var NUM = /^[0-9]{1,15}$/;
var BEARER = /^Bearer\s+(\S+)$/i;

function problem(status, type, title, retryAfter, cookie) {
  var headers = {
    'content-type': { value: 'application/problem+json' },
    'cache-control': { value: 'no-store' },
    'x-content-type-options': { value: 'nosniff' },
    'access-control-allow-origin': { value: WEB_ORIGIN },
    'access-control-allow-credentials': { value: 'true' },
    'access-control-expose-headers': { value: 'Retry-After, Date' },
    vary: { value: 'Origin' },
  };
  if (retryAfter !== undefined) headers['retry-after'] = { value: String(retryAfter) };
  var res = {
    statusCode: status,
    headers: headers,
    body: { encoding: 'text', data: JSON.stringify({ type: 'https://peaket.example/problems/' + type, title: title, status: status }) },
  };
  if (cookie) res.cookies = cookie;
  return res;
}

function macOf(key, signed) {
  return crypto.createHmac('sha256', key).update(KIND + '.' + signed).digest('base64url');
}

// 일찍 끝나지 않게 끝까지 견준다
function same(a, b) {
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r = r | (a.codePointAt(i) ^ b.codePointAt(i));
  return r === 0;
}

// JWT의 sid를 서명 확인 없이 읽는다(queue-svc가 게이트웨이가 확인한 sid와 견준다)
function sidFrom(token) {
  var parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    var claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return typeof claims.sid === 'string' && ID.test(claims.sid) ? claims.sid : null;
  } catch (e) {
    return null;
  }
}

// 게이트웨이처럼 쿠키나 Authorization 머리의 JWT를 본다(docs/architecture.md §4)
function sidOf(req) {
  var c = req.cookies[ACCESS_COOKIE];
  var s = c ? sidFrom(c.value) : null;
  if (s) return s;
  var a = req.headers.authorization;
  var m = a ? BEARER.exec(a.value) : null;
  return m ? sidFrom(m[1]) : null;
}

function parseCookie(value) {
  var p = value.split('.');
  if (p.length !== 7 || p[0] !== 'v1' || !KID.test(p[1]) || !NUM.test(p[3])) return null;
  return { kid: p[1], e: p[2], t: Number(p[3]), rid: p[4], sid: p[5], mac: p[6], signed: p.slice(0, 6).join('.') };
}

// Degraded인데 서명 없이 원본으로 보낸다: 원본이 세도록 표시한다
function unsigned(request) {
  request.headers[UNSIGNED_HEADER] = { value: 'unsigned' };
  return request;
}

async function handler(event) {
  var request = event.request;
  // 바깥이 보낸 표시 머리는 어떤 요청이든 먼저 지운다
  delete request.headers[UNSIGNED_HEADER];
  if (request.method !== 'POST') return request;
  var path;
  try {
    // 원본 라우터가 퍼센트 인코딩을 풀어 받으므로 같은 뜻의 경로를 같게 본다
    path = decodeURIComponent(request.uri);
  } catch (e) {
    return request;
  }
  var m = ENTRY.exec(path);
  if (!m) return request;
  var eventId = m[1];
  var now = Date.now();

  var sale = null;
  try {
    sale = await kvs.get('sale:' + eventId, { format: 'json' });
  } catch (e) {
    sale = null;
  }
  if (sale && sale.soldOut === true && typeof sale.expireAtMs === 'number' && sale.expireAtMs > now) {
    return problem(410, 'sold-out', '매진되었습니다');
  }

  var mode = null;
  try {
    mode = await kvs.get('mode:entry', { format: 'json' });
  } catch (e) {
    mode = null;
  }
  if (!mode || mode.on !== true || typeof mode.expireAtMs !== 'number' || mode.expireAtMs <= now) return request;

  var sid = sidOf(request);
  if (!sid) return unsigned(request);

  var held = request.cookies[COOKIE];
  if (held) {
    var c = parseCookie(held.value);
    if (c && c.e === eventId && c.sid === sid && now - c.t <= TTL_MS && c.t - now <= FUTURE_MS) {
      var heldKey = null;
      try {
        heldKey = await kvs.get('arr:key:' + c.kid);
      } catch (e) {
        heldKey = null;
      }
      if (heldKey && same(macOf(heldKey, c.signed), c.mac)) return request;
    }
  }

  var kid;
  var key;
  try {
    kid = await kvs.get('arr:cur');
    key = await kvs.get('arr:key:' + kid);
  } catch (e) {
    return unsigned(request);
  }
  var rid = Buffer.from(event.context.requestId).toString('base64url');
  var signed = 'v1.' + kid + '.' + eventId + '.' + now + '.' + rid + '.' + sid;
  var cookies = {};
  cookies[COOKIE] = { value: signed + '.' + macOf(key, signed), attributes: 'Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600' };
  return problem(503, 'dependency-unavailable', '잠시 뒤 다시 시도해 주세요', Math.floor(Math.random() * 16), cookies);
}
