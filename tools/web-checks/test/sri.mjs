// BAT-172 같은 출처 스크립트의 SRI 판정(ASVS v5.0.0-3.6.1, ADR-0326, docs/frontend.md §5.14.2).
// 브라우저·파일 없이 시험할 수 있게 순수 함수만 둔다(csp/web.spec.mjs가 쓰고 lib/sri.test.mjs가 본다).
// - 우리 문서가 싣는 같은 출처 스크립트(/_next/ 밖): integrity가 sha256-… 꼴이고 받은 바이트 SHA-256과 같아야 한다.
// - Next.js /_next/static/ 덩어리: 같은 빌드 SRI 표(subresource-integrity-manifest.json) 키가 있고 받은 바이트 SHA-256이 표와 같아야 한다.
//   태그에 integrity가 있으면 그 값도 표와 같아야 한다(Next.js가 시작 덩어리에 다는 값).
// - 다른 출처: 이 모듈은 가르기만 하고, 허용 출처 판정은 부르는 쪽이 정본 표(lib/canon.mjs)로 한다.
import { createHash } from 'node:crypto';

/** 브라우저 SRI 꼴: sha256- + base64 44글자(43글자 + '='). md5·접두 없음·빈 값은 틀린 꼴이다 */
export const SRI_SHA256_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

/** @param {unknown} value @returns {boolean} */
export const isSriSha256 = (value) => typeof value === 'string' && SRI_SHA256_PATTERN.test(value);

/**
 * 받은 바이트의 SRI 값. 문자열이면 UTF-8 바이트로 센다(빌드 보조 스크립트와 같은 셈).
 * @param {string | Buffer | Uint8Array} bytes
 * @returns {string} `sha256-<base64>`
 */
export const integrityOfBytes = (bytes) => `sha256-${createHash('sha256').update(bytes).digest('base64')}`;

/**
 * 상대·절대·`?dpl=` 주소를 기준 출처로 푼다. 쿼리는 버리고 출처·경로만 남긴다(바이트는 쿼리와 무관하다).
 * @param {string} src
 * @param {string} base 기준 출처나 주소
 * @returns {{origin: string, pathname: string, key: string}} key는 `출처+경로`(같은 파일을 한 번만 받는 열쇠)
 */
export function scriptUrlOf(src, base) {
  const url = new URL(src, base);
  return { origin: url.origin, pathname: url.pathname, key: url.origin + url.pathname };
}

/**
 * `/_next/` 아래 주소의 SRI 표 키. `/_next/static/chunks/a.js?dpl=…` → `static/chunks/a.js`.
 * `/_next/` 밖(우리 문서가 싣는 스크립트)이면 null.
 * @param {string} src
 * @param {string} base
 * @returns {string | null}
 */
export function manifestKeyOf(src, base) {
  const { pathname } = new URL(src, base);
  return pathname.startsWith('/_next/') ? pathname.slice('/_next/'.length) : null;
}

