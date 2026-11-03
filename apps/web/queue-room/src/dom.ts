// DOM을 직접 만드는 작은 도우미(docs/frontend.md §2.4 '뷰: DOM 템플릿 + textContent').
// 글자는 늘 텍스트 노드로 넣고 innerHTML을 쓰지 않는다. 스타일 속성(style="…")도 쓰지 않는다:
// 묶음 A′의 CSP는 인라인 스타일을 막으므로(§5.1·§5.14), 값이 바뀌는 것만 CSSOM(el.style)으로 넣는다.

export type Child = Node | string | number | null | undefined | false | readonly Child[];
type AttrValue = string | number | boolean | null | undefined;
export type Attrs = Record<string, AttrValue | ((ev: Event) => void)>;

/** 요소 하나를 만든다. `on…` 키에 함수를 주면 이벤트를 단다. true는 빈 속성, false·null·undefined는 넣지 않는다 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else if (c instanceof Node) parent.appendChild(c);
    else parent.appendChild(document.createTextNode(String(c)));
  }
}

/** 키트 아이콘(<i class="ic ic-이름" aria-hidden="true">). 글자색을 따른다 */
export function ic(name: string, extra = ''): HTMLElement {
  return h('i', { class: `ic ic-${name}${extra ? ` ${extra}` : ''}`, 'aria-hidden': 'true' });
}

/** 클래스 이름을 조건에 따라 잇는다 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** CSSOM으로 값만 넣는다(진행 막대 폭, '나' 표시 자리처럼 데이터에서 오는 값) */
export function setVars(el: HTMLElement, vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}
