// 시트·대화상자(CMP-019). 휴대폰(768 미만)은 아래 시트, 태블릿·데스크톱은 가운데 대화상자다(보드 SCR-008 m·t·d).
// 열리면 뒤 화면을 inert로 두고 초점을 가두며, Esc나 바깥 누름으로 닫고 연 버튼으로 초점을 돌려준다.
import { h } from '../dom';

export interface ModalCtx {
  /** true면 대화상자 모양(md 이상), false면 아래 시트 모양 */
  wide: boolean;
  close(): void;
}
/** 대화상자 상자(role="dialog"를 단 .sheet 또는 .dialog)를 만든다. 첫 초점은 data-autofocus 요소 */
export type ModalBuild = (ctx: ModalCtx) => HTMLElement;

const wideQuery = window.matchMedia('(min-width: 768px)');

interface Open {
  build: ModalBuild;
  opener: HTMLElement | null;
  onClose?: () => void;
}
let current: Open | null = null;

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function host(): HTMLElement {
  return document.getElementById('modal-root') ?? document.body;
}

function mount(): void {
  if (!current) return;
  const wide = wideQuery.matches;
  const box = current.build({ wide, close: () => closeModal() });
  if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
  const scrim = h('div', { class: wide ? 'scrim q-scrim' : 'scrim bottom q-scrim' }, box);
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) closeModal();
  });
  host().replaceChildren(scrim);
  const page = document.getElementById('root');
  if (page) page.inert = true;
  document.body.classList.add('q-lock');
  const first = box.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(box)[0] ?? box;
  first.focus();
}

/** 시트·대화상자를 연다. opener는 닫은 뒤 초점이 돌아갈 버튼 */
export function openModal(build: ModalBuild, opener: HTMLElement | null, onClose?: () => void): void {
  if (current) closeModal(false);
  current = { build, opener, onClose };
  mount();
}

export function closeModal(restoreFocus = true): void {
  if (!current) return;
  const { opener, onClose } = current;
  current = null;
  host().replaceChildren();
  const page = document.getElementById('root');
  if (page) page.inert = false;
  document.body.classList.remove('q-lock');
  if (restoreFocus && opener?.isConnected) opener.focus();
  onClose?.();
}

export const isModalOpen = (): boolean => current !== null;

document.addEventListener('keydown', (e) => {
  if (!current) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal();
    return;
  }
  if (e.key !== 'Tab') return;
  const box = host().querySelector<HTMLElement>('[role="dialog"]');
  if (!box) return;
  const items = focusables(box);
  if (items.length === 0) {
    e.preventDefault();
    box.focus();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// 폭이 768을 넘나들면 열린 상자를 시트↔대화상자로 다시 그린다
wideQuery.addEventListener('change', () => {
  if (current) mount();
});
