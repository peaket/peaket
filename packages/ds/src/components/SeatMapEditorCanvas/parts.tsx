// CMP-051 캔버스 안의 SVG 조각과 CMP-077 handles(고른 도형의 손잡이). 값과 모양은 캔버스 보드 SCR-022 그대로다.
// 손잡이: 모서리 넷·변 가운데 넷(네모), 안쪽·바깥 반지름(마름모), 시작·끝 각도(동그라미), 회전(오른쪽 아래, ic-rotate 모양) · 정렬 안내선(점선) · 치수 표시.
import type { CSSProperties, ReactNode } from "react";
import type { ViewBox } from "./SeatMapEditorCanvas";

export type ZoneGeometry =
  | { kind: "rect"; x: number; y: number; w: number; h: number; rx?: number }
  | { kind: "path"; d: string };

export interface ZoneShapeProps {
  shape: ZoneGeometry;
  /** 채움 색(CSS 변수). 기본 var(--surface) */
  fill?: string;
  /** 선 색(CSS 변수). 없으면 선 없음 */
  stroke?: string;
  strokeWidth?: number;
}

export function ZoneShape({ shape, fill = "var(--surface)", stroke, strokeWidth = 1.5 }: ZoneShapeProps) {
  const style: CSSProperties = stroke ? { fill, stroke, strokeWidth } : { fill };
  if (shape.kind === "rect")
    return <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={shape.rx} style={style} />;
  return <path d={shape.d} style={style} />;
}

export interface CanvasTextProps {
  x: number;
  y: number;
  children: ReactNode;
  size?: number;
  bold?: boolean;
  anchor?: "start" | "middle" | "end";
  /** 글자색(CSS 변수). 기본 var(--text) */
  color?: string;
  spacing?: string;
}

export function CanvasText({ x, y, children, size = 16, bold = false, anchor = "middle", color = "var(--text)", spacing }: CanvasTextProps) {
  return (
    <text x={x} y={y} textAnchor={anchor} style={{ fill: color, fontSize: size, fontWeight: bold ? 700 : undefined, letterSpacing: spacing }}>
      {children}
    </text>
  );
}

export interface SelectionHandlesProps {
  /** 고른 도형의 경계 상자 [x, y, w, h] */
  bbox: readonly [number, number, number, number];
  /** 안쪽·바깥 반지름 손잡이(부채꼴·곡선 띠) */
  radiusHandles?: readonly (readonly [number, number])[];
  /** 시작·끝 각도 손잡이 */
  angleHandles?: readonly (readonly [number, number])[];
  /** 회전 손잡이를 오른쪽 아래에 둔다 */
  rotate?: boolean;
}

export function SelectionHandles({ bbox, radiusHandles = [], angleHandles = [], rotate = true }: SelectionHandlesProps) {
  const [x, y, w, h] = bbox;
  const pts: [number, number][] = [
    [x, y],
    [x + w / 2, y],
    [x + w, y],
    [x + w, y + h / 2],
    [x + w, y + h],
    [x + w / 2, y + h],
    [x, y + h],
    [x, y + h / 2],
  ];
  const sq = { fill: "var(--surface)", stroke: "var(--primary)", strokeWidth: 2 };
  const rx = x + w + 4;
  const ry = y + h + 4;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} style={{ fill: "none", stroke: "var(--primary)", strokeWidth: 1.5 }} />
      {pts.map(([px, py], i) => (
        <rect key={i} x={px - 4} y={py - 4} width={8} height={8} style={sq} />
      ))}
      {radiusHandles.map(([px, py], i) => (
        <rect
          key={`r${i}`}
          x={px - 4}
          y={py - 4}
          width={8}
          height={8}
          transform={`rotate(45 ${px} ${py})`}
          style={{ fill: "var(--primary)", stroke: "var(--surface)", strokeWidth: 1.5 }}
        />
      ))}
      {angleHandles.map(([px, py], i) => (
        <circle key={`a${i}`} cx={px} cy={py} r={5.5} style={{ fill: "var(--surface)", stroke: "var(--primary)", strokeWidth: 2.5 }} />
      ))}
      {rotate && (
        <>
          <line x1={rx} y1={ry} x2={rx + 8.6} y2={ry + 9} style={{ stroke: "var(--primary)", strokeWidth: 1.5 }} />
          <circle cx={rx + 15.6} cy={ry + 16} r={10} style={{ fill: "var(--surface)", stroke: "var(--primary)", strokeWidth: 2 }} />
          <path
            transform={`translate(${rx + 8.4} ${ry + 8.8}) scale(.6)`}
            d="M19.5 12.5a7.5 7.5 0 1 1-2.2-5.8M19.5 4v4.5H15"
            style={{ fill: "none", stroke: "var(--primary)", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" }}
          />
        </>
      )}
    </g>
  );
}

