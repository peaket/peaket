'use client';
// 현장 하위 탭 [스태프] [현장 운영](CMP-030 Tabs, 보드 .tabs.tabs-sm role=tablist). 두 패널은 서버에서 그려 넘긴다.
// 휴대폰은 두 탭이 폭을 반씩 나눈다(보드 SCR-037-m flex:1).
import type { ReactNode } from 'react';
import { Tabs } from '@peaket/ds/Tabs';

export type SubTab = 'staff' | 'ops';

const ITEMS = [
  { value: 'staff', label: '스태프' },
  { value: 'ops', label: '현장 운영' },
] as const;

export function SubTabs({ initial, staff, ops }: { initial: SubTab; staff: ReactNode; ops: ReactNode }) {
  return (
    <Tabs
      label="현장 하위 메뉴"
      size="sm"
      items={ITEMS}
      defaultValue={initial}
      className="max-md:[&>.tab]:flex-1 max-md:[&>.tab]:justify-center"
      panelClassName="col gap-4"
    >
      {(v) => (v === 'ops' ? ops : staff)}
    </Tabs>
  );
}
