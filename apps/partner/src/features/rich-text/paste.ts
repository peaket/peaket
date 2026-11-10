// 붙여넣은 HTML을 편집기가 해석하기 전에 걷어 낼 것(FE-T41 PoC, BUILD_ORDER HOT-322).
// 보안은 저장할 때 허용 노드 다섯만 남기는 구조 문서(doc.ts)가 맡는다. 이 단계는 해석 중에 CSP 위반 보고가 나지 않게 하려는 것이다:
// Chromium은 해석만 하는 문서에서도 <style>·이벤트 속성(on…)을 막고 위반을 보고한다(Word 글에는 <style>이 늘 들어 있다).
// 그래서 해석 전에 <style>·<script>·<meta>·<link>·주석·<img>와 on… 속성을 지운다. style 속성은 굵기 값만 남긴다(Google 문서는 굵기를 style로만 알린다).
// 정규식은 해석기 대신이 아니라 보고를 줄이는 거름이다. 닫는 꼬리표가 없는 큰 입력에서도 입력 크기에 비례해 끝나게 쓴다.

const BLOCK_NAMES = ['style', 'script', 'template', 'noscript', 'iframe', 'object'];
const BLOCK_OPEN = new RegExp(`<(${BLOCK_NAMES.join('|')})\\b`, 'gi');
const BLOCK_CLOSE = new Map(BLOCK_NAMES.map((n) => [n, new RegExp(`</${n}\\s*>`, 'gi')]));
const COMMENT_OPEN = /<!--/g;
/** 주석 끝은 --!>도 된다(HTML 해석기 규칙, CodeQL js/bad-tag-filter) */
const COMMENT_CLOSE = /--!?>/g;
/** 짝 없이 남은 여는·닫는 꼬리표(<scr<script></script>ipt> 같은 것을 걷은 뒤 남는 것)와 빈 꼬리표 */
const LONE_NAMES = new Set([...BLOCK_NAMES, 'meta', 'link', 'img', 'base', 'input']);
/** 여는 꼬리표 전체(따옴표 안의 >는 꼬리표 끝이 아니다). 닫는 꼬리표(이름 앞이 /)는 맞지 않는다 */
const TAG = /^<([a-z][a-z0-9-]*)((?:"[^"]*"|'[^']*'|[^'"<>])*)>$/i;
/** 닫는 꼬리표(걸러야 할 이름이면 통째로 지운다) */
const CLOSE_TAG = /^<\/([a-z][a-z0-9-]*)\s*>$/i;
/** 꼬리표 안의 속성 하나(따옴표 값을 통째로) */
const ATTR = /\s+([^\s"'=<>\/]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
/** 이만큼 되풀이해도 바뀌면 멈춘다(걷은 자리에서 꼬리표가 되살아나는 것을 막는다) */
const MAX_ROUNDS = 8;

const FONT_WEIGHT = /(?:^|;)\s*font-weight\s*:\s*([a-z0-9]+)\s*(?:;|$)/i;

function keepAttrs(attrs: string): string {
  return attrs.replace(ATTR, (m: string, name: string, value: string | undefined) => {
    if (/^on/i.test(name)) return '';
    if (!/^style$/i.test(name)) return m;
    const weight = FONT_WEIGHT.exec((value ?? '').replace(/^\s*=\s*/, '').replace(/^["']|["']$/g, ''));
    return weight ? ` style="font-weight:${weight[1]}"` : '';
  });
}

/** 여는 표시부터 짝이 되는 닫는 표시까지 지운다. 닫는 표시가 더 없는 이름은 다시 찾지 않는다 */
function removeBetween(html: string, open: RegExp, closeFor: (m: RegExpExecArray) => RegExp): string {
  const closed = new Set<RegExp>();
  let out = '';
  let at = 0;
  open.lastIndex = 0;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const close = closeFor(m);
    if (closed.has(close)) continue;
    close.lastIndex = open.lastIndex;
    if (close.exec(html) === null) {
      closed.add(close);
      continue;
    }
    out += html.slice(at, m.index);
    at = close.lastIndex;
    open.lastIndex = at;
  }
  return out + html.slice(at);
}

/** start의 <부터 짝이 되는 >까지(따옴표 안의 >는 건너뛴다). 없으면 -1 */
function tagEndAt(html: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

/**
 * 꼬리표를 한 번 훑어 걸러야 할 꼬리표(짝 없이 남은 것 포함)는 지우고, 남는 여는 꼬리표는 속성을 거른다.
 * replace 사슬 대신 앞에서부터 읽어 새 꼬리표가 되살아나는 자리를 다시 보지 않는다(걷은 자리는 바깥 되풀이가 다시 본다)
 */
function rewriteTags(html: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const lt = html.indexOf('<', at);
    if (lt < 0) return out + html.slice(at);
    out += html.slice(at, lt);
    const end = tagEndAt(html, lt);
    if (end < 0) return out + html.slice(lt);
    const raw = html.slice(lt, end + 1);
    const m = TAG.exec(raw);
    const close = m ? null : CLOSE_TAG.exec(raw);
    if (m) {
      if (!LONE_NAMES.has(m[1]!.toLowerCase())) out += `<${m[1]}${keepAttrs(m[2]!)}>`;
    } else if (close && LONE_NAMES.has(close[1]!.toLowerCase())) {
      // 걸러야 할 닫는 꼬리표는 지운다
    } else out += raw;
    at = end + 1;
  }
}

function strip(html: string): string {
  const noComments = removeBetween(html, COMMENT_OPEN, () => COMMENT_CLOSE);
  return rewriteTags(removeBetween(noComments, BLOCK_OPEN, (m) => BLOCK_CLOSE.get(m[1]!.toLowerCase())!));
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

const LIST_ITEM_BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE']);
const hasContent = (n: Node | null): boolean => n !== null && n.nodeName !== 'BR' && (n.nodeType !== 3 || (n.textContent ?? '').trim() !== '');

/**
 * 해석한 문서(화면에 붙이지 않는다)의 목록을 저장될 모양으로 바꾼다(ADR-0247 결정 2): 안쪽 목록은 펼치고, 번호 시작은 지우고, 항목 안의 블록은 줄로 푼다.
 * 구조 문서의 목록은 한 단계이고 항목은 글자 줄이라, 그대로 두면 편집기에 보인 모양이 저장되지 않는다.
 */
export function normalizePastedLists(root: Document): void {
  root.querySelectorAll('ol[start]').forEach((ol) => ol.removeAttribute('start'));
  root.querySelectorAll('li[value]').forEach((li) => li.removeAttribute('value'));
  for (let nested = root.querySelector('li ul, li ol'); nested; nested = root.querySelector('li ul, li ol')) {
    const owner = nested.parentElement!.closest('li')!;
    let after: Element = owner;
    for (const item of Array.from(nested.children)) {
      if (item.tagName !== 'LI') continue;
      after.after(item);
      after = item;
    }
    nested.remove();
    if ((owner.textContent ?? '').trim() === '') owner.remove();
  }
  root.querySelectorAll('li').forEach((li) => {
    for (const block of Array.from(li.children)) {
      if (!LIST_ITEM_BLOCKS.has(block.tagName)) continue;
      if (hasContent(block.previousSibling)) block.before(root.createElement('br'));
      if (hasContent(block.nextSibling)) block.after(root.createElement('br'));
      block.replaceWith(...Array.from(block.childNodes));
    }
  });
}
