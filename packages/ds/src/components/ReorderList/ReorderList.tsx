'use client';
// CMP-050 ReorderList(옛 DnDList). 가격 등급·홈 구성 배너처럼 짧은 목록의 순서를 줄마다 [위로]·[아래로] 버튼으로 바꾼다(d2 §2, docs/frontend.md §5.6).
// 끌어 놓기는 두지 않는다(기술 검토 낮음-098). 상태: default · moved(방금 옮긴 줄 강조) · first·last(맨 위 [위로]·맨 아래 [아래로] 비활성).
// 접근성: 버튼 이름에 줄 이름을 넣고("R석 위로 이동"), 옮긴 뒤 초점은 옮긴 줄의 같은 버튼에 남기며,
// "R석을 2번째로 옮겼습니다"를 role="status"로 알린다(WCAG 2.5.7).
// 줄 내용(content)은 서버 부품에서 만든 React 요소를 그대로 넘길 수 있다(함수 props 없음).
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export interface ReorderItem {
  id: string;
  /** 버튼 이름·알림에 쓰는 줄 이름(예: 'R석') */
  label: string;
  /** 줄 안에 그릴 내용(입력 칸 등) */
  content: ReactNode;
}

export interface ReorderListProps {
  items: readonly ReorderItem[];
  /** 목록 이름(aria-label) */
  label: string;
  /** 도움말 요소 id(aria-describedby) */
  describedBy?: string;
  /** icon: 아이콘 버튼(가격 등급) · text: '위로'·'아래로' 글자 버튼 */
  controls?: "icon" | "text";
  /** 순서가 바뀔 때 새 id 순서 */
  onChange?: (ids: string[]) => void;
  /** 모든 버튼을 막는다(잠긴 화면) */
  disabled?: boolean;
  itemStyle?: CSSProperties;
}

const ROW_STYLE: CSSProperties = {
  gap: 8,
  padding: "6px 8px",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-md)",
  background: "var(--surface)",
};

export function ReorderList({ items, label, describedBy, controls = "icon", onChange, disabled = false, itemStyle }: ReorderListProps) {
  const [order, setOrder] = useState<ReorderItem[]>(() => [...items]);
  const [moved, setMoved] = useState<{ id: string; dir: "up" | "down" } | null>(null);
  const [message, setMessage] = useState("");
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!moved) return;
    const btn = listRef.current?.querySelector<HTMLButtonElement>(`[data-reorder="${moved.id}-${moved.dir}"]`);
    // 맨 끝에 닿아 그 버튼이 막혔으면 반대쪽 버튼으로 초점을 옮긴다
    if (btn && !btn.disabled) btn.focus();
    else listRef.current?.querySelector<HTMLButtonElement>(`[data-reorder="${moved.id}-${moved.dir === "up" ? "down" : "up"}"]`)?.focus();
  }, [moved, order]);

  function move(index: number, dir: "up" | "down") {
    const to = dir === "up" ? index - 1 : index + 1;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item!);
    setOrder(next);
    setMoved({ id: item!.id, dir });
    setMessage(`${item!.label}을(를) ${to + 1}번째로 옮겼습니다`);
    onChange?.(next.map((i) => i.id));
  }

  return (
    <>
      <ol ref={listRef} className="col" style={{ gap: 8 }} aria-label={label} aria-describedby={describedBy}>
        {order.map((item, i) => {
          const isMoved = moved?.id === item.id;
          const up = (
            <button
              key="up"
              className={controls === "icon" ? "icon-btn" : "btn btn-ghost btn-sm"}
              type="button"
              aria-label={`${item.label} 위로 이동`}
              data-reorder={`${item.id}-up`}
              disabled={disabled || i === 0}
              onClick={() => move(i, "up")}
            >
              <i className="ic ic-chevron-up" aria-hidden="true" />
              {controls === "text" ? "위로" : null}
            </button>
          );
          const down = (
            <button
              key="down"
              className={controls === "icon" ? "icon-btn" : "btn btn-ghost btn-sm"}
              type="button"
              aria-label={`${item.label} 아래로 이동`}
              data-reorder={`${item.id}-down`}
              disabled={disabled || i === order.length - 1}
              onClick={() => move(i, "down")}
            >
              <i className="ic ic-chevron-down" aria-hidden="true" />
              {controls === "text" ? "아래로" : null}
            </button>
          );
          return (
            <li
              key={item.id}
              className="row"
              style={{
                ...ROW_STYLE,
                ...itemStyle,
                ...(isMoved ? { borderColor: "var(--border-primary)", boxShadow: "0 0 0 1px var(--border-primary)" } : null),
              }}
            >
              {item.content}
              {up}
              {down}
            </li>
          );
        })}
      </ol>
      <span className="sr-only" role="status">
        {message}
      </span>
    </>
  );
}