/** 정렬 안내선(빨간 점선) */
export function GuideLine({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} style={{ stroke: "var(--danger)", strokeWidth: 1.5, strokeDasharray: "6 5" }} />;
}

/** 치수 표시(예: "가로 21.9m · 세로 16.3m") */
export function DimensionTag({ x, y, width, text }: { x: number; y: number; width: number; text: string }) {
  return (
    <g>
      <rect x={x} y={y} width={width} height={24} rx={12} style={{ fill: "var(--inverse)" }} />
      <text x={x + width / 2} y={y + 17} textAnchor="middle" style={{ fill: "var(--on-inverse)", fontSize: 14, fontWeight: 700 }}>
        {text}
      </text>
    </g>
  );
}

/** 확대한 좌석 층에서 무대 쪽을 가리키는 화살표와 '무대 방향' */
export function StageDirection({ x, y1, y2 }: { x: number; y1: number; y2: number }) {
  return (
    <g>
      <line x1={x} y1={y1} x2={x} y2={y2} style={{ stroke: "var(--text-muted)", strokeWidth: 1.2 }} />
      <path
        d={`M${x - 4} ${y2 + 6}L${x} ${y2 - 1}L${x + 4} ${y2 + 6}`}
        style={{ fill: "none", stroke: "var(--text-muted)", strokeWidth: 1.2, strokeLinejoin: "round" }}
      />
      <text x={x} y={y1 + 12} textAnchor="middle" style={{ fill: "var(--text-muted)", fontSize: 8, fontWeight: 700 }}>
        무대 방향
      </text>
    </g>
  );
}

/** 끌어 고른 상자(점선) */
export function MarqueeBox({ x, y, w, h, tone = "primary" }: { x: number; y: number; w: number; h: number; tone?: "primary" | "warning" }) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={tone === "warning" ? 4 : 2}
      style={{
        fill: "none",
        stroke: tone === "warning" ? "var(--warning)" : "var(--primary)",
        strokeWidth: tone === "warning" ? 1.2 : 1,
        strokeDasharray: tone === "warning" ? undefined : "3 2",
      }}
    />
  );
}

/** 구역 도형 밖 좌석 표시(좌석 점 + 경고 테두리 고리) */
export function OutsideSeatMarker({ x, y, r = 5.5, ring = 10, ringWidth = 3 }: { x: number; y: number; r?: number; ring?: number; ringWidth?: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} style={{ fill: "var(--seat-available)" }} />
      <circle cx={x} cy={y} r={ring} style={{ fill: "none", stroke: "var(--warning)", strokeWidth: ringWidth }} />
    </g>
  );
}

export interface CanvasMiniMapProps {
  /** 전체 배치 viewBox */
  viewBox: ViewBox;
  width: number;
  height: number;
  /** 작은 지도에 그릴 도형과 채움 색 */
  shapes: readonly { shape: ZoneGeometry; fill: string }[];
  /** 지금 보는 영역 [x0, y0, x1, y1] */
  focus?: readonly [number, number, number, number];
  inset?: number;
}

/** 왼쪽 아래 전체 배치 작은 지도와 지금 보는 영역 테두리 */
export function CanvasMiniMap({ viewBox, width, height, shapes, focus, inset = 10 }: CanvasMiniMapProps) {
  const [vx, vy, vw, vh] = viewBox;
  let box: CSSProperties | undefined;
  if (focus) {
    const [x0, y0, x1, y1] = focus;
    box = {
      position: "absolute",
      left: +(((x0 - vx) / vw) * width).toFixed(1),
      top: +(((y0 - vy) / vh) * height).toFixed(1),
      width: +(((x1 - x0) / vw) * width).toFixed(1),
      height: +(((y1 - y0) / vh) * height).toFixed(1),
      border: "2px solid var(--primary)",
      borderRadius: 2,
    };
  }
  return (
    <div
      className="card"
      style={{ position: "absolute", left: inset, bottom: inset, width, height, overflow: "hidden", borderRadius: width < 100 ? "var(--r-sm)" : "var(--r-md)" }}
    >
      <svg width={width} height={height} viewBox={`${vx} ${vy} ${vw} ${vh}`} focusable="false">
        {shapes.map((s, i) => (
          <ZoneShape key={i} shape={s.shape} fill={s.fill} />
        ))}
      </svg>
      {box && <span style={box} />}
    </div>
  );
}
