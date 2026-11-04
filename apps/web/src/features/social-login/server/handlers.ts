// 소비자 웹 앱 서버의 로그인 경로 처리기(docs/features/identity.md §2 '웹 앱 서버 경로와 첫 구현 범위', §3, §7.1, ADR-0119).
// 웹 표준 Request → Response 함수다. app/(request) 아래 Next 경로 파일이 부르고, 시험은 dispatch로 부른다.
// - 모든 응답은 Cache-Control: no-store. POST는 Origin을 소비자 웹 출처와 대조한다(CSRF, ADR-0065 결정 5)
// - 실패 응답에는 이유를 싣지 않는다. 이유 범주는 서버 로그에만 남긴다(log)
// - 제공자 토큰은 로그인 처리 뒤 버리고 identity에 보내지 않는다(asvs 10.1.1)
import * as client from 'openid-client';
import { allowsMockProviders, type SocialLoginConfig } from './config.ts';
import {
  ACCESS_COOKIE,
  clearLinkCookie,
  clearProgressCookie,
  clearReauthCookie,
  clearSessionCookies,
  cookieOf,
  LINK_COOKIE,
  LINK_TTL_MS,
  linkCookie,
  PROGRESS_COOKIE,
  PROGRESS_TTL_MS,
  progressCookie,
  REAUTH_COOKIE,
  REAUTH_RESULT_TTL_MS,
  reauthCookie,
  sessionCookies,
} from './cookies.ts';
import { FanTokenVerifier } from './fan-token.ts';
import { IdentityClient } from './identity-client.ts';
import { deriveLoginKeys, idempotencyKeyOf, separateKeyOf } from './keys.ts';
import { OidcProviders } from './oidc.ts';
import { isProvider, type Provider } from './providers.ts';
import { reauthPrompt, reauthStrength } from './reauth-strength.ts';
import { safeReturnTo } from './return-to.ts';
import { seal, unseal } from './sealed.ts';

export type LoginLog = (event: string, fields: Record<string, unknown>) => void;

export interface SocialLoginDeps {
  now?: () => number;
  log?: LoginLog;
  identity?: IdentityClient;
}

/** 로그인 진행 쿠키 안의 값(identity §3) */
interface Progress {
  /** link: 계정 설정의 로그인 수단 추가(SCR-040 ②, identity §2.1 '설정의 로그인 수단 연결·해제의 첫 구현') */
  purpose: 'login' | 'reauth' | 'link';
  p: Provider;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  deviceId?: string | null;
  /** 재인증만: 목적(identity §7.1 ③), 시작 시각과 그 세션(액세스 토큰에서 확인한 값) */
  reauthPurpose?: 'sensitive' | 'high-risk';
  startedAt?: number;
  sid?: string;
  sub?: string;
  /** 가입 때 연결 제안을 따라 온 기존 제공자 로그인(identity §2.1). 묶음 값은 연결 제안 쿠키에 있다 */
  linkProposalId?: string;
  /** 로그인 수단 추가만: 화면이 먼저 받은 재인증 토큰(5분 한 번). identity AddProvider가 쓴다 */
  reauthToken?: string;
}

/** 연결 제안 쿠키 안의 값(identity §2.1·§3) */
interface LinkSeal {
  proposalId: string;
  binding: string;
  returnTo: string;
}

/** 재인증 결과 쿠키 안의 값(identity §7.1 ⑤) */
type ReauthResult = { token: string; provider: Provider; strength: 'verified' | 'requested'; expiresAt: number } | { error: 'stale' | 'account-mismatch' | 'reverify-required' | 'failed' };

export const GENERIC_FAILURE = '로그인하지 못했습니다. 처음부터 다시 시도해 주세요';
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;
const PROPOSAL_ID = /^[A-Za-z0-9_-]{22}$/;
/** grpc 상태 코드 NOT_FOUND(연결 제안이 없거나 만료) */
const GRPC_NOT_FOUND = '5';

