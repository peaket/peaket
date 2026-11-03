'use client';
// CMP-030 chip 변형: 칩 모양 탭(홈 장르별 랭킹의 장르 칩 탭, 내 문의 내역 칩). role=tablist·tab, ←→·Home·End.
// 마크업은 .row.wrap 안의 .chip(고른 칩 .is-selected)이다. 패널은 children(value)로 그린다.
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { useTabs, type TabItem } from '../Tabs/useTabs';
import { chipClass } from './Chip';

export interface ChipTabsProps {
  items: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  label?: string;
  labelledBy?: string;
  size?: 'md' | 'sm';
  /** 한 줄로 두고 가로로 밀어 보기(기본은 줄바꿈) */
  scroll?: boolean;
  children?: (value: string) => ReactNode;
  className?: string;
  panelClassName?: string;
}

export function ChipTabs({
  items,
  value,
  defaultValue,
  onValueChange,
  label,
  labelledBy,
  size = 'md',
  scroll = false,
  children,
  className,
  panelClassName,
}: ChipTabsProps) {
  const { current, refs, tabId, panelId, onKeyDown, setCurrent } = useTabs(items, value, defaultValue, onValueChange);
  const hasPanel = typeof children === 'function';
  return (
    <>
      <div
        className={cx('row', !scroll && 'wrap', className)}
        style={scroll ? { gap: 8, overflowX: 'auto', scrollbarWidth: 'none' } : { gap: 8 }}
        role="tablist"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
      >
        {items.map((item, i) => {
          const selected = item.value === current;
          return (
            <button
              key={item.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={tabId(item.value)}
              className={chipClass(selected, size)}
              aria-selected={selected}
              aria-controls={hasPanel ? panelId(item.value) : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => setCurrent(item.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {hasPanel ? (
        <div role="tabpanel" id={panelId(current)} aria-labelledby={tabId(current)} tabIndex={0} className={panelClassName}>
          {children(current)}
        </div>
      ) : null}
    </>
  );
}
