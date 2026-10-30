// CMP-051 SeatMapEditorCanvas — 파트너 좌석맵 에디터의 캔버스(d2 §2 CMP-051, d5 §6.5, frontend §3.9·§5.6).
// 퍼블리싱 단계에서는 캔버스 보드 SCR-022가 그린 SVG 미리보기를 그대로 옮긴다: 무대·구역 도형은 SVG(children), 좌석은 보드처럼
// viewBox 좌표를 %로 바꾼 위치에 키트 .seat 점으로 겹쳐 그린다. 끌기·손잡이·확대 같은 실제 편집(Konva 10.9)과 채우기 계산(에디터 Worker)은
// HOT-220에서 붙인다(add-screen-publishing design.md 결정 8). 캔버스는 화면 읽기 프로그램에서 숨기고(aria-hidden), 같은 편집은
// 계층 트리·속성 패널의 숫자 입력으로 한다(WCAG 2.5.7).
import type { CSSProperties, ReactNode } from "react";

export type ViewBox = readonly [x: number, y: number, width: number, height: number];

export interface EditorSeat {
  /** viewBox 좌표 */
  x: number;
  y: number;
  /** ghost: 채우기 미리보기의 흐린 좌석 · mine: 고른 좌석 · wc: 휠체어석 · unav: 판매 제외 */
  kind?: "normal" | "ghost" | "mine" | "wc" | "unav";
  /** 겹침·도형 밖·위치 확인 테두리(경고색) */
  warn?: boolean;
}

export interface SeatMapEditorCanvasProps {
  viewBox: ViewBox;
  /** 무대·구역 도형 등 SVG 내용 */
  children: ReactNode;
  /** 겹쳐 그릴 좌석 점 */
  seats?: readonly EditorSeat[];
  /** 좌석 점 지름(px) */
  seatSize?: number;
  /** 배치 층 격자 무늬(격자 맞춤 켬) */
  grid?: boolean;
  /** 왼쪽 아래 전체 배치 작은 지도(CanvasMiniMap) */
  minimap?: ReactNode;
  /** 오른쪽 위 확대·축소 단추 등 */
  controls?: ReactNode;
  /** 그림 영역 최대 폭 */
  maxWidth?: number;
  /** 바깥 상자 안쪽 여백 */
  padding?: CSSProperties["padding"];
  className?: string;
  style?: CSSProperties;
}

function seatStyle(s: EditorSeat, vb: ViewBox, size: number): CSSProperties {
  const [vx, vy, vw, vh] = vb;
  const half = size / 2;
  const st: CSSProperties = {
    position: "absolute",
    left: `${(((s.x - vx) / vw) * 100).toFixed(2)}%`,
    top: `${(((s.y - vy) / vh) * 100).toFixed(2)}%`,
    width: size,
    height: size,
    margin: `-${half}px 0 0 -${half}px`,
    borderRadius: "50%",
  };
  if (s.kind === "ghost") {
    st.background = "var(--primary-subtle)";
    st.boxShadow = "inset 0 0 0 1px var(--link)";
  }
  if (s.warn) {
    st.outline = "2px solid var(--warning)";
    st.outlineOffset = 1;
  }
  return st;
}

export function SeatMapEditorCanvas({
  viewBox,
  children,
  seats,
  seatSize = 6,
  grid = false,
  minimap,
  controls,
  maxWidth,
  padding = 8,
  className,
  style,
}: SeatMapEditorCanvasProps) {
  const [vx, vy, vw, vh] = viewBox;
  const gridBg: CSSProperties = grid
    ? {
        backgroundImage:
          "linear-gradient(var(--fill-weak-strong) 1px,transparent 1px),linear-gradient(90deg,var(--fill-weak-strong) 1px,transparent 1px)",
        backgroundSize: "24px 24px",
      }
    : {};
  const card = (
    <div
      className={["card-flat center", className].filter(Boolean).join(" ")}
      style={{ position: "relative", flex: 1, padding, overflow: "hidden", ...gridBg, ...style }}
      aria-hidden="true"
    >
      <div style={{ position: "relative", width: "100%", maxWidth, aspectRatio: `${vw}/${vh}` }}>
        <svg
          viewBox={`${vx} ${vy} ${vw} ${vh}`}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
          focusable="false"
        >
          {children}
        </svg>
        {seats && seats.length > 0 && (
          <div style={{ position: "absolute", inset: 0 }}>
            {seats.map((s, i) => (
              <span
                key={i}
                className={["seat", s.kind && s.kind !== "normal" && s.kind !== "ghost" ? s.kind : ""].filter(Boolean).join(" ")}
                style={seatStyle(s, viewBox, seatSize)}
              />
            ))}
          </div>
        )}
      </div>
      {minimap}
    </div>
  );
  if (!controls) return card;
  // 확대·축소 단추는 화면 읽기 프로그램에 보여야 하므로 숨긴 그림 상자 밖에 둔다
  return (
    <div style={{ position: "relative", flex: 1, display: "flex", minWidth: 0 }}>
      {card}
      {controls}
    </div>
  );
}
