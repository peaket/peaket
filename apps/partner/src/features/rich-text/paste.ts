// 붙여넣은 HTML을 편집기가 해석하기 전에 걷어 낼 것(FE-T41 PoC, BUILD_ORDER HOT-322).
// 보안은 저장할 때 허용 노드 다섯만 남기는 구조 문서(doc.ts)가 맡는다. 이 단계는 해석 중에 CSP 위반 보고가 나지 않게 하려는 것이다:
// Chromium은 해석만 하는 문서에서도 <style>·이벤트 속성(on…)을 막고 위반을 보고한다(Word 글에는 <style>이 늘 들어 있다).
// 그래서 해석 전에 <style>·<script>·<meta>·<link>·주석·<img>와 on…·style 속성을 지운다. 정규식은 해석기 대신이 아니라 보고를 줄이는 거름이다.

const BLOCKS = /<(style|script|template|noscript|iframe|object)\b[\s\S]*?<\/\1\s*>/gi;
/** 짝 없이 남은 여는·닫는 꼬리표(<scr<script></script>ipt> 같은 것을 걷은 뒤 남는 것)와 빈 꼬리표 */
const LONE = /<\/?(?:style|script|template|noscript|iframe|object|meta|link|img|base|input)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
/** 여는 꼬리표(따옴표 안의 >는 꼬리표 끝이 아니다) */
const TAG = /<([a-z][a-z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
/** 꼬리표 안의 속성 하나(따옴표 값을 통째로) */
const ATTR = /\s+([^\s"'=<>\/]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
/** 이만큼 되풀이해도 바뀌면 멈춘다(걷은 자리에서 꼬리표가 되살아나는 것을 막는다) */
const MAX_ROUNDS = 8;

const keepAttrs = (attrs: string): string => attrs.replace(ATTR, (m: string, name: string) => (/^(?:on|style$)/i.test(name) ? '' : m));

function strip(html: string): string {
  return html
    .replace(COMMENTS, '')
    .replace(BLOCKS, '')
    .replace(LONE, '')
    .replace(TAG, (_m: string, name: string, attrs: string) => `<${name}${keepAttrs(attrs)}>`);
}

export function precleanPastedHtml(html: string): string {
  let cur = html;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const next = strip(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

type Policy = { createHTML(s: string): unknown };
let policy: Policy | null | undefined;
/** 정책을 만들지 못했다(막는 모드의 허용 목록에 이름이 없음): HTML을 해석하지 않는다 */
let blocked = false;

/**
 * 해석 전용 Trusted Types 정책(이름 peaket-paste). 걷어 낸 글만 넘기고, 해석한 문서는 화면에 붙이지 않는다(노드만 읽는다).
 * Trusted Types가 없는 브라우저는 걷어 낸 글을 그대로 쓴다. 정책을 만들지 못하면 null(부르는 쪽이 글자판으로 넣는다)
 */
export function pasteHtml(html: string): unknown | null {
  if (policy === undefined) {
    policy = null;
    // 정책은 문서마다 한 번만 만든다(같은 이름을 두 번 만들면 막는 모드에서 오류다)
    if ('trustedTypes' in globalThis) {
      const tt = (globalThis as unknown as { trustedTypes: { createPolicy(name: string, rules: { createHTML(s: string): string }): Policy } }).trustedTypes;
      try {
        policy = tt.createPolicy('peaket-paste', { createHTML: (s) => precleanPastedHtml(s) });
      } catch {
        // 막는 모드에서 허용 목록에 이 이름이 없으면 만들지 못한다: 해석하지 않는다(부르는 쪽이 글자판으로 넣는다)
        policy = null;
        blocked = true;
      }
    }
  }
  if (blocked) return null;
  return policy ? policy.createHTML(html) : precleanPastedHtml(html);
}
