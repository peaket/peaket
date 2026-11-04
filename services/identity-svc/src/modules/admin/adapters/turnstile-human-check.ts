// 사람 확인 토큰의 서버 검증(Cloudflare Turnstile siteverify, docs/security/auth-controls.md §2.3, identity §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', BUILD_ORDER BOT-111).
// identity가 직접 부른다(trust-svc를 거치지 않는다). hostname은 콘솔마다 설정값, action은 login이어야 한다. 2초 [가정] 안에 답이 없으면 같은 idempotency_key로 한 번 더 묻는다.
// 비밀이 없으면 늘 UNAVAILABLE(사람 확인이 필요한 로그인은 받지 않는다). 로컬·시험은 흉내 서버 주소를 준다.
import { randomUUID } from 'node:crypto';
import type { AdminAud, HumanCheck } from '../domain/ports.js';

export const DEFAULT_TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_ACTION = 'login';
const TIMEOUT_MS = 2_000;

export class TurnstileHumanCheck implements HumanCheck {
  constructor(
    private readonly o: { url?: string; secret: string | undefined; hostnames: Record<AdminAud, string>; timeoutMs?: number; fetch?: typeof fetch },
  ) {}

  async verify(token: string, ctx: { aud: AdminAud; remoteIp: string }): Promise<'OK' | 'FAILED' | 'UNAVAILABLE'> {
    if (!this.o.secret) return 'UNAVAILABLE';
    const key = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.#once(token, ctx, key);
      if (r !== 'RETRY') return r;
    }
    return 'UNAVAILABLE';
  }

  async #once(token: string, ctx: { aud: AdminAud; remoteIp: string }, idempotencyKey: string): Promise<'OK' | 'FAILED' | 'RETRY'> {
    const f = this.o.fetch ?? fetch;
    const body = new URLSearchParams({ secret: this.o.secret!, response: token, remoteip: ctx.remoteIp, idempotency_key: idempotencyKey });
    let json: { success?: unknown; hostname?: unknown; action?: unknown };
    try {
      const r = await f(this.o.url ?? DEFAULT_TURNSTILE_URL, { method: 'POST', body, signal: AbortSignal.timeout(this.o.timeoutMs ?? TIMEOUT_MS) });
      if (r.status >= 500) return 'RETRY';
      json = (await r.json()) as typeof json;
    } catch {
      // 기한 넘김·연결 실패(오류에는 토큰·비밀을 싣지 않는다)
      return 'RETRY';
    }
    // 다른 콘솔에서 받은 토큰을 옮겨 쓰지 못하게 hostname과 action을 견준다(§2.3)
    return json.success === true && json.hostname === this.o.hostnames[ctx.aud] && json.action === TURNSTILE_ACTION ? 'OK' : 'FAILED';
  }
}

/** 설정: PEAKET_TURNSTILE_URL(local·ci 밖은 https), PEAKET_TURNSTILE_SECRET, PEAKET_TURNSTILE_HOSTNAME_PARTNER·_OPS(기본 partner.peaket.example·console.peaket.example) */
export function turnstileFromEnv(env: Record<string, string | undefined>): TurnstileHumanCheck {
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
  });
}
