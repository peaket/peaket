// 실제 값 화면의 '원천 연결 전' 표지(docs/frontend.md §5.7 '원천 연결 전 위젯', ADR-0360 결정 9).
// 대시보드 보드는 퍼블리싱 마크업을 그대로 옮긴 것이라 칸(.widget)마다 고정 자료를 그린다. 실제 값 화면에서는 보드가 그린 트리를 한 번 훑어
// 보드가 직접 그리는 칸마다 data-source="pending"과 머리의 '원천 연결 전' 배지를 단다. 경보 패널(ds AlertPanel)은 pending 속성으로 단다.
// 부품(원격 자리 RemoteWidget, 팀 위젯을 감싼 WidgetSlot 등)의 안쪽은 훑지 않는다: 원격 둘은 원천이 있고, 팀 위젯 일곱은 위젯 틀이 pending 속성으로 스스로 단다.
import { Children, Fragment, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { AlertPanel } from '@peaket/ds/ConsoleShell';

type Props = { className?: unknown; children?: ReactNode };

export function PendingBadge() {
  return (
    <span className="badge badge-outline">
      원천 연결 전
    </span>
  );
}

const hasClass = (el: ReactElement<Props>, name: string) => typeof el.props.className === 'string' && el.props.className.split(/\s+/).includes(name);

/** 칸 머리(div.widget-head 또는 접힌 칸의 summary)에 배지를 제목 바로 뒤에 넣는다 */
function withBadge(head: ReactElement<Props>): ReactElement {
  const kids = Children.toArray(head.props.children);
  const title = kids.findIndex((k) => isValidElement(k) && (k.type === 'h2' || k.type === 'span'));
  kids.splice(title >= 0 ? title + 1 : kids.length, 0, <PendingBadge key="source-pending" />);
  return cloneElement(head, undefined, ...kids);
}

/** 칸 하나: 머리를 찾아 배지를 넣고(없으면 맨 앞), 나머지 안쪽도 훑는다 */
function markCell(cell: ReactElement<Props>): ReactElement {
  let placed = false;
  const kids = Children.toArray(cell.props.children).map((k) => {
    if (!placed && isValidElement<Props>(k) && (hasClass(k, 'widget-head') || k.type === 'summary')) {
      placed = true;
      return withBadge(k);
    }
    return markPendingCells(k);
  });
  if (!placed) kids.unshift(<PendingBadge key="source-pending" />);
  return cloneElement(cell, { 'data-source': 'pending' } as Partial<Props>, ...kids);
}

/** 보드 트리에서 보드가 직접 그린 .widget 칸과 경보 패널에 표지를 단다 */
export function markPendingCells(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return Children.map(node, (k) => markPendingCells(k));
  if (!isValidElement<Props>(node)) return node;
  if (node.type === AlertPanel) return cloneElement(node as ReactElement<{ pending?: boolean }>, { pending: true });
  if (node.type !== Fragment && typeof node.type !== 'string') return node;
  if (typeof node.type === 'string' && hasClass(node, 'widget')) return markCell(node);
  if (node.props.children === undefined) return node;
  return cloneElement(node, undefined, ...Children.toArray(node.props.children).map((k) => markPendingCells(k)));
}
