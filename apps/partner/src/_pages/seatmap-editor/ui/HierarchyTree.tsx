'use client';
// 좌석 계층 트리(role="tree", d5 §6.5 '계층 트리'). 위·아래 화살표로 줄을 옮기고 Home·End로 처음·끝으로 간다(초점은 한 줄만 받는 방식).
// 펼치기·접기와 고르기의 실제 동작은 에디터 저장소를 잇는 단계에서 붙인다.
import { useRef, type KeyboardEvent } from 'react';
import type { TreeNode } from '../model/tree';

const PAD: Record<TreeNode['level'], number> = { 1: 2, 2: 12, 3: 22, 4: 32, 5: 42 };

export function HierarchyTree({ nodes, idPrefix }: { nodes: readonly TreeNode[]; idPrefix: string }) {
  const ref = useRef<HTMLUListElement>(null);
  const focusIndex = Math.max(
    0,
    nodes.findIndex((n) => n.selected),
  );

  function onKey(e: KeyboardEvent<HTMLUListElement>) {
    const items = Array.from(ref.current?.querySelectorAll<HTMLLIElement>('[role="treeitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLLIElement);
    if (i < 0) return;
    let next = i;
    if (e.key === 'ArrowDown') next = Math.min(items.length - 1, i + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    items[i]!.tabIndex = -1;
    items[next]!.tabIndex = 0;
    items[next]!.focus();
  }

  return (
    <ul ref={ref} role="tree" aria-label="좌석 계층" className="col" style={{ gap: 1 }} onKeyDown={onKey}>
      {nodes.map((n, i) => (
        <li
          key={`${idPrefix}-${i}`}
          role="treeitem"
          aria-level={n.level}
          aria-setsize={n.setsize}
          aria-posinset={n.posinset}
          aria-expanded={n.expanded}
          aria-selected={!!n.selected}
          tabIndex={i === focusIndex ? 0 : -1}
          className="row wrap"
          style={{
            gap: 4,
            minHeight: 28,
            padding: `0 4px 0 ${PAD[n.level]}px`,
            borderRadius: 6,
            fontSize: 13,
            lineHeight: '18px',
            ...(n.selected ? { background: 'var(--primary-subtle)', color: 'var(--link)', fontWeight: 700 } : {}),
          }}
        >
          {n.expanded === undefined ? (
            <span style={{ width: 14, flex: 'none' }} aria-hidden="true" />
          ) : (
            <i className={`ic ${n.expanded ? 'ic-chevron-down' : 'ic-chevron-right'} ic-14${n.selected ? '' : ' muted'}`} aria-hidden="true" />
          )}
          <span className={n.bold && !n.selected ? 'fw-b' : undefined}>{n.label}</span>
          {n.wc === true ? (
            <>
              <i className={`ic ic-wheelchair ic-14${n.selected ? '' : ' muted'}`} aria-hidden="true" />
              <span className="sr-only">휠체어석</span>
            </>
          ) : null}
          {n.meta ? <span className={n.selected ? 't-xs num' : 't-xs muted num'}>{n.meta}</span> : null}
          {typeof n.wc === 'number' ? (
            <span className="row t-xs muted" style={{ gap: 2 }}>
              <i className="ic ic-wheelchair ic-14" aria-hidden="true" />
              <span className="sr-only">휠체어석 </span>
              {n.wc}
            </span>
          ) : null}
          {n.warn ? (
            <span
              className={`row t-xs tx-warning${n.selected ? '' : ' fw-b'}`}
              style={{ gap: 2, marginLeft: n.level === 5 ? 'auto' : undefined }}
            >
              <i className="ic ic-alert ic-14" aria-hidden="true" />
              {n.warn}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
