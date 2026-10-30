'use client';
// CMP-077 SeatFillPanel — 좌석맵 에디터 '② 좌석 채우기' 패널(d2 §2 CMP-077, d5 §6.5, 캔버스 보드 SCR-022).
// 구역을 고르고 좌석 수(또는 행 수 × 행마다 좌석 수)·행 모양·간격·통로·번호 규칙을 넣으면 그 도형 안에 좌석이 놓일 결과 줄을 보인다.
// 채우기 계산은 에디터 Worker가 한다(frontend §3.9). 이 부품은 입력과 결과 줄(role="status")만 그린다.
// - size "sm": 데스크톱 오른쪽 패널(작은 입력) · "md": 태블릿 시트(44px 누름 영역)
// - disabledReason: 구역 도형이 없을 때 [이 구역에 채우기]를 이유 있는 비활성으로(aria-disabled + 이유 글)
import { useId, useState, type ReactNode } from "react";

export interface SeatFillDefaults {
  mode: "count" | "grid";
  count: number;
  rows: number;
  perRow: number;
  rowShape: "straight" | "curve";
  /** 좌석 간격(옆, cm) */
  gap: number;
  /** 행 간격(앞뒤, cm) */
  rowGap: number;
  aisles: number;
  /** 통로 폭(cm) */
  aisleWidth: number;
  rowNaming: "number" | "alpha";
  firstNo: number;
  direction: "left" | "right";
}

export const SEAT_FILL_DEFAULTS: SeatFillDefaults = {
  mode: "count",
  count: 600,
  rows: 20,
  perRow: 30,
  rowShape: "curve",
  gap: 50,
  rowGap: 90,
  aisles: 2,
  aisleWidth: 120,
  rowNaming: "number",
  firstNo: 1,
  direction: "left",
};

export interface SeatFillPanelProps {
  /** 제목 h2의 id(패널 section의 aria-labelledby) */
  headingId: string;
  /** 'A1구역 · 곡선 띠 · 지금 420석' */
  subtitle: string;
  defaults?: Partial<SeatFillDefaults>;
  /** 채우기 미리보기 결과 줄 */
  result?: { text: string; tone: "warning" | "success" };
  size?: "sm" | "md";
  /** 있으면 입력 없이 [이 구역에 채우기]를 이유 있는 비활성으로 */
  disabledReason?: string;
  /** 제목 줄 오른쪽(시트 닫기 단추 등) */
  headerEnd?: ReactNode;
  /** [이 구역에 채우기]에 더할 속성(대화상자 여는 data 속성 등) */
  fillAttrs?: Record<string, string>;
}