const LINK_PROBLEM = {
  missing: { status: 404, type: 'link-proposal-missing', title: '연결 제안이 없거나 시간이 지났습니다. 다시 로그인해 주세요' },
  unavailable: { status: 503, type: 'link-unavailable', title: '지금은 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요' },
} as const;
/** 연결 제안 화면(SCR-039). 제안 ID는 주소에 실려도 된다(묶음 값은 쿠키에만 있다, identity §2.1) */
const LINK_PAGE = '/login/link';
const LINK_EXPIRED = `${LINK_PAGE}?link=expired`;

const REAUTH_PROBLEM = {
  stale: { status: 409, type: 'reauth-stale', title: '제공자 계정에서 로그아웃한 뒤 다시 시도해 주세요' },
  'account-mismatch': { status: 409, type: 'reauth-account-mismatch', title: '지금 로그인한 계정과 다른 계정으로 다시 로그인했습니다' },
  'reverify-required': { status: 409, type: 'reauth-reverify-required', title: '휴대폰 본인확인을 다시 한 뒤 계속할 수 있습니다' },
  failed: { status: 409, type: 'reauth-failed', title: '다시 로그인하지 못했습니다. 다시 시도해 주세요' },
  missing: { status: 404, type: 'reauth-result-missing', title: '재인증 결과가 없습니다. 다시 로그인해 주세요' },
} as const;

const NO_STORE = { 'cache-control': 'no-store' };

function respond(status: number, body: string | null, cookies: string[] = [], headers: Record<string, string> = {}): Response {
  const h = new Headers({ ...NO_STORE, ...(body === null ? {} : { 'content-type': 'text/plain; charset=utf-8' }), ...headers });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(body, { status, headers: h });
}
const redirect = (to: string, cookies: string[] = []) => respond(303, null, cookies, { location: to });
const json = (status: number, v: object, cookies: string[] = [], type = 'application/json') => respond(status, JSON.stringify(v), cookies, { 'content-type': type });
const problem = (p: { status: number; type: string; title: string }, cookies: string[] = []) => json(p.status, { type: p.type, title: p.title }, cookies, 'application/problem+json');

