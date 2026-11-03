// CMP-066 RoundPicker: 같은 공연의 회차를 칩 링크로 고른다(d5 §5.2 '회차마다 주소가 다르다', 보드 SCR-002의 회차 줄).
// 대기열·좌석 재고가 회차 단위라 회차마다 주소가 다르다(docs/data.md §2 event). 지금 회차는 aria-current="page"와 칩 선택 모양.
// 회차마다 상태 배지(오픈 예정·판매 중·매진·판매 종료)를 붙인다. 상태 없이 쓰는 것도 된다. 서버 컴포넌트에서도 쓴다(상태 없음).
import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import { renderLinkOrAnchor, type RenderLink } from "../../lib/link";

export type RoundPickerTone = "primary" | "success" | "danger" | "neutral";

export interface RoundPickerItem {
  id: string;
  /** '10/25(일) 18:00' */
  label: string;
  href: string;
  current?: boolean;
  /** 회차 상태 배지 */
  status?: { text: string; tone?: RoundPickerTone };
}

export interface RoundPickerProps {
  items: readonly RoundPickerItem[];
  /** 회차 제목 요소의 id(nav aria-labelledby). 없으면 label을 aria-label로 */
  labelledBy?: string;
  label?: string;
  renderLink?: RenderLink;
  className?: string;
}

const toneClass: Record<RoundPickerTone, string> = {
  primary: "badge badge-primary",
  success: "badge badge-success",
  danger: "badge badge-danger",
  neutral: "badge",
};

export function RoundPicker({ items, labelledBy, label = "회차", renderLink, className }: RoundPickerProps) {
  return (
    <nav aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : label} className={className}>
      <ul className="row wrap" style={{ gap: 8 }}>
        {items.map((it) => {
          const children: ReactNode = (
            <>
              {it.label}
              {it.status ? <span className={toneClass[it.status.tone ?? "neutral"]}>{it.status.text}</span> : null}
            </>
          );
          return (
            <li key={it.id}>
              {renderLinkOrAnchor(renderLink, {
                href: it.href,
                className: cx("chip", it.current && "is-selected"),
                "aria-current": it.current ? "page" : undefined,
                children,
              })}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
