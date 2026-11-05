// 사람 확인 토큰의 서버 검증(Cloudflare Turnstile siteverify, docs/security/auth-controls.md §2.3, identity §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', BUILD_ORDER BOT-111).
// identity가 직접 부른다(trust-svc를 거치지 않는다). hostname은 콘솔마다 설정값, action은 login이어야 한다. 2초 [가정] 안에 답이 없으면 같은 idempotency_key로 한 번 더 묻는다.
// 비밀이 없으면 늘 UNAVAILABLE(사람 확인이 필요한 로그인은 받지 않는다). 로컬·시험은 흉내 서버 주소를 준다.
// 호출은 차단기로 감싼다(docs/architecture.md §5 '2차 서비스 내부 차단', BOT-111이 넘긴 것): 5xx·3xx·기한 넘김·연결 실패를 실패로 세고, 열렸거나 동시 호출 상한이 차면
// 부르지 않고 UNAVAILABLE이다(한 번 더 묻지도 않는다). 토큰이 틀린 답(success false)은 서비스가 답한 것이라 세지 않는다.
// 부르는 것은 플랫폼 바깥 호출 클라이언트다(docs/api/guidelines.md §8, 2026-11-05 새 맥락 검토): 추적 머리(traceparent 등)를 싣지 않고 span은 경로 틀 하나이며,
// 리디렉트를 따르지 않고(307·308이 비밀이 든 본문을 다른 호스트로 다시 보내지 않게), 기한은 min(2초, 요청의 남은 시간)이고, 응답 본문은 64KiB [가정]까지만 읽는다.
import { randomUUID } from 'node:crypto';
import { type CircuitBreaker, type CircuitBreakerOptions, createExternalHttpClient, type ExternalHttpClient, ProblemError } from '@peaket/platform';
import type { AdminAud, HumanCheck } from '../domain/ports.js';
import { boundedText } from './bounded-text.js';

export const DEFAULT_TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_ACTION = 'login';
const TIMEOUT_MS = 2_000;
/** 응답 본문 상한 [가정]: siteverify 답은 몇백 바이트다 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 사람 확인 차단기의 설정 [가정](docs/architecture.md §5 '2차 서비스 내부 차단', identity §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현'). 창·실패율·열린 시간은 공용 기본값(10초·50%·5초)이다.
 * 관리 계정 로그인의 사람 확인은 드문 호출이라 판정 문턱을 5건으로 낮추고, 파드마다 동시 호출 상한(벌크헤드)은 50건이다(한 건이 2초 기한 두 번이라 초당 약 12건까지)
 */
export const TURNSTILE_BREAKER: Readonly<Pick<CircuitBreakerOptions, 'minCalls' | 'maxConcurrent'>> = Object.freeze({ minCalls: 5, maxConcurrent: 50 });

/** 차단기가 부르지 않은 거절(열림 503·동시 호출 상한 429·남은 시간 없음 504). 다시 묻지 않는다 */
const notCalled = (e: unknown) => e instanceof ProblemError && (e.slug === 'dependency-unavailable' || e.slug === 'server-busy' || e.slug === 'deadline-exceeded');
type Verdict = { success?: unknown; hostname?: unknown; action?: unknown };

export class TurnstileHumanCheck implements HumanCheck {
  readonly #http: ExternalHttpClient;
  /** 검증 주소의 마지막 경로 조각(/siteverify). 앞부분은 클라이언트의 기본 주소다 */
  readonly #path: string;