async function formOf(req: Request): Promise<URLSearchParams> {
  if (!(req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return new URLSearchParams();
  return new URLSearchParams(await req.text());
}

/** openid-client·identity 오류에서 서버 로그에 남길 코드만 꺼낸다(메시지·토큰은 남기지 않는다) */
const codeOf = (e: unknown): string | undefined => {
  const err = e as { code?: unknown; cause?: { code?: unknown } };
  const c = err?.code ?? err?.cause?.code;
  return typeof c === 'string' || typeof c === 'number' ? String(c) : undefined;
};

export function createSocialLogin(config: SocialLoginConfig, deps: SocialLoginDeps = {}) {
  const now = deps.now ?? Date.now;
  const log: LoginLog = deps.log ?? ((event, fields) => console.error(JSON.stringify({ event, ...fields })));
  const keys = deriveLoginKeys(config.secret);
  const previous = config.previousSecret ? deriveLoginKeys(config.previousSecret) : undefined;
  // 봉인은 지금 키로만, 열기는 옛 키로도(비밀을 바꾼 뒤 쿠키 수명 동안)
  const progressKeys = [keys.progress, ...(previous ? [previous.progress] : [])];
  const reauthKeys = [keys.reauthResult, ...(previous ? [previous.reauthResult] : [])];
  const linkKeys = [keys.link, ...(previous ? [previous.link] : [])];
  /** 연결 제안 쿠키가 그 제안 ID의 것일 때만 */
  const linkOf = (req: Request, id: string): LinkSeal | null => {
    const l = unseal<LinkSeal>(linkKeys, LINK_COOKIE, cookieOf(req, LINK_COOKIE), now());
    return l && l.proposalId === id ? l : null;
  };
  const oidc = new OidcProviders(config.providers, allowsMockProviders(config.env));
  const identity = deps.identity ?? new IdentityClient(config.identityAddress);
  if (!config.fanJwksUrl && !config.fanJwks) throw new Error('팬 토큰 공개키 묶음 주소나 값이 있어야 한다');
  const fanTokens = new FanTokenVerifier(config.fanJwksUrl ? new URL(config.fanJwksUrl) : (config.fanJwks as NonNullable<SocialLoginConfig['fanJwks']>), config.tokenIssuer);
  const callbackUrl = (p: Provider) => `${config.origin}/login/callback/${p}`;
  // no-referrer 화면의 양식 전송은 Origin: null이다. 그때만 브라우저가 붙이는 Sec-Fetch-Site: same-origin을 본다(architecture §5 'CSRF 확인 규칙')
  const sameOrigin = (req: Request) => {
    const o = req.headers.get('origin');
    return o === config.origin || (o === 'null' && req.headers.get('sec-fetch-site') === 'same-origin');
  };
  const forbidden = () => respond(403, '다른 출처의 요청입니다');
  const unavailable = () => respond(503, '지금은 그 로그인을 쓸 수 없습니다. 잠시 뒤 다시 시도해 주세요');

  async function startFlow(p: Provider, progress: Progress, extra?: Record<string, string>): Promise<Response> {
    let url: string;
    try {
      url = await oidc.authorizationUrl(p, { redirectUri: callbackUrl(p), state: progress.state, nonce: progress.nonce, verifier: progress.verifier, extra });
    } catch (e) {
      log(progress.purpose === 'reauth' ? 'reauth.failed' : 'login.failed', { provider: p, reason: 'discovery', code: codeOf(e) });
      return unavailable();
    }
    return redirect(url, [progressCookie(seal(keys.progress, PROGRESS_COOKIE, progress, now() + PROGRESS_TTL_MS))]);
  }

  const randomFlow = () => ({ state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier() });

  /** POST /login/{provider}: 로그인 시작 */
  async function start(req: Request, provider: string): Promise<Response> {
    if (!sameOrigin(req)) return forbidden();
    if (!isProvider(provider) || !oidc.has(provider)) return respond(404, '없는 로그인 수단입니다');
    const f = await formOf(req);
    const deviceId = f.get('deviceId');
    // 연결 제안 화면(SCR-039)의 [기존 제공자 로그인]은 제안 ID를 싣는다. 쿠키와 맞는지는 콜백에서 본다
    const linkProposal = f.get('linkProposal');
    const linking = linkProposal !== null && PROPOSAL_ID.test(linkProposal);
    // 연결 화면에서 시작한 로그인은 계정을 다시 고르게 한다: 제공자에 다른 계정이 로그인돼 있어도 남은 시도가 저절로 줄지 않게(새 맥락 리뷰 중간 3)
    const progress: Progress = {
      purpose: 'login',
      p: provider,
      ...randomFlow(),
      returnTo: safeReturnTo(f.get('returnTo')),
      deviceId: deviceId && DEVICE_ID.test(deviceId) ? deviceId : null,
      ...(linking && linkProposal ? { linkProposalId: linkProposal } : {}),
    };
    return startFlow(provider, progress, linking ? reauthPrompt(provider) : undefined);
  }

  /** POST /reauth/{provider}: 팬 민감 작업 전 재인증 시작(identity §7.1 ①) */
  async function reauthStart(req: Request, provider: string): Promise<Response> {
    if (!sameOrigin(req)) return forbidden();
    if (!isProvider(provider) || !oidc.has(provider)) return respond(404, '없는 로그인 수단입니다');
    const at = now();
    const fan = await fanTokens.verify(cookieOf(req, ACCESS_COOKIE), at, { allowExpired: false });
    if (!fan) return respond(401, '다시 로그인해 주세요');
    const f = await formOf(req);
    const progress: Progress = {
      purpose: 'reauth',
      p: provider,
      ...randomFlow(),
      returnTo: safeReturnTo(f.get('returnTo')),
      reauthPurpose: f.get('purpose') === 'high-risk' ? 'high-risk' : 'sensitive',
      startedAt: at,
      sid: fan.sessionId,
      sub: fan.accountId,
    };
    return startFlow(provider, progress, reauthPrompt(provider));
  }

  /** POST /link/{provider}: 계정 설정의 로그인 수단 추가(SCR-040 ②). 팬 세션과 화면이 먼저 받은 재인증 토큰이 있어야 시작한다 */
  async function linkStart(req: Request, provider: string): Promise<Response> {
    if (!sameOrigin(req)) return forbidden();
    if (!isProvider(provider) || !oidc.has(provider)) return respond(404, '없는 로그인 수단입니다');
    const at = now();
    const fan = await fanTokens.verify(cookieOf(req, ACCESS_COOKIE), at, { allowExpired: false });
    if (!fan) return respond(401, '다시 로그인해 주세요');
    const f = await formOf(req);
    const reauthToken = f.get('reauthToken') ?? '';
    if (!reauthToken || reauthToken.length > 4096) return respond(400, '다시 로그인한 뒤 시도해 주세요');
    const progress: Progress = { purpose: 'link', p: provider, ...randomFlow(), returnTo: safeReturnTo(f.get('returnTo')), sid: fan.sessionId, sub: fan.accountId, reauthToken };
    // 새 제공자 인증은 계정을 다시 고르게 한다(재인증과 같은 prompt): 제공자에 이미 로그인한 다른 계정이 저절로 붙지 않게
    return startFlow(provider, progress, reauthPrompt(provider));
  }

  /** 돌아갈 주소에 결과 값을 붙인다(같은 출처 경로만, safeReturnTo를 거친 값) */
  const withResult = (to: string, key: string, value: string): string => {
    const u = new URL(to, config.origin);
    u.searchParams.set(key, value);
    return `${u.pathname}${u.search}${u.hash}`;
  };

  /** GET /login/callback/{provider}: 로그인·재인증 공용 콜백 */
  async function callback(req: Request, provider: string): Promise<Response> {
    const prog = unseal<Progress>(progressKeys, PROGRESS_COOKIE, cookieOf(req, PROGRESS_COOKIE), now());
    if (!prog || !isProvider(provider) || prog.p !== provider) {
      log('login.failed', { provider, reason: 'progress' });
      return respond(400, GENERIC_FAILURE, [clearProgressCookie()]);
    }
    // 진행 쿠키는 한 번만 쓴다: 성공·실패 모두 지운다. 재인증은 실패해도 돌아갈 주소로 보내고 실패 종류만 넘긴다(identity §7.1 ⑤)
    const reauthDone = (r: ReauthResult) => redirect(prog.returnTo, [clearProgressCookie(), reauthCookie(seal(keys.reauthResult, REAUTH_COOKIE, r, now() + REAUTH_RESULT_TTL_MS))]);
    const fail = (reason: string, code?: string, status = 400) => {
      log(prog.purpose === 'reauth' ? 'reauth.failed' : prog.purpose === 'link' ? 'link-add.failed' : 'login.failed', { provider, reason, code });
      if (prog.purpose === 'reauth') return reauthDone({ error: 'failed' });
      // 로그인 수단 추가는 실패해도 설정 화면으로 돌려보내 결과를 안내한다(막다른 페이지가 되지 않게, 새 맥락 리뷰 중간 3)
      if (prog.purpose === 'link') return redirect(withResult(prog.returnTo, 'loginMethod', 'failed'), [clearProgressCookie()]);
      return respond(status, GENERIC_FAILURE, [clearProgressCookie()]);
    };
    const u = new URL(req.url);
    // 제공자가 돌려준 오류(사용자 취소 등)와 다른 state는 코드 교환 전에 나눠 남긴다(운영 확인의 이유 범주, identity §10.1)
    const providerError = u.searchParams.get('error');
    if (providerError !== null) return fail('provider_error', providerError.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40));
    if (u.searchParams.get('state') !== prog.state) return fail('state');
    // 콜백 주소는 공개 출처로 다시 만든다(프록시 뒤에서 요청 호스트가 내부 주소여도 인가 때의 redirect_uri와 같게)
    const here = new URL(`${u.pathname}${u.search}`, config.origin);
    let login: Awaited<ReturnType<OidcProviders['callback']>>;
    try {
      login = await oidc.callback(provider, here, prog);
    } catch (e) {
      return fail('id_token', codeOf(e));
    }
    const sub = login.claims.sub;
    const userAgent = (req.headers.get('user-agent') ?? '').slice(0, 512);
    // acr·amr가 없으면 단일 요소로 본다(asvs 6.8.4). 있으면 그대로 넘긴다
    const authMethods = [login.claims.acr, ...(Array.isArray(login.claims.amr) ? login.claims.amr : [])].filter((v): v is string => typeof v === 'string');

    if (prog.purpose === 'link') {
      // 로그인 수단 추가: 새 로그인 세션은 만들지 않는다. 결과는 돌아갈 주소의 loginMethod로 넘긴다(identity §2.1)
      try {
        const result = await identity.addProvider({ sessionId: prog.sid ?? '', accountId: prog.sub ?? '', reauthToken: prog.reauthToken ?? '', provider, providerUserId: sub });
        log('link-add.completed', { provider, result });
        return redirect(withResult(prog.returnTo, 'loginMethod', result), [clearProgressCookie()]);
      } catch (e) {
        log('link-add.failed', { provider, reason: 'identity', code: codeOf(e) });
        return redirect(withResult(prog.returnTo, 'loginMethod', 'failed'), [clearProgressCookie()]);
      }
    }

    if (prog.purpose === 'reauth') {
      const done = reauthDone;
      const outcome = reauthStrength(provider, login.claims, prog.startedAt ?? 0, now());
      if (outcome === 'stale') {
        log('reauth.rejected', { provider, reason: 'stale' });
        return done({ error: 'stale' });
      }
      try {
        const r = await identity.issueReauthToken({
          sessionId: prog.sid ?? '',
          accountId: prog.sub ?? '',
          provider,
          providerUserId: sub,
          strength: outcome,
          purpose: prog.reauthPurpose ?? 'sensitive',
          userAgent,
        });
        if (r.result === 'ACCOUNT_MISMATCH' || r.result === 'REVERIFY_REQUIRED') {
          const error = r.result === 'ACCOUNT_MISMATCH' ? 'account-mismatch' : 'reverify-required';
          log('reauth.rejected', { provider, reason: error });
          return done({ error });
        }
        log('reauth.completed', { provider, strength: outcome });
        return done({ token: r.token, provider, strength: outcome, expiresAt: r.expiresAt });
      } catch (e) {
        return fail('identity', codeOf(e));
      }
    }

    let profile = { email: typeof login.claims.email === 'string' ? login.claims.email : null, emailVerified: login.claims.email_verified === true };
    if (provider === 'naver') {
      try {
        // 네이버는 이메일 검증 여부를 주지 않는다(identity §2.1: 자동 연결 제안 대상에서 뺀다)
        profile = { email: (await oidc.naverProfile(login)).email, emailVerified: false };
      } catch (e) {
        return fail('userinfo', codeOf(e));
      }
    } else if (login.claims.email_verified === undefined && !prog.linkProposalId) {
      // 카카오처럼 ID 토큰에 검증 여부가 없으면 사용자 정보로 읽는다(새 맥락 리뷰 중간 2). 검증 여부는 가입 때 연결 제안에만 쓰므로,
      // 사용자 정보가 실패해도 로그인을 막지 않고 '검증 안 됨'(제안 없음)으로 간다. 연결 화면에서 시작한 로그인은 이메일을 쓰지 않아 부르지 않는다(재검토 중간)
      try {
        const u = await oidc.userInfoEmail(provider, login);
        profile = { email: u.email ?? profile.email, emailVerified: u.emailVerified };
      } catch (e) {
        log('login.userinfo-fallback', { provider, code: codeOf(e) });
        profile = { email: profile.email, emailVerified: false };
      }
    }
    // 연결 제안을 따라 온 로그인이면 쿠키의 묶음 값을 싣는다. 쿠키가 없거나 다른 제안이면 identity를 부르지 않고 만료 안내로(identity §2.1)
    let link: LinkSeal | null = null;
    if (prog.linkProposalId) {
      link = linkOf(req, prog.linkProposalId);
      if (!link) {
        log('link.expired', { provider, reason: 'cookie' });
        return redirect(LINK_EXPIRED, [clearProgressCookie(), clearLinkCookie()]);
      }
    }
    try {
      const r = await identity.createSession({
        idempotencyKey: idempotencyKeyOf(keys, prog.state),
        provider,
        providerUserId: sub,
        ...profile,
        deviceId: prog.deviceId ?? null,
        userAgent,
        authMethods,
        ...(link ? { link: { proposalId: link.proposalId, binding: link.binding } } : {}),
      });
      if (r.kind === 'link-proposed') {
        // 같은 이메일 계정이 있어 연결을 제안한다(SCR-039). 세션은 아직 없다
        log('link.proposed', { provider });
        const sealed = seal(keys.link, LINK_COOKIE, { proposalId: r.proposalId, binding: r.binding, returnTo: prog.returnTo } satisfies LinkSeal, now() + LINK_TTL_MS);
        return redirect(`${LINK_PAGE}?proposal=${r.proposalId}`, [clearProgressCookie(), linkCookie(sealed)]);
      }
      if (r.kind === 'link-mismatch') {
        log('link.mismatch', { provider, attemptsLeft: r.attemptsLeft });
        if (r.attemptsLeft > 0 && link) return redirect(`${LINK_PAGE}?proposal=${link.proposalId}&mismatch=${r.attemptsLeft}`, [clearProgressCookie()]);
        return redirect(LINK_EXPIRED, [clearProgressCookie(), clearLinkCookie()]);
      }
      const s = r.session;
      log('login.completed', { provider, newAccount: s.newAccount, ...(r.linkedProvider ? { linked: r.linkedProvider } : {}) });
      const cookies = [clearProgressCookie(), ...sessionCookies(s, now(), config.cookieDomain), ...(link ? [clearLinkCookie()] : [])];
      // 연결 제안을 따라 왔으면 처음 로그인 때의 돌아갈 주소로. 처음 로그인이면 가입·약관 동의(SCR-005)로
      const back = link ? link.returnTo : prog.returnTo;
      const to = s.newAccount ? `/signup/consent?next=${encodeURIComponent(back)}` : back;
      // 연결을 맺었으면 연결 화면의 '연결 성공'(토스트) 뒤 그 주소로 간다(d5 §5.21)
      if (r.linkedProvider) return redirect(`${LINK_PAGE}?linked=${r.linkedProvider}&next=${encodeURIComponent(to)}`, cookies);
      return redirect(to, cookies);
    } catch (e) {
      if (link && codeOf(e) === GRPC_NOT_FOUND) {
        log('link.expired', { provider, reason: 'identity' });
        return redirect(LINK_EXPIRED, [clearProgressCookie(), clearLinkCookie()]);
      }
      return fail('identity', codeOf(e), 503);
    }
  }

  /** POST /logout: identity 세션을 끝내고 이 앱이 준 쿠키를 지운다. identity가 실패해도 쿠키는 지우고 503으로 알린다 */
  async function logout(req: Request): Promise<Response> {
    if (!sameOrigin(req)) return forbidden();
    const cookies = [...clearSessionCookies(config.cookieDomain)];
    if (cookieOf(req, PROGRESS_COOKIE) !== undefined) cookies.push(clearProgressCookie());
    if (cookieOf(req, REAUTH_COOKIE) !== undefined) cookies.push(clearReauthCookie());
    const raw = cookieOf(req, ACCESS_COOKIE);
    const fan = await fanTokens.verify(raw, now(), { allowExpired: true });
    if (!raw) log('logout.without-session', {});
    else if (!fan) log('logout.failed', { reason: 'token' });
    if (fan) {
      try {
        await identity.endSession(fan);
      } catch (e) {
        log('logout.failed', { reason: 'identity', code: codeOf(e) });
        return respond(503, '로그아웃을 마치지 못했습니다. 다시 시도해 주세요', cookies);
      }
    }
    return redirect('/', cookies);
  }

  /** POST /reauth/token: 화면 스크립트가 재인증 결과를 한 번 받는다(identity §7.1 ⑤, I-T72) */
  async function reauthToken(req: Request): Promise<Response> {
    if (!sameOrigin(req)) return forbidden();
    const r = unseal<ReauthResult>(reauthKeys, REAUTH_COOKIE, cookieOf(req, REAUTH_COOKIE), now());
    const clear = [clearReauthCookie()];
    if (!r) return problem(REAUTH_PROBLEM.missing, clear);
    if ('error' in r) return problem(REAUTH_PROBLEM[r.error], clear);
    return json(200, { reauthToken: r.token, provider: r.provider, strength: r.strength, expiresAt: r.expiresAt }, clear);
  }

  /** GET /v1/identity/link-proposals/{proposalId}: 연결 제안 화면이 기존·새 제공자, 만료, 남은 시도를 읽는다(identity §2.1) */
  async function linkProposal(req: Request, id: string): Promise<Response> {
    const l = linkOf(req, id);
    if (!l) return problem(LINK_PROBLEM.missing);
    try {
      const v = await identity.getLinkProposal({ proposalId: id, binding: l.binding });
      if (!v) return problem(LINK_PROBLEM.missing, [clearLinkCookie()]);
      return json(200, { proposalId: id, existingProvider: v.existingProvider, newProvider: v.newProvider, expiresAt: new Date(v.expiresAt).toISOString(), attemptsLeft: v.attemptsLeft });
    } catch (e) {
      log('link.failed', { reason: 'identity', code: codeOf(e) });
      return problem(LINK_PROBLEM.unavailable);
    }
  }

  /** POST /v1/identity/link-proposals/{proposalId}/separate-account: 연결하지 않고 새 계정 만들기(identity §2.1, FR-048) */
  async function separateAccount(req: Request, id: string): Promise<Response> {
    if (!sameOrigin(req)) return forbidden();
    const l = linkOf(req, id);
    if (!l) return problem(LINK_PROBLEM.missing);
    const f = await formOf(req);
    const deviceId = f.get('deviceId');
    try {
      const s = await identity.separateAccount({
        proposalId: id,
        binding: l.binding,
        idempotencyKey: separateKeyOf(keys, id),
        deviceId: deviceId && DEVICE_ID.test(deviceId) ? deviceId : null,
        userAgent: (req.headers.get('user-agent') ?? '').slice(0, 512),
      });
      if (!s) return problem(LINK_PROBLEM.missing, [clearLinkCookie()]);
      log('login.completed', { provider: 'separate', newAccount: s.newAccount });
      const next = s.newAccount ? `/signup/consent?next=${encodeURIComponent(l.returnTo)}` : l.returnTo;
      return json(201, { next }, [clearLinkCookie(), ...sessionCookies(s, now(), config.cookieDomain)]);
    } catch (e) {
      log('link.failed', { reason: 'identity', code: codeOf(e) });
      return problem(LINK_PROBLEM.unavailable);
    }
  }

  const handlers = { start, callback, logout, reauthStart, reauthToken, linkProposal, separateAccount, linkStart };

  /** 경로표대로 고른다(시험과 로컬 대역 서버가 쓴다. Next에서는 경로 파일이 처리기를 바로 부른다) */
  async function dispatch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    for (const r of LOGIN_ROUTES) {
      const m = r.pattern.exec(path);
      if (m && req.method === r.method) return r.handler === 'logout' || r.handler === 'reauthToken' ? handlers[r.handler](req) : handlers[r.handler](req, m[1] ?? '');
    }
    return respond(404, '없음');
  }

  return { ...handlers, dispatch, close: () => identity.close() };
}

