// 화면 묶음별 보안 헤더 값의 한 곳(docs/frontend.md §5.14.1, docs/architecture.md §6.3, ADR-0065·ADR-0079·ADR-0111, BUILD_ORDER BAS-220).
// 정본은 §5.14.1의 글 상자와 헤더 표다. headers.test.mjs가 이 값과 정본이 글자까지 같은지 본다(정본을 고치면 여기도 고친다).
// 붙이는 곳은 묶음마다 다르다: 앱 서버(A 캐시 화면 ISR 응답, B proxy.ts), 배포 응답 헤더 정책(A′ 대기실, C 관제, D 스캐너, infra/),
// 정적 앱의 개발·미리보기 서버(vite·webpack 설정. 운영과 같은 헤더로 화면을 본다). HSTS·nosniff는 배포·게이트웨이 정책이 붙인다(ADR-0065 결정 3).
//
// 자리 표시: {n} 요청마다 만드는 nonce, {h} 빌드 때 정한 인라인 스크립트 해시 목록, {api}·{queue}·{queueFiles}·{partnerApi}·{opsApi}·
// {scannerApi} API 출처, {apiWs} 좌석 WebSocket 출처, {img} 이미지 파생본 출처, {identity} 본인확인기관 출처(연동 계약 때 확정이라 아직 값이 없다. 쓰는 곳이 넘긴다).
// 출처 값은 https·wss 출처(개발은 http://localhost·127.0.0.1)만 받는다. 채우지 않은 자리 표시가 남거나 꼴이 틀리면 만들지 않는다.

/** 운영 출처(정본 §5.14.1이 쓰는 이름). 환경마다 다른 값은 renderCsp의 origins로 넘긴다 */
export const PROD_ORIGINS = {
  api: 'https://api.peaket.example',
  queue: 'https://queue.peaket.example',
  queueFiles: 'https://queue-files.peaket.example',
  partnerApi: 'https://partner-api.peaket.example',
  opsApi: 'https://ops-api.peaket.example',
  scannerApi: 'https://scanner-api.peaket.example',
  apiWs: 'wss://api.peaket.example',
  /** 공연 포스터·배너 파생본(ADR-0199 결정 4) [가정] */
  img: 'https://img.peaket.example',
  /**
   * 소셜 제공자 인가 출처(로그인·재인증·로그인 수단 추가 양식의 form-action, ADR-0215) [가정, 연동 때 제공자 문서로 확정].
   * 카카오는 인가 주소(kauth)가 카카오계정 로그인(accounts)으로 넘기므로 둘 다 둔다(form-action은 제출 뒤 넘김마다 본다).
   * 로컬·CI에서 제공자 issuer를 모의 제공자로 바꾸면 쓰는 곳이 그 출처로 덮는다(apps/web page-headers.ts socialAuthOrigins)
   */
  kakaoAuth: 'https://kauth.kakao.com',
  kakaoAccounts: 'https://accounts.kakao.com',
  naverAuth: 'https://nid.naver.com',
  googleAuth: 'https://accounts.google.com',
};

/** 정본 글 상자의 '+' 줄(화면에 따라 더하거나 바꾸는 것). 로그인 화면의 소셜 제공자 form-action 출처는 [가정]이고 연동 때 제공자 문서로 확정한다 */
export const CSP_VARIANTS = {
  /** 사람 확인을 싣는 화면(공연 상세, 묶음 A) */
  humanCheck: { add: { 'script-src': ['https://challenges.cloudflare.com'], 'frame-src': ['https://challenges.cloudflare.com'] } },
  /** 본인확인을 여는 화면(공연 상세·월렛·스태프 초대 수락, 묶음 A·B) */
  identityForm: { add: { 'form-action': ['{identity}'] } },
  /** 로그인·로그인 수단 잇기 확인·재인증·로그인 수단 추가 화면(묶음 B): POST /login·/reauth·/link/{제공자} 뒤 303으로 제공자로 간다(ADR-0215) */
  socialLogin: { add: { 'form-action': ['{kakaoAuth}', '{kakaoAccounts}', '{naverAuth}', '{googleAuth}'] } },
  /** 파트너 콘솔(묶음 B): connect-src를 바꾼다 */
  partner: { set: { 'connect-src': ["'self'", '{partnerApi}'] } },
};

