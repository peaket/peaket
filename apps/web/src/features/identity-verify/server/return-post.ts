// 본인확인 복귀 화면의 서버 처리기(docs/features/identity.md §5 '복귀 화면의 서버 처리기', BUILD_ORDER BOT-010, I-T45).
// 기관이 `/verify/return`으로 POST한 결과 값을 읽어, 그 화면을 그리는 서버 쪽에만 내부 요청 머리로 넘긴다.
// - 본문은 application/x-www-form-urlencoded, 16KiB·칸 32개·칸 이름 64자(영문·숫자·_-.)·값 4,096자 [가정] 이하만 받는다
// - 바깥 요청의 같은 이름 머리는 늘 지운다. 값은 저장·로그하지 않는다. 응답은 private, no-store와 no-referrer
// Next.js 가로채기(apps/web/proxy.ts)가 이 함수를 부른다. 웹 표준 Request만 받아 시험할 수 있다.
export const RETURN_HEADER = 'x-peaket-verify-return';
export const RETURN_LIMITS = { bodyBytes: 16 * 1024, fields: 32, nameLength: 64, valueLength: 4096 } as const;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
// COOP unsafe-none: 기관 화면(COOP 없음)에서 이 화면으로 넘어올 때 창 묶음이 바뀌면 부르는 화면이 열린 팝업을 닫힌 것으로 본다.
// 이 화면만 소비자 웹 기본값(same-origin-allow-popups)의 예외다(docs/features/identity.md §5, asvs/catalog-review.md 3.4.8, 새 맥락 리뷰 M1)
const RESPONSE_HEADERS = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'unsafe-none' } as const;

/** 크기 상한까지만 본문을 읽는다(넘으면 null) */
async function readLimited(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

function validFields(entries: [string, string][]): Record<string, string> | null {
  if (entries.length === 0 || entries.length > RETURN_LIMITS.fields) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!NAME.test(k) || v.length > RETURN_LIMITS.valueLength || Object.hasOwn(out, k)) return null;
    out[k] = v;
  }
  return out;
}

/** 기관이 POST한 양식 본문 → 칸. 형식·크기가 틀리면 null */
export async function readAgencyPost(req: Request): Promise<Record<string, string> | null> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return null;
  const text = await readLimited(req, RETURN_LIMITS.bodyBytes);
  if (text === null) return null;
  return validFields([...new URLSearchParams(text).entries()]);
}

export const encodeAgencyFields = (f: Record<string, string>): string => Buffer.from(JSON.stringify(f), 'utf8').toString('base64url');

/** 내부 머리 값 → 칸(모양을 다시 본다). 없거나 틀리면 null */
export function decodeAgencyFields(v: string | null | undefined): Record<string, string> | null {
  if (!v || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  let o: unknown;
  try {
    o = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const entries = Object.entries(o as Record<string, unknown>);
  if (!entries.every((e): e is [string, string] => typeof e[1] === 'string')) return null;
  return validFields(entries);
}

export type ProxyDecision =
  | { kind: 'next'; requestHeaders: Headers; responseHeaders: typeof RESPONSE_HEADERS }
  | { kind: 'reject'; status: 400 | 405; responseHeaders: typeof RESPONSE_HEADERS };

/** `/verify/return` 요청을 어떻게 넘길지 정한다 */
export async function verifyReturnProxy(req: Request): Promise<ProxyDecision> {
  const headers = new Headers(req.headers);
  headers.delete(RETURN_HEADER);
  if (req.method === 'GET' || req.method === 'HEAD') return { kind: 'next', requestHeaders: headers, responseHeaders: RESPONSE_HEADERS };
  if (req.method !== 'POST') return { kind: 'reject', status: 405, responseHeaders: RESPONSE_HEADERS };
  const fields = await readAgencyPost(req);
  if (!fields) return { kind: 'reject', status: 400, responseHeaders: RESPONSE_HEADERS };
  // 이 화면에는 서버 액션이 없다. 기관 POST가 서버 액션 요청으로 읽히지 않게 그 머리를 지운다
  headers.delete('next-action');
  headers.set(RETURN_HEADER, encodeAgencyFields(fields));
  return { kind: 'next', requestHeaders: headers, responseHeaders: RESPONSE_HEADERS };
}