export function SeatFillPanel({
  headingId,
  subtitle,
  defaults,
  result,
  size = "sm",
  disabledReason,
  headerEnd,
  fillAttrs,
}: SeatFillPanelProps) {
  const d = { ...SEAT_FILL_DEFAULTS, ...defaults };
  const [mode, setMode] = useState(d.mode);
  const uid = useId();
  const sm = size === "sm";
  const ig = sm ? "input-group input-group-sm" : "input-group";
  const igStyle = sm ? { padding: "0 8px", gap: 4 } : { gap: 6 };
  const unit = sm ? "t-xs muted" : "t-sm muted";
  const rowStyle = sm ? { fontSize: 14, alignItems: "center" } : { alignItems: "center", minHeight: 44 };
  const small = { fontSize: 12 };
  const id = (k: string) => `${uid}-${k}`;

  const head = sm ? (
    <div className="col" style={{ gap: 2 }}>
      <h2 className="t-md fw-b" id={headingId}>
        좌석 채우기
      </h2>
      <span className="t-xs muted">{subtitle}</span>
    </div>
  ) : (
    <div className="drawer-head" style={{ padding: "4px 0 10px 0", marginBottom: 0 }}>
      <div className="col grow" style={{ gap: 2 }}>
        <h2 className="t-lg" id={headingId}>
          좌석 채우기
        </h2>
        <span className="t-sm muted">{subtitle}</span>
      </div>
      {headerEnd}
    </div>
  );

  if (disabledReason) {
    return (
      <div className="col" style={{ gap: sm ? 12 : 14 }}>
        {head}
        <button
          className={sm ? "btn btn-primary btn-sm" : "btn btn-primary"}
          type="button"
          aria-disabled="true"
          aria-describedby={id("why")}
          style={sm ? undefined : { height: 48 }}
        >
          이 구역에 채우기
        </button>
        <p className={`row ${sm ? "t-xs" : "t-sm"} tx-warning fw-b`} id={id("why")} style={{ gap: 4, alignItems: "flex-start" }}>
          <i className={`ic ic-alert ${sm ? "ic-14" : "ic-16"}`} aria-hidden="true" />
          {disabledReason}
        </p>
      </div>
    );
  }

  const radio = (name: string, value: string, label: string, checked: boolean, onChange?: () => void) => (
    <label className="check-row" style={rowStyle}>
      <input className="rd" type="radio" name={`${uid}-${name}`} value={value} defaultChecked={onChange ? undefined : checked} checked={onChange ? checked : undefined} onChange={onChange} />
      {label}
    </label>
  );

  const num = (k: string, label: string, value: number, u: string) => (
    <div className="field" style={{ gap: 4 }}>
      <label className="label" htmlFor={id(k)} style={small}>
        {label}
      </label>
      <div className={ig} style={igStyle}>
        <input id={id(k)} type="text" inputMode="numeric" defaultValue={value} />
        <span className={unit}>{u}</span>
      </div>
    </div>
  );

  return (
    <div className="col" style={{ gap: sm ? 12 : 14 }}>
      {head}
      <div className="col" role="radiogroup" aria-labelledby={id("fm")} style={{ gap: sm ? 8 : 6 }}>
        <span className="label" id={id("fm")}>
          채우는 방식
        </span>
        {radio("fm", "count", "좌석 수로 채우기", mode === "count", () => setMode("count"))}
        <div className={`${ig}${mode !== "count" ? " is-disabled" : ""}`} style={{ marginLeft: 32, width: "auto" }}>
          <input type="text" inputMode="numeric" aria-label="채울 좌석 수" defaultValue={d.count} disabled={mode !== "count"} />
          <span className={unit}>석</span>
        </div>
        {radio("fm", "grid", "행 수 × 행마다 좌석 수", mode === "grid", () => setMode("grid"))}
        <div className="row" style={{ marginLeft: 32, gap: 6 }}>
          <div className={`${ig}${mode !== "grid" ? " is-disabled" : ""}`} style={igStyle}>
            <input type="text" inputMode="numeric" aria-label="행 수" defaultValue={d.rows} disabled={mode !== "grid"} />
            <span className={unit}>행</span>
          </div>
          <span className="muted" aria-hidden="true">
            ×
          </span>
          <div className={`${ig}${mode !== "grid" ? " is-disabled" : ""}`} style={igStyle}>
            <input type="text" inputMode="numeric" aria-label="행마다 좌석 수" defaultValue={d.perRow} disabled={mode !== "grid"} />
            <span className={unit}>석</span>
          </div>
        </div>
      </div>

      <div className="col" role="radiogroup" aria-labelledby={id("rs")} style={{ gap: sm ? 8 : 6 }}>
        <span className="label" id={id("rs")}>
          행 모양
        </span>
        <div className={sm ? "col" : "row wrap"} style={{ gap: sm ? 8 : "0 16px" }}>
          {radio("rs", "straight", "직선", d.rowShape === "straight")}
          {radio("rs", "curve", "무대를 향한 곡선", d.rowShape === "curve")}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: sm ? 8 : 10 }}>
        {num("gap", "좌석 간격(옆)", d.gap, "cm")}
        {num("row", "행 간격(앞뒤)", d.rowGap, "cm")}
        {num("aisle", "세로 통로", d.aisles, "개")}
        {num("aw", "통로 폭", d.aisleWidth, "cm")}
      </div>

      <fieldset className="col" style={{ gap: sm ? 8 : 6 }}>
        <legend className="label" style={{ marginBottom: sm ? 8 : 6 }}>
          번호
        </legend>
        <div className="col" role="radiogroup" aria-labelledby={id("rn")} style={{ gap: sm ? 6 : 2 }}>
          <span className="t-xs fw-b muted" id={id("rn")}>
            행 이름
          </span>
          <div className="row wrap" style={{ gap: sm ? "6px 14px" : "0 16px" }}>
            {radio("rn", "number", "1열·2열", d.rowNaming === "number")}
            {radio("rn", "alpha", "A·B·C", d.rowNaming === "alpha")}
          </div>
        </div>
        <div className="field" style={{ gap: 4 }}>
          <label className="label" htmlFor={id("first")} style={small}>
            첫 번호
          </label>
          <input
            className={sm ? "input input-sm" : "input"}
            id={id("first")}
            type="text"
            inputMode="numeric"
            defaultValue={d.firstNo}
            style={{ width: sm ? 88 : 96 }}
          />
        </div>
        <div className="col" role="radiogroup" aria-labelledby={id("rd")} style={{ gap: sm ? 6 : 2 }}>
          <span className="t-xs fw-b muted" id={id("rd")}>
            방향
          </span>
          <div className={sm ? "col" : "row wrap"} style={{ gap: sm ? 6 : "0 16px" }}>
            {radio("rd", "left", "무대를 보고 왼쪽부터", d.direction === "left")}
            {radio("rd", "right", "오른쪽부터", d.direction === "right")}
          </div>
        </div>
      </fieldset>

      <button className={sm ? "btn btn-outline btn-sm" : "btn btn-outline"} type="button" style={sm ? undefined : { height: 44 }}>
        <i className="ic ic-eye" aria-hidden="true" />
        채우기 미리보기
      </button>
      <div
        className={result ? `banner banner-${result.tone}` : "sr-only"}
        role="status"
        style={result && sm ? { padding: "10px 12px" } : undefined}
      >
        {result && <i className={result.tone === "warning" ? "ic ic-alert" : "ic ic-check-circle"} aria-hidden="true" />}
        {result && <div className="banner-body">{result.text}</div>}
      </div>
      <button className={sm ? "btn btn-primary btn-sm" : "btn btn-primary"} type="button" style={sm ? undefined : { height: 48 }} {...fillAttrs}>
        이 구역에 채우기
      </button>
    </div>
  );
}
