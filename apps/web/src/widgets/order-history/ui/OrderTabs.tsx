'use client';
// 주문 종류 탭(CMP-030 Tabs: 전체·예매·굿즈). 패널 셋은 서버에서 그려 넘긴다. ←→·Home·End로 옮기면 바로 고른다.
import type { ReactNode } from 'react';
import { Tabs } from '@peaket/ds/Tabs';
import type { OrderTab } from '../model/rows';

const LABEL: Record<OrderTab, string> = { all: '전체', ticket: '예매', goods: '굿즈' };
const ORDER: readonly OrderTab[] = ['all', 'ticket', 'goods'];

export interface OrderTabsProps {
  defaultTab: OrderTab;
  /** 탭 이름 뒤 건수 배지(로딩·빈 화면에서는 없음) */
  counts?: Record<OrderTab, number>;
  panels: Record<OrderTab, ReactNode>;
}

export function OrderTabs({ defaultTab, counts, panels }: OrderTabsProps) {
  const items = ORDER.map((v) => ({ value: v, label: LABEL[v], badge: counts ? counts[v] : undefined }));
  return (
    <Tabs label="주문 종류" items={items} defaultValue={defaultTab}>
      {(v) => panels[v as OrderTab]}
    </Tabs>
  );
}
