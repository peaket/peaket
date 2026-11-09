import cf from 'cloudfront';
import crypto from 'crypto';
// 대기열 API 배포의 사전 검증 경로(POST /v1/queues/{eventId}/pre-verifications) 시청자 응답 함수(CloudFront Functions 런타임 2.0, ADR-0223 결정 4, ADR-0249 결정 1).
// 최초 방문 쿠키를 201 응답에만 싣는다. 저장소는 진입 함수와 나눈 것이고 읽기만 한다. 키: fv:cur, fv:key:{kid}
// 실제 CloudFront에서는 돌려 보지 못했다(BUILD_ORDER HOT-012)
const kvs = cf.kvs();

var PREVERIFY = /^\/v1\/queues\/[A-Za-z0-9_-]{1,64}\/pre-verifications$/;
var COOKIE = '__Host-peaket_fv';
var KIND = 'PEAKET-firstvisit-v1';
var KID = /^[A-Za-z0-9_-]{1,32}$/;
var NUM = /^[0-9]{1,15}$/;
var B64URL = /^[A-Za-z0-9_-]+$/;
var ATTRIBUTES = 'Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000';

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

// 값의 꼴: v1.{kid}.{발급 시각 밀리초}.{요청 ID base64url}.{MAC base64url}
function parse(value) {
  var p = value.split('.');
  if (p.length !== 5 || p[0] !== 'v1' || !KID.test(p[1]) || !NUM.test(p[2]) || !B64URL.test(p[3]) || !B64URL.test(p[4])) return null;
  return { kid: p[1], mac: p[4], signed: p.slice(0, 4).join('.') };
}

async function handler(event) {
  var response = event.response;
  var request = event.request;
  if (request.method !== 'POST' || response.statusCode !== 201) return response;
  var path;
  try {
    // 원본 라우터가 퍼센트 인코딩을 풀어 받으므로 같은 뜻의 경로를 같게 본다
    path = decodeURIComponent(request.uri);
  } catch (e) {
    return response;
  }
  if (!PREVERIFY.test(path)) return response;

  var kid;
  var key;
  try {
    kid = await kvs.get('fv:cur');
    key = await kvs.get('fv:key:' + kid);
  } catch (e) {
    // 서명 키를 읽지 못하면 싣지 않는다(응답은 그대로 나간다)
    return response;
  }

  var held = request.cookies[COOKIE];
  if (held) {
    var c = parse(held.value);
    if (c) {
      var heldKey = key;
      if (c.kid !== kid) {
        try {
          // 키가 없으면(지운 kid) 쿠키가 없는 것으로 보고 아래에서 새로 준다
          heldKey = (await kvs.exists('fv:key:' + c.kid)) ? await kvs.get('fv:key:' + c.kid) : null;
        } catch (e) {
          // 저장소 오류로 확인하지 못했다: 새로 주면 그 사람의 쿠키 나이가 0으로 돌아간다
          return response;
        }
      }
      if (heldKey !== null && same(macOf(heldKey, c.signed), c.mac)) return response;
    }
  }

  var signed = 'v1.' + kid + '.' + Date.now() + '.' + Buffer.from(event.context.requestId).toString('base64url');
  response.cookies[COOKIE] = { value: signed + '.' + macOf(key, signed), attributes: ATTRIBUTES };
  return response;
}
