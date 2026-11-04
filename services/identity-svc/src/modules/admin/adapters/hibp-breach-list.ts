// 유출 비밀번호 목록(L2) 범위 조회(Have I Been Pwned Pwned Passwords k-익명성, docs/security/auth-controls.md §4.3 3·9·10, BUILD_ORDER BOT-110, AC-T7).
// 원문(NFC) UTF-8의 SHA-1 앞 5자만 보내고 `Add-Padding: true`를 붙인다. 돌아온 뒷부분 목록에 나머지가 있고 횟수가 0보다 크면 유출이다(채움 줄은 횟수 0).
// 기한(2초 [가정]) 안에 답이 없거나 실패하면 BreachListUnavailable. 비밀번호·SHA-1·앞 5자는 로그·오류에 싣지 않는다.
import { createHash } from 'node:crypto';
import type { AdminAuthConfig } from '../domain/auth-config.js';
import { type BreachList, BreachListUnavailable } from '../domain/ports.js';

export const DEFAULT_HIBP_URL = 'https://api.pwnedpasswords.com';
export const HIBP_URL_ENV = 'PEAKET_HIBP_URL';
/** 응답 본문 상한 [가정]: 채움 응답은 800~1,000줄(줄마다 약 40바이트)이라 넉넉히 1MiB */
const MAX_BODY_BYTES = 1024 * 1024;
const LINE = /^([0-9A-Fa-f]{35}):(\d+)$/;

/** 본문을 상한까지만 읽는다(넘으면 던진다) */
async function boundedText(r: Response): Promise<string> {
  const reader = r.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('유출 목록 응답이 너무 크다');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 설정에서 만든다: 주소는 PEAKET_HIBP_URL(없으면 공개 API), 기한은 password.breach_timeout. local·ci 밖에서는 https만 받는다 */
export function hibpBreachListFromEnv(env: Record<string, string | undefined>, cfg: Pick<AdminAuthConfig, 'breachTimeoutMs'>): HibpBreachList {
  const baseUrl = env[HIBP_URL_ENV] || DEFAULT_HIBP_URL;
  const local = ['local', 'ci'].includes(env.PEAKET_ENV ?? 'prod');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`${HIBP_URL_ENV}가 주소 꼴이 아니다`);
  }
  if (!local && url.protocol !== 'https:') throw new Error(`${HIBP_URL_ENV}는 local·ci 밖에서 https 주소여야 한다`);
  return new HibpBreachList({ baseUrl, timeoutMs: cfg.breachTimeoutMs });
}

export class HibpBreachList implements BreachList {
  constructor(private readonly o: { baseUrl?: string; timeoutMs: number; fetch?: typeof fetch }) {}

  async isBreached(raw: string): Promise<boolean> {
    const sha1 = createHash('sha1').update(raw.normalize('NFC'), 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    const f = this.o.fetch ?? fetch;
    let body: string;
    try {
      const r = await f(`${(this.o.baseUrl ?? DEFAULT_HIBP_URL).replace(/\/+$/, '')}/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'user-agent': 'peaket-identity' },
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
      if (!r.ok) throw new Error(`유출 목록 응답 ${r.status}`);
      body = await boundedText(r);
    } catch (e) {
      // 원인에 주소(앞 5자 포함)가 들 수 있어 싣지 않는다
      throw new BreachListUnavailable(e instanceof Error ? e.name : undefined);
    }
    // 채움을 켰으므로 정상 응답에는 목록 줄이 반드시 있다. 한 줄도 없으면(빈 본문·HTML) '유출 없음'이 아니라 닿지 못함이다(새 맥락 리뷰 2026-11-05)
    let entries = 0;
    let hit = false;
    for (const line of body.split(/\r?\n/)) {
      const m = LINE.exec(line.trim());
      if (!m) continue;
      entries++;
      if (m[1]!.toUpperCase() === suffix && Number(m[2]) > 0) hit = true;
    }
    if (entries === 0) throw new BreachListUnavailable('EmptyRangeResponse');
    return hit;
  }
}