export type SocialLogin = ReturnType<typeof createSocialLogin>;

/** 로그인 경로표(identity §2). file은 app/(request) 아래 Next 경로 파일 자리다 */
export const LOGIN_ROUTES = [
  { method: 'POST', pattern: /^\/login\/(kakao|naver|google)$/, file: '/login/[provider]', handler: 'start' },
  { method: 'GET', pattern: /^\/login\/callback\/(kakao|naver|google)$/, file: '/login/callback/[provider]', handler: 'callback' },
  { method: 'POST', pattern: /^\/logout$/, file: '/logout', handler: 'logout' },
  { method: 'POST', pattern: /^\/reauth\/(kakao|naver|google)$/, file: '/reauth/[provider]', handler: 'reauthStart' },
  { method: 'POST', pattern: /^\/reauth\/token$/, file: '/reauth/token', handler: 'reauthToken' },
  { method: 'POST', pattern: /^\/link\/(kakao|naver|google)$/, file: '/link/[provider]', handler: 'linkStart' },
  { method: 'GET', pattern: /^\/v1\/identity\/link-proposals\/([A-Za-z0-9_-]{22})$/, file: '/v1/identity/link-proposals/[proposalId]', handler: 'linkProposal' },
  { method: 'POST', pattern: /^\/v1\/identity\/link-proposals\/([A-Za-z0-9_-]{22})\/separate-account$/, file: '/v1/identity/link-proposals/[proposalId]/separate-account', handler: 'separateAccount' },
] as const;