/** 관제 콘솔(묶음 C)의 Trusted Types 보고 모드 헤더. 정책 이름은 호스트와 원격마다 따로 준다(§5.14.1 'Trusted Types') */
export function trustedTypesReportOnly(remotes = ['queue', 'purchase']) {
  for (const r of remotes) if (!/^[a-z][a-z0-9-]*$/.test(r)) throw new TypeError(`원격 이름이 틀렸다: ${r}`);
  const names = ['peaket', 'peaket-webpack-host', ...remotes.map((r) => `peaket-webpack-${r}`), 'peaket-remote', 'default'];
  return `require-trusted-types-for 'script'; trusted-types ${names.join(' ')}; report-to csp`;
}

const TAIL = "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; report-to csp";

/** 묶음별 기본 CSP(정본 글 상자의 '+' 줄을 뺀 본문) */
export const CSP = {
  A:
    "default-src 'self'; script-src 'self' {h}; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: {img}; font-src 'self'; " +
    "connect-src 'self' {api} {queue} {queueFiles}; worker-src 'self'; manifest-src 'self'; frame-src 'none'; form-action 'self'; " +
    TAIL,
  'A′':
    "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self' {queue} {queueFiles} {api}; frame-src https://challenges.cloudflare.com; manifest-src 'self'; form-action {identity}; " +
    TAIL,
  B:
    "default-src 'self'; script-src 'nonce-{n}' 'strict-dynamic'; style-src 'self' 'nonce-{n}'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: {img}; font-src 'self'; " +
    "connect-src 'self' {api} {queue} {queueFiles}; worker-src 'self'; manifest-src 'self'; frame-src 'none'; form-action 'self'; " +
    TAIL,
  C:
    "default-src 'none'; script-src 'self' {h}; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
    "connect-src 'self' {opsApi}; worker-src 'self'; manifest-src 'self'; form-action 'self'; " +
    TAIL,
  D:
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; " +
    "connect-src 'self' {scannerApi}; worker-src 'self'; manifest-src 'self'; form-action 'none'; " +
    TAIL,
  G:
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; " +
    "connect-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'none'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

/** B에 더하는 묶음(E 결제 화면, F 좌석 화면). 결제사 frame-src·connect-src·form-action 출처는 스테이징 보고 모드로 모아 확정한다 [가정, wbs 2.10.2] */
export const CSP_ADDITIONS = {
  E: { 'script-src': ['https://js.tosspayments.com', 'https://cdn.portone.io'] },
  F: { 'connect-src': ['{apiWs}'] },
};

/** CloudFront 응답 헤더 정책의 CSP 값 한도(ADR-0065). A′·C·D는 배포 응답 헤더 정책에 고정 문자열로 든다 */
export const CLOUDFRONT_CSP_MAX = 1783;

/** 보고 받을 곳(모든 묶음, G 제외. 서버가 없는 공개 위치라 보고를 두지 않는다) */
export const REPORTING_ENDPOINTS = 'csp="/_t/csp"';

const PERMISSIONS_OFF = 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=()';

/**
 * 화면 종류별 CSP 밖 헤더(정본 §5.14.1 헤더 표와 그 아래 '포렌식 리플레이 데모'). 소비자 웹의 복귀·스태프 화면(Referrer-Policy no-referrer),
 * 본인확인 복귀 화면 /verify/return(COOP unsafe-none)은 그 경로의 붙이는 곳이 따로 정한다
 */
export const PAGE_HEADERS = {
  web: { 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups', 'Permissions-Policy': PERMISSIONS_OFF },
  seats: { 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': PERMISSIONS_OFF },
  checkout: { 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups', 'Permissions-Policy': PERMISSIONS_OFF },
  partner: { 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': PERMISSIONS_OFF },
  console: { 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': PERMISSIONS_OFF },
  scanner: {
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=()',
  },
  forensics: {
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Permissions-Policy': PERMISSIONS_OFF,
  },
};

/** 정책 문자열의 한 지시문에 출처를 더하거나(replace면 바꾼다) 없으면 지시문을 object-src 앞에 더한다 */
function addSources(policy, directive, sources, replace = false) {
  const parts = policy.split('; ');
  const i = parts.findIndex((p) => p === directive || p.startsWith(`${directive} `));
  if (i >= 0) parts[i] = replace ? `${directive} ${sources.join(' ')}` : `${parts[i]} ${sources.join(' ')}`;
  else parts.splice(parts.findIndex((p) => p.startsWith('object-src')), 0, `${directive} ${sources.join(' ')}`);
  return parts.join('; ');
}

/**
 * 묶음 하나의 CSP를 만든다.
 * @param {'A' | 'A′' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'} bundle
 * @param {{ nonce?: string, hashes?: string[], origins?: Partial<typeof PROD_ORIGINS> & { identity?: string }, variants?: Array<keyof typeof CSP_VARIANTS>, raw?: boolean }} [o]
 *   raw면 자리 표시를 그대로 둔다(정본 대조용)
 */
export function renderCsp(bundle, o = {}) {
  const base = bundle === 'E' || bundle === 'F' ? CSP.B : CSP[bundle];
  if (base === undefined) throw new TypeError(`모르는 묶음: ${bundle}`);
  let policy = base;
  for (const [d, s] of Object.entries(CSP_ADDITIONS[bundle] ?? {})) policy = addSources(policy, d, s);
  for (const v of o.variants ?? []) {
    const def = CSP_VARIANTS[v];
    if (!def) throw new TypeError(`모르는 변형: ${v}`);
    for (const [d, s] of Object.entries(def.add ?? {})) policy = addSources(policy, d, s);
    for (const [d, s] of Object.entries(def.set ?? {})) policy = addSources(policy, d, s, true);
  }
  if (o.raw) return policy;
  const origins = { ...PROD_ORIGINS, ...o.origins };
  for (const [k, v] of Object.entries(origins)) {
    if (!/^(?:https|wss):\/\/[A-Za-z0-9.-]+(?::\d+)?$|^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(String(v))) throw new TypeError(`출처 ${k}의 꼴이 틀렸다: ${v}`);
  }
  if (policy.includes('{n}')) {
    // CSP3 권고: nonce는 128비트 이상(base64 22자 이상)
    if (!o.nonce || !/^[A-Za-z0-9+/=_-]{22,}$/.test(o.nonce)) throw new TypeError(`묶음 ${bundle}은 요청마다 만든 nonce(128비트 이상, base64 22자 이상)가 필요하다`);
    policy = policy.replaceAll('{n}', o.nonce);
  }
  if (policy.includes('{h}')) {
    const hashes = o.hashes ?? [];
    if (hashes.some((h) => !/^'sha(256|384|512)-[A-Za-z0-9+/=]+'$/.test(h))) throw new TypeError("해시는 'sha256-…' 꼴이어야 한다");
    policy = policy.replace(' {h}', hashes.length ? ` ${hashes.join(' ')}` : '');
  }
  for (const [k, v] of Object.entries(origins)) policy = policy.replaceAll(`{${k}}`, v);
  if (/\{[^}]*\}/.test(policy)) throw new TypeError(`채우지 않은 자리 표시가 남았다(본인확인기관 출처 등은 쓰는 곳이 넘긴다): ${policy}`);
  return policy;
}

/**
 * 정적 앱의 응답 헤더(배포 응답 헤더 정책과 개발·미리보기 서버가 같은 값을 쓴다). HSTS·nosniff는 배포 정책이 더한다
 * @param {'queue-room' | 'console' | 'scanner' | 'forensics'} app
 * @param {{ hashes?: string[], origins?: Partial<typeof PROD_ORIGINS> & { identity?: string }, remotes?: string[] }} [o] 대기실(A′)은 origins.identity가 있어야 한다
 */
export function staticAppHeaders(app, o = {}) {
  const bundle = { 'queue-room': 'A′', console: 'C', scanner: 'D', forensics: 'G' }[app];
  if (!bundle) throw new TypeError(`정적 앱이 아니다: ${app}`);
  const page = app === 'queue-room' ? PAGE_HEADERS.web : PAGE_HEADERS[app];
  return {
    'Content-Security-Policy': renderCsp(bundle, o),
    ...(app === 'console' ? { 'Content-Security-Policy-Report-Only': trustedTypesReportOnly(o.remotes) } : {}),
    ...(bundle === 'G' ? {} : { 'Reporting-Endpoints': REPORTING_ENDPOINTS }),
    ...page,
  };
}
