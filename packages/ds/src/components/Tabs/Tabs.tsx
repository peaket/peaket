'use client';
// CMP-030 Tabs. 캔버스 키트 12절 .tabs·.tab(탭)과 .seg·.seg-item(세그먼트)을 그대로 낸다.
// - Tabs: role=tablist·tab·tabpanel, ←→·Home·End로 옮기면 바로 고른다(roving tabindex: 고른 탭만 Tab 키로 들어간다).
//   패널은 children(value)로 그린다. 패널을 주지 않으면 탭만 그린다(같은 화면의 다른 곳이 값을 읽는다).
// - SegmentedControl: 보기 방식처럼 둘·셋 중 하나를 고르는 누름 버튼 묶음(role=group, aria-pressed). ←→로도 옮긴다.
// - 공연 상세 섹션 바로가기(anchor)는 탭이 아니라 링크 목록이라 TabNav(서버 컴포넌트)를 쓴다.
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { useTabs, type TabItem } from './useTabs';

export interface TabsItem extends TabItem {
  /** 탭 이름 뒤 숫자 배지(알림 신청 3) */
  badge?: ReactNode;
}

export interface TabsProps {
  items: readonly TabsItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** 탭 묶음 이름(aria-label). labelledBy가 없으면 준다 */
  label?: string;
  labelledBy?: string;
  size?: 'md' | 'sm';
  /** 좁은 화면에서 가로로 밀어 보기(.tabs-scroll) */
  scroll?: boolean;
  /** 고른 값의 패널 내용 */
  children?: (value: string) => ReactNode;
  className?: string;
  panelClassName?: string;
}

export function Tabs({
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
}: TabsProps) {
  const { current, refs, tabId, panelId, onKeyDown, setCurrent } = useTabs(items, value, defaultValue, onValueChange);
  const hasPanel = typeof children === 'function';
  return (
    <>
      <div
        className={cx('tabs', size === 'sm' && 'tabs-sm', scroll && 'tabs-scroll', className)}
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
              className="tab"
              aria-selected={selected}
              aria-controls={hasPanel ? panelId(item.value) : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => setCurrent(item.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {item.label}
              {item.badge !== undefined && item.badge !== null ? <span className="badge">{item.badge}</span> : null}
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

export interface SegmentedControlProps {
  items: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** 묶음 이름(aria-label, "보기 방식") */
  label: string;
  className?: string;
}

export function SegmentedControl({ items, value, defaultValue, onValueChange, label, className }: SegmentedControlProps) {
  const { current, refs, onKeyDown, setCurrent } = useTabs(items, value, defaultValue, onValueChange);
  return (
    <div className={cx('seg', className)} role="group" aria-label={label}>
      {items.map((item, i) => {
        const on = item.value === current;
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            className={cx('seg-item', on && 'is-active')}
            aria-pressed={on}
            tabIndex={on ? 0 : -1}
            disabled={item.disabled}
            onClick={() => setCurrent(item.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
