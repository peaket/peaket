'use client';
// 탭 묶음 공통 논리(CMP-030): 고른 값, 방향키·Home·End 이동(roving tabindex), 탭·패널 id
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useControllable } from '../../lib/hooks';
import { rovingIndex } from '../../lib/keys';

export interface TabItem {
  /** 값(패널 이름) */
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export function useTabs(
  items: readonly TabItem[],
  value: string | undefined,
  defaultValue: string | undefined,
  onValueChange: ((value: string) => void) | undefined,
  options: { vertical?: boolean; activation?: 'auto' | 'manual' } = {},
) {
  const base = useId();
  const [current, setCurrent] = useControllable(value, defaultValue ?? items[0]?.value ?? '', onValueChange);
  const refs = useRef<Array<HTMLElement | null>>([]);
  const index = Math.max(
    0,
    items.findIndex((i) => i.value === current),
  );
  const tabId = (v: string) => `${base}-tab-${v}`;
  const panelId = (v: string) => `${base}-panel-${v}`;

  const onKeyDown = (event: KeyboardEvent, from: number) => {
    const next = rovingIndex(event, from, items.length, {
      vertical: options.vertical,
      isDisabled: (i) => Boolean(items[i]?.disabled),
    });
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    const item = items[next];
    if (item && options.activation !== 'manual') setCurrent(item.value);
  };

  return { current, index, setCurrent, refs, tabId, panelId, onKeyDown };
}