/** HTML 속성 하나를 큰따옴표·작은따옴표·따옴표 없음 차례로 읽는다 */
function attrValue(attrs, name) {
  const quoted = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs);
  if (quoted) return quoted[1];
  const single = new RegExp(`(?:^|\\s)${name}\\s*=\\s*'([^']*)'`, 'i').exec(attrs);
  if (single) return single[1];
  const bare = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*([^\\s"\'=<>`]+)', 'i').exec(attrs);
  return bare ? bare[1] : undefined;
}

/**
 * HTML 글에서 실행 스크립트 태그(`src` 있음)의 `{src, integrity}`를 모은다.
 * 인라인 스크립트(`src` 없음)는 SRI 대상이 아니라 세지 않는다. 속성 순서·따옴표를 가리지 않는다.
 * @param {string} html
 * @returns {Array<{src: string, integrity: string}>}
 */
export function scriptTagsFromHtml(html) {
  const tags = [];
  for (const m of String(html).matchAll(/<script\b([^>]*)>/gi)) {
    const src = attrValue(m[1], 'src');
    if (!src) continue;
    tags.push({ src: src.replace(/&amp;/g, '&'), integrity: (attrValue(m[1], 'integrity') ?? '').replace(/&amp;/g, '&') });
  }
  return tags;
}

/**
 * 빌드 SRI 표(`server/subresource-integrity-manifest.json`)를 키→값 Map으로 읽는다.
 * 키는 `static/…` 꼴(앞 `/_next/` 없음)이고 값은 `sha256-…`이다. 빈 표나 틀린 값은 던진다.
 * @param {unknown} json
 * @returns {Map<string, string>}
 */
export function parseSriManifest(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error('SRI 표가 객체가 아니다');
  const entries = Object.entries(json);
  if (entries.length === 0) throw new Error('SRI 표 키가 0개다');
  const manifest = new Map();
  for (const [key, value] of entries) {
    if (!key || key.startsWith('/')) throw new Error(`SRI 표 키가 Next.js 꼴(앞 / 없는 static/…)이 아니다: ${key}`);
    if (!isSriSha256(value)) throw new Error(`SRI 표 값이 sha256-… 꼴이 아니다: ${key} ${value}`);
    manifest.set(key, value);
  }
  return manifest;
}

/**
 * 같은 출처 태그 하나를 가른다. 다른 출처면 kind만 'foreign'이고 problems는 빈다(허용 출처는 부르는 쪽이 본다).
 * @param {{src: string, integrity?: string}} tag
 * @param {{origin: string, manifest: Map<string, string>, hashes?: Map<string, string | null>, compareBytes?: boolean}} ctx
 *   hashes: `scriptUrlOf().key` → 받은 바이트 SHA-256(못 받았으면 null).
 *   compareBytes=false: `/_next/static/` 덩어리의 바이트 대조를 생략한다(60초 한계, 감독 결정 5). 우리 것(/_next/ 밖)은 늘 대조한다.
 * @returns {{kind: 'own' | 'framework' | 'foreign', key: string | null, problems: string[]}}
 */
export function judgeScript(tag, ctx) {
  const here = scriptUrlOf(tag.src, ctx.origin);
  if (here.origin !== ctx.origin) return { kind: 'foreign', key: null, problems: [] };
  const integrity = tag.integrity ?? '';
  const key = manifestKeyOf(tag.src, ctx.origin);
  const problems = [];
  if (key === null) {
    if (!isSriSha256(integrity)) {
      problems.push(`${here.pathname}: 같은 출처 스크립트에 sha256-… 꼴 integrity가 없다(값: ${integrity || '없음'})`);
    } else {
      const got = ctx.hashes?.get(here.key);
      if (!got) problems.push(`${here.pathname}: integrity를 대조할 받은 바이트 SHA-256이 없다`);
      else if (got !== integrity) problems.push(`${here.pathname}: integrity ${integrity}가 받은 바이트 ${got}와 다르다`);
    }
    return { kind: 'own', key: null, problems };
  }
  if (!key.startsWith('static/')) problems.push(`${here.pathname}: /_next/ 밑이지만 /_next/static/이 아니다`);
  const want = ctx.manifest.get(key);
  if (!want) problems.push(`${here.pathname}: 빌드 SRI 표에 키가 없다(${key})`);
  if (integrity && !isSriSha256(integrity)) problems.push(`${here.pathname}: integrity가 sha256-… 꼴이 아니다(값: ${integrity})`);
  if (isSriSha256(integrity) && want && integrity !== want) problems.push(`${here.pathname}: 태그 integrity ${integrity}가 SRI 표 ${want}와 다르다`);
  if (ctx.compareBytes !== false) {
    const got = ctx.hashes?.get(here.key);
    if (!got) problems.push(`${here.pathname}: 받은 바이트 SHA-256이 없다`);
    else if (want && got !== want) problems.push(`${here.pathname}: 받은 바이트 ${got}가 SRI 표 ${want}와 다르다`);
  }
  return { kind: 'framework', key, problems };
}

/**
 * 태그 목록을 가르고 문제를 모은다. 같은 출처 태그 0개·SRI 표 키 0개·우리 것 0개는 빈 결과라 실패다.
 * @param {Array<{src: string, integrity?: string}>} tags
 * @param {{origin: string, manifest: Map<string, string>, hashes?: Map<string, string | null>, compareBytes?: boolean}} ctx
 * @returns {{problems: string[], own: Array<{src: string, integrity?: string, key: null}>, framework: Array<{src: string, integrity?: string, key: string | null}>, foreign: Array<{src: string, integrity?: string}>, keys: Set<string>}}
 */
export function judgeScripts(tags, ctx) {
  const problems = [];
  const own = [];
  const framework = [];
  const foreign = [];
  for (const tag of tags) {
    const verdict = judgeScript(tag, ctx);
    if (verdict.kind === 'foreign') {
      foreign.push(tag);
      continue;
    }
    if (verdict.kind === 'own') own.push({ ...tag, key: null });
    else framework.push({ ...tag, key: verdict.key });
    problems.push(...verdict.problems);
  }
  if (own.length === 0) problems.unshift('같은 출처 script[src] 가운데 우리 문서가 싣는(/_next/ 밖) 스크립트가 0개다(빈 결과)');
  if (framework.length === 0) problems.unshift('/_next/static/ script[src]가 0개다(빈 결과)');
  if (ctx.manifest.size === 0) problems.unshift('빌드 SRI 표 키가 0개다(빈 결과)');
  const keys = new Set(framework.map((t) => t.key).filter(Boolean));
  if (keys.size === 0) problems.push('/_next/static/ 덩어리의 SRI 표 키를 하나도 보지 못했다(빈 결과)');
  return { problems, own, framework, foreign, keys };
}
