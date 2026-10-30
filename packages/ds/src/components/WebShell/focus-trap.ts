// 겹침 창(시트·대화상자·메뉴)의 초점 가두기와 Esc 닫기. 열릴 때 안의 첫 초점 대상(또는 [data-autofocus])으로 옮기고,
// 닫히면 연 요소로 돌려준다. 보이지 않는 요소(display:none 조상)는 건너뛴다.
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onEscape?: () => void) {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root || root.getClientRects().length === 0) return;
    const opener = document.activeElement as HTMLElement | null;
    const preferred = root.querySelector<HTMLElement>("[data-autofocus]") ?? focusableIn(root)[0] ?? root;
    preferred.focus({ preventScroll: true });

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && onEscapeRef.current) {
        e.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (e.key !== "Tab" || !root) return;
      const list = focusableIn(root);
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [active, ref]);
}

/** 겹침 창이 열린 동안 바탕 스크롤을 막는다 */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);
}

/** 열린 동안 이 요소 바깥을 누르면 onOutside를 부른다 */
export function useOutsidePress(refs: ReadonlyArray<RefObject<HTMLElement | null>>, active: boolean, onOutside: () => void) {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    if (!active) return;
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      cb.current();
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
