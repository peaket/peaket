// 접근성 속성 도우미

/** aria-describedby처럼 id 여럿을 공백으로 잇는다. 빈 값은 뺀다 */
export function joinIds(...ids: Array<string | false | null | undefined>): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined || undefined;
}

/** 입력 칸 id에서 힌트·오류 글의 id를 만든다(Field와 FormErrorSummary가 같은 규칙을 쓴다) */
export function fieldIds(id: string) {
  return { hint: `${id}-hint`, error: `${id}-error`, label: `${id}-label` };
}

/** 이 요소나 그 안의 첫 초점 가능한 요소에 초점을 옮긴다 */
export function focusElementOrFirstFocusable(el: HTMLElement | null): boolean {
  if (!el) return false;
  const selector =
    'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  const target = el.matches(selector) ? el : el.querySelector<HTMLElement>(selector);
  if (!target) return false;
  target.focus();
  target.scrollIntoView({ block: "center" });
  return true;
}
