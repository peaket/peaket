// 게이트웨이 kind·브라우저 시험(gateways.e2e.mjs·queue-cors.e2e.mjs)이 함께 쓰는 손님 쪽 도구(BUILD_ORDER HOT-400, 묶음 BAT-055 계획 §5·§6).
// 시험이 기대는 약속(구현 담당이 `node tools/local/cluster.mjs gateways`로 만족시킨다. 이름·모양을 바꾸려면 계획 파일 '시험 이의'에 적는다):
//
// 1. 접속 정보 파일: `.cache/peaket-tools/gateways-e2e.json`(환경 값 PEAKET_GATEWAYS_E2E로 다른 경로). 저장소에 두지 않는다.
//    {
//      "ports":   { "gw-queue": 이 PC 포트, "gw-fan": …, "gw-partner": …, "gw-ops": …, "gw-scanner": … },   // 게이트웨이 HTTPS를 127.0.0.1로 낸 포트
//      "hosts":   { "queue": 이름, "queue-files": …, "api": …, "www": …, "partner-api": …, "partner": …, "ops-api": …, "scanner-api": … },
//                 // 로컬 덧씌우기의 호스트(운영의 <키>.peaket.example 자리). 시험은 Host 머리와 SNI로 이 이름을 보낸다
//      "origins": { "www": 출처, "partner": …, "console": …, "scanner": … },  // 브라우저가 보낼 Origin 그대로(포트 포함)
//      "originVerify": 시험 원본 확인 값,  "issuer": 시험 발급자,
//      "keys":    { "fan": 개인 JWK(kid 포함), "admin": …, "staff": …, "admission": … },  // 시험 키(대역 공개키 묶음이 공개 부분을 낸다)
//      "probes":  { "<게이트웨이>": { "host": hosts의 키, "method": "GET", "path": "/v1/…", "scope": "공백으로 이은 스코프", "scheme": "Bearer" } },
//                 // 그 게이트웨이의 토큰을 단 요청이 대역 백엔드(echo)에 닿는 경로. path의 {event}는 시험이 회차 ID로 바꾼다. 검색(한도) 경로는 쓰지 않는다
//      "appPaths": { "gw-fan": www 앱 서버 경로, "gw-partner": partner 앱 서버 경로 },
//      "logs":    { "namespace": Envoy 프록시 네임스페이스(기본 envoy-gateway-system), "container": 기본 envoy,
//                   "selector": 라벨 고르개 틀(기본 gateway.envoyproxy.io/owning-gateway-name={gateway}) },
//      "caPem":   게이트웨이 인증서의 PEM(없으면 인증서를 확인하지 않는다, 로컬 자체 서명)
//      "replicas": { "gw-fan": 로컬 덧씌우기의 프록시 복제 수 }  // 없으면 1(로컬 한도는 파드마다 센다, SR-T13 ②)
//    }
// 2. 대역 백엔드(echo): 받은 요청을 JSON `{ "method", "path", "headers": { 소문자 이름: 값 } }`으로 돌려준다(같은 이름이 여럿이면 쉼표로 이은 값).
//    응답을 고르는 법(시험만 쓴다): 요청 머리 `x-e2e-status`(상태), `x-e2e-response-headers`(JSON 객체, 값은 글이나 글 배열), `x-e2e-body`(본문 글).
//    머리를 달 수 없는 브라우저 요청(사전 요청 없는 형식)은 같은 뜻의 쿼리 `e2e-status`·`e2e-header=이름:값`(여럿)을 쓴다.
// 3. 접근 로그: Envoy 프록시 컨테이너 표준 출력의 JSON 한 줄(docs/infra.md §4.1 '접근 로그'). 시험은 토큰 `sub`나 보낸 고유 값이 든 줄을 찾는다.
import { existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import { kubectl } from '../cluster.mjs';
import { DEFAULT_ROOT } from '../tools.mjs';
import { signV0Token } from '../v0-token.mjs';

export const CONTRACT_FILE = process.env.PEAKET_GATEWAYS_E2E || join(DEFAULT_ROOT, 'gateways-e2e.json');
export const GATEWAYS = ['gw-queue', 'gw-fan', 'gw-partner', 'gw-ops', 'gw-scanner'];
export const BEHIND_CLOUDFRONT = ['gw-queue', 'gw-fan', 'gw-partner', 'gw-ops'];
/** 호스트 키 → 게이트웨이(docs/infra.md §4.1 '호스트와 내부 경로') */
export const GATEWAY_OF_HOST = { queue: 'gw-queue', 'queue-files': 'gw-queue', api: 'gw-fan', www: 'gw-fan', 'partner-api': 'gw-partner', partner: 'gw-partner', 'ops-api': 'gw-ops', 'scanner-api': 'gw-scanner' };
/** 게이트웨이마다 화면 출처 키(docs/infra.md §9 'CORS') */
export const SCREEN_OF = { 'gw-queue': 'www', 'gw-fan': 'www', 'gw-partner': 'partner', 'gw-ops': 'console', 'gw-scanner': 'scanner' };
/** 게이트웨이마다 서명 키 셋과 대상(docs/features/identity.md §3) */
export const KEYSET_OF = { 'gw-queue': 'fan', 'gw-fan': 'fan', 'gw-partner': 'admin', 'gw-ops': 'admin', 'gw-scanner': 'staff' };
export const AUD_OF = { 'gw-queue': 'fan', 'gw-fan': 'fan', 'gw-partner': 'partner', 'gw-ops': 'ops', 'gw-scanner': 'scanner' };
export const HSTS = 'max-age=31536000; includeSubDomains';
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** 접속 정보를 읽는다. 없으면 무엇을 먼저 돌려야 하는지 알리며 던진다 */
export function loadContract() {
  if (!existsSync(CONTRACT_FILE)) throw new Error(`게이트웨이 접속 정보가 없다: ${CONTRACT_FILE}. 먼저 node tools/local/cluster.mjs up && node tools/local/cluster.mjs gateways`);
  const c = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8'));
  for (const k of ['ports', 'hosts', 'origins', 'originVerify', 'issuer', 'keys', 'probes', 'appPaths']) if (c[k] === undefined) throw new Error(`접속 정보에 ${k}가 없다`);
  for (const gw of GATEWAYS) {
    if (!c.ports[gw]) throw new Error(`접속 정보에 ${gw} 포트가 없다`);
    if (!c.probes[gw]) throw new Error(`접속 정보에 ${gw} 확인 경로가 없다`);
  }
  return c;
}

/**
 * 게이트웨이에 요청 하나. host는 hosts의 키(queue·api…)다. 응답 머리는 소문자 이름 → 값(여럿이면 배열)
 * @returns {Promise<{ status: number, headers: Record<string, string | string[] | undefined>, text: string }>}
 */
export function send(c, hostKey, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const gw = GATEWAY_OF_HOST[hostKey];
  const host = c.hosts[hostKey];
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: c.ports[gw],
        servername: host,
        method,
        path,
        headers: { host, ...headers },
        ...(c.caPem ? { ca: c.caPem } : { rejectUnauthorized: false }),
        agent: false,
        timeout: 15_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${gw} ${method} ${path}: 시간 넘김`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** 대역 백엔드가 돌려준 머리(소문자). 백엔드에 닿지 않았으면 던진다 */
export function echoed(res) {
  let o;
  try {
    o = JSON.parse(res.text);
  } catch {
    throw new Error(`대역 백엔드 응답이 아니다(${res.status}): ${res.text.slice(0, 200)}`);
  }
  const h = o?.headers ?? o;
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)]));
}

/** 시험 키로 토큰을 만든다(set: fan·admin·staff·admission). 클레임·머리는 덮어쓸 수 있다 */
export function token(c, set, claims, header = {}) {
  return signV0Token(c.keys[set], { iss: c.issuer, ...claims }, { header });
}

/** 그 게이트웨이의 맞는 액세스 토큰(확인 경로가 백엔드에 닿는 스코프) */
export function accessToken(c, gw, sub, extra = {}) {
  const scope = c.probes[gw].scope ?? '';
  return token(c, KEYSET_OF[gw], { sub, sid: `s-${sub}`, aud: AUD_OF[gw], scope, ...(KEYSET_OF[gw] === 'fan' ? { pid: `p-${sub}` } : {}), ...extra });
}

/** 확인 경로로 보낸다(토큰은 확인 경로의 방식으로 Authorization에) */
export function probe(c, gw, { tokenValue, headers = {}, event = 'e2e-event' } = {}) {
  const p = c.probes[gw];
  const auth = tokenValue === undefined ? {} : { authorization: `${p.scheme ?? 'Bearer'} ${tokenValue}` };
  return send(c, p.host, { method: p.method ?? 'GET', path: p.path.replaceAll('{event}', event), headers: { ...auth, ...headers } });
}

/** CloudFront 몫(원본 확인 머리·x-forwarded-for)을 시험 클라이언트가 붙인다(bot-defense B-T18 '앞단') */
export const edge = (c, ip, extra = {}) => ({ 'x-peaket-origin-verify': c.originVerify, 'x-forwarded-for': ip, ...extra });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 그 게이트웨이 프록시의 접근 로그 JSON 줄들(since 이후). 줄 꼴이 아닌 것은 버린다 */
export async function accessLog(c, gw, sinceSeconds = 300) {
  const ns = c.logs?.namespace ?? 'envoy-gateway-system';
  const container = c.logs?.container ?? 'envoy';
  const selector = (c.logs?.selector ?? 'gateway.envoyproxy.io/owning-gateway-name={gateway}').replaceAll('{gateway}', gw);
  const out = await kubectl(['-n', ns, 'logs', '-l', selector, '-c', container, `--since=${sinceSeconds}s`, '--tail=-1', '--prefix=false'], { quiet: true, maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
  return out
    .split('\n')
    .map((l) => {
      try {
        const o = JSON.parse(l);
        return o && typeof o === 'object' ? o : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** 값 하나가 든 접근 로그 줄을 기다려 찾는다(프록시가 줄을 내보내는 데 몇 초 걸린다) */
export async function waitLogLine(c, gw, marker, { timeoutMs = 20_000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const lines = (await accessLog(c, gw)).filter((l) => Object.values(l).some((v) => typeof v === 'string' && v.includes(marker)));
    if (lines.length) return lines;
    if (Date.now() > until) throw new Error(`${gw}: ${marker}가 든 접근 로그 줄이 ${timeoutMs}ms 안에 없다`);
    await sleep(1000);
  }
}

/** 빈 칸(머리가 없을 때 Envoy JSON 형식은 null이나 '-'를 쓴다) */
export const blank = (v) => v === undefined || v === null || v === '' || v === '-';

/** n개를 동시에 몇 개씩 보낸다 */
export async function pool(n, width, fn) {
  const out = new Array(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, n) }, async () => {
      while (next < n) {
        const i = next++;
        out[i] = await fn(i);
      }
    }),
  );
  return out;
}
