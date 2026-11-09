// 사람 확인 토큰의 서버 검증(Cloudflare Turnstile siteverify, docs/features/bot-defense.md §6, B-T5).
// 토큰은 300초 1회용이라 같은 idempotency_key로만 다시 묻는다. 호출은 500ms [가정]에 끊고, 남은 데드라인이 200ms [가정] 넘을 때 한 번만 다시 보낸다.
// 답이 없거나 서버 오류면 '검증 보류'(PENDING)이고, 토큰이 틀렸거나 만료·재사용이면 보통의 실패다. Cloudflare 쪽 내부 오류와 우리 비밀 키 오류는 이용자 탓이 아니어서 보류다.
// 부르는 것은 플랫폼 바깥 호출 클라이언트다(추적 머리 없음, 리디렉트 안 따름, 응답 본문 상한). 토큰·비밀은 로그·오류에 싣지 않는다.
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { type CircuitBreaker, type CircuitBreakerOptions, createExternalHttpClient, type ExternalHttpClient, ProblemError } from '@peaket/platform';
import type { HumanCheckPort, HumanCheckRequest } from '../domain/ports.js';
import type { HumanCheckResult } from '../domain/types.js';

export const DEFAULT_TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 500;
const RETRY_MIN_REMAINING_MS = 200;
/** 점수 계산과 응답에 남겨 두는 시간 [가정] */
const RESPONSE_RESERVE_MS = 50;
const MAX_BODY_BYTES = 64 * 1024;

/** 검증 API 차단기의 설정 [가정]: 창·실패율·열린 시간은 공용 기본값(10초·50%·5초)이고, 동시 호출 상한(벌크헤드)은 파드마다 1,000건이다(초당 약 2,000건 × 500ms) */
export const TURNSTILE_BREAKER: Readonly<Pick<CircuitBreakerOptions, 'maxConcurrent'>> = Object.freeze({ maxConcurrent: 1_000 });

/** 차단기가 부르지 않은 거절(열림 503·동시 호출 상한 429·남은 시간 없음 504) */
const notCalled = (e: unknown) => e instanceof ProblemError && (e.slug === 'dependency-unavailable' || e.slug === 'server-busy' || e.slug === 'deadline-exceeded');

/** 이용자의 토큰 탓인 오류 코드(Cloudflare siteverify 문서, 2026-10-30 확인). 그 밖은 Cloudflare·설정 쪽 문제로 보아 보류다 */
const TOKEN_ERRORS = new Set(['invalid-input-response', 'missing-input-response', 'timeout-or-duplicate']);

interface SiteverifyBody {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  'error-codes'?: unknown;
}

async function boundedJson(r: Response, maxBytes: number): Promise<SiteverifyBody> {
  const reader = r.body?.getReader();
  if (!reader) throw new Error('siteverify 응답 본문이 없다');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('siteverify 응답이 너무 크다');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as SiteverifyBody;
}

export class TurnstileHumanCheck implements HumanCheckPort {
  readonly #http: ExternalHttpClient;
  readonly #path: string;
  readonly #o: { secret: string | undefined; hostname: string; breaker?: Pick<CircuitBreaker, 'run'> };

  constructor(o: { url?: string; secret: string | undefined; hostname: string; fetch?: typeof fetch; breaker?: Pick<CircuitBreaker, 'run'> }) {
    const u = new URL(o.url ?? DEFAULT_TURNSTILE_URL);
    if (u.search || u.hash || u.username || u.password) throw new TypeError('사람 확인 주소에는 쿼리·조각·사용자 정보를 두지 않는다');
    const cut = u.pathname.lastIndexOf('/');
    this.#path = u.pathname.slice(cut) || '/';
    this.#http = createExternalHttpClient({ provider: 'turnstile', baseUrl: `${u.origin}${u.pathname.slice(0, cut)}`, timeoutCapMs: TIMEOUT_MS, ...(o.fetch ? { fetch: o.fetch } : {}) });
    this.#o = { secret: o.secret, hostname: o.hostname, ...(o.breaker ? { breaker: o.breaker } : {}) };
  }