  constructor(
    private readonly o: { url?: string; secret: string | undefined; hostnames: Record<AdminAud, string>; timeoutMs?: number; fetch?: typeof fetch; breaker?: Pick<CircuitBreaker, 'run'> },
  ) {
    const u = new URL(o.url ?? DEFAULT_TURNSTILE_URL);
    if (u.search || u.hash || u.username || u.password) throw new TypeError('사람 확인 주소에는 쿼리·조각·사용자 정보를 두지 않는다');
    const cut = u.pathname.lastIndexOf('/');
    this.#path = u.pathname.slice(cut) || '/';
    if (/[{}]/.test(this.#path)) throw new TypeError('사람 확인 주소의 경로에 { }를 두지 않는다');
    this.#http = createExternalHttpClient({ provider: 'turnstile', baseUrl: `${u.origin}${u.pathname.slice(0, cut)}`, timeoutCapMs: o.timeoutMs ?? TIMEOUT_MS, ...(o.fetch ? { fetch: o.fetch } : {}) });
  }

  async verify(token: string, ctx: { aud: AdminAud; remoteIp: string }): Promise<'OK' | 'FAILED' | 'UNAVAILABLE'> {
    if (!this.o.secret) return 'UNAVAILABLE';
    const key = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.#once(token, ctx, key);
      if (r === 'STOP') return 'UNAVAILABLE';
      if (r !== 'RETRY') return r;
    }
    return 'UNAVAILABLE';
  }

  async #once(token: string, ctx: { aud: AdminAud; remoteIp: string }, idempotencyKey: string): Promise<'OK' | 'FAILED' | 'RETRY' | 'STOP'> {
    let json: Verdict;
    try {
      json = await (this.o.breaker ? this.o.breaker.run(() => this.#call(token, ctx, idempotencyKey)) : this.#call(token, ctx, idempotencyKey));
    } catch (e) {
      // 차단기가 부르지 않았으면 그대로 끝낸다. 기한 넘김·연결 실패·5xx는 한 번 더 묻는다(오류에는 토큰·비밀을 싣지 않는다)
      return notCalled(e) ? 'STOP' : 'RETRY';
    }
    // 다른 콘솔에서 받은 토큰을 옮겨 쓰지 못하게 hostname과 action을 견준다(§2.3)
    return json.success === true && json.hostname === this.o.hostnames[ctx.aud] && json.action === TURNSTILE_ACTION ? 'OK' : 'FAILED';
  }

  /** siteverify 한 번. 5xx·3xx(따르지 않은 리디렉트)·기한 넘김·연결 실패·본문을 읽지 못함(상한 넘음 포함)은 던진다(차단기가 실패로 센다) */
  async #call(token: string, ctx: { aud: AdminAud; remoteIp: string }, idempotencyKey: string): Promise<Verdict> {
    const body = new URLSearchParams({ secret: this.o.secret!, response: token, remoteip: ctx.remoteIp, idempotency_key: idempotencyKey });
    const r = await this.#http.request({ method: 'POST', path: this.#path, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (r.status >= 500 || (r.status >= 300 && r.status < 400)) {
      await r.body?.cancel();
      throw new Error(`siteverify ${r.status}`);
    }
    return JSON.parse(await boundedText(r, MAX_BODY_BYTES)) as Verdict;
  }
}

/**
 * 설정: PEAKET_TURNSTILE_URL(local·ci 밖은 https), PEAKET_TURNSTILE_SECRET, PEAKET_TURNSTILE_HOSTNAME_PARTNER·_OPS(기본 partner.peaket.example·console.peaket.example).
 * breaker: 사람 확인 차단기(main이 TURNSTILE_BREAKER로 만든다)
 */
export function turnstileFromEnv(env: Record<string, string | undefined>, breaker?: Pick<CircuitBreaker, 'run'>): TurnstileHumanCheck {
  const url = env.PEAKET_TURNSTILE_URL || DEFAULT_TURNSTILE_URL;
  const local = ['local', 'ci'].includes(env.PEAKET_ENV ?? 'prod');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('PEAKET_TURNSTILE_URL이 주소 꼴이 아니다');
  }
  if (!local && parsed.protocol !== 'https:') throw new Error('PEAKET_TURNSTILE_URL은 local·ci 밖에서 https 주소여야 한다');
  return new TurnstileHumanCheck({
    url,
    secret: env.PEAKET_TURNSTILE_SECRET || undefined,
    hostnames: { partner: env.PEAKET_TURNSTILE_HOSTNAME_PARTNER || 'partner.peaket.example', ops: env.PEAKET_TURNSTILE_HOSTNAME_OPS || 'console.peaket.example' },
    ...(breaker ? { breaker } : {}),
  });
}