  async verify(req: HumanCheckRequest): Promise<HumanCheckResult> {
    if (!this.#o.secret) return 'PENDING';
    const key = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = req.deadlineAtMs - Date.now();
      // 첫 시도는 남은 시간이 조금이라도 있으면 보내고, 다시 보내기는 남은 시간이 넉넉할 때만
      if (attempt > 0 && remaining <= RETRY_MIN_REMAINING_MS) return 'PENDING';
      const timeoutMs = Math.min(TIMEOUT_MS, Math.floor(remaining - RESPONSE_RESERVE_MS));
      if (timeoutMs <= 0) return 'PENDING';
      const r = await this.#once(req, key, timeoutMs);
      if (r === 'STOP') return 'PENDING';
      if (r !== 'RETRY') return r;
    }
    return 'PENDING';
  }

  async #once(req: HumanCheckRequest, idempotencyKey: string, timeoutMs: number): Promise<'PASSED' | 'FAILED' | 'RETRY' | 'STOP'> {
    let json: SiteverifyBody;
    try {
      const call = () => this.#call(req, idempotencyKey, timeoutMs);
      json = await (this.#o.breaker ? this.#o.breaker.run(call) : call());
    } catch (e) {
      return notCalled(e) ? 'STOP' : 'RETRY';
    }
    if (json.success === true) return json.hostname === this.#o.hostname && json.action === req.action ? 'PASSED' : 'FAILED';
    return 'FAILED';
  }

  /** siteverify 한 번. 5xx·3xx·기한 넘김·연결 실패·본문을 읽지 못함·Cloudflare/설정 쪽 오류는 던진다(차단기가 실패로 센다) */
  async #call(req: HumanCheckRequest, idempotencyKey: string, timeoutMs: number): Promise<SiteverifyBody> {
    const params: Record<string, string> = { secret: this.#o.secret!, response: req.token, idempotency_key: idempotencyKey };
    if (isIP(req.remoteIp) !== 0) params.remoteip = req.remoteIp;
    const r = await this.#http.request({ method: 'POST', path: this.#path, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), timeoutCapMs: timeoutMs });
    if (r.status >= 500 || (r.status >= 300 && r.status < 400)) {
      await r.body?.cancel();
      throw new Error(`siteverify ${r.status}`);
    }
    const json = await boundedJson(r, MAX_BODY_BYTES);
    if (json.success !== true) {
      // 토큰 탓임이 확실한 오류 코드만 실패다. 코드가 없거나(빈 응답) 그 밖의 코드는 보류다(이용자 탓으로 돌리지 않는다)
      const codes = Array.isArray(json['error-codes']) ? (json['error-codes'] as unknown[]).map(String) : [];
      if (codes.length === 0 || !codes.every((c) => TOKEN_ERRORS.has(c))) throw new Error(`siteverify 응답을 판정에 쓸 수 없다: ${codes.join(',') || '코드 없음'}`);
    }
    return json;
  }
}

/**
 * 설정: PEAKET_TURNSTILE_URL(local·ci 밖은 https), PEAKET_TURNSTILE_SECRET, PEAKET_TURNSTILE_HOSTNAME_WEB(기본 www.peaket.example).
 * breaker: 검증 API 차단기(main이 TURNSTILE_BREAKER로 만든다)
 */
export function turnstileFromEnv(env: Record<string, string | undefined>, breaker?: Pick<CircuitBreaker, 'run'>): TurnstileHumanCheck {
  const url = env.PEAKET_TURNSTILE_URL || DEFAULT_TURNSTILE_URL;
  const peaketEnv = env.PEAKET_ENV || 'prod';
  const local = ['local', 'ci'].includes(peaketEnv);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('PEAKET_TURNSTILE_URL이 주소 꼴이 아니다');
  }
  if (!local && parsed.protocol !== 'https:') throw new Error('PEAKET_TURNSTILE_URL은 local·ci 밖에서 https 주소여야 한다');
  const secret = env.PEAKET_TURNSTILE_SECRET || undefined;
  if (!secret && !local) throw new Error('PEAKET_TURNSTILE_SECRET이 없다(비밀 관리에서 넣는다)');
  return new TurnstileHumanCheck({ url, secret, hostname: env.PEAKET_TURNSTILE_HOSTNAME_WEB || 'www.peaket.example', ...(breaker ? { breaker } : {}) });
}
