// SCR-034 예외 통과 입력(현장 책임자만). 정본: docs/design/d5 §8.3 '예외 통과(책임자, 모달)', 보드 SCR-034 '카메라 고장(책임자)'.
// - 좌석 표시로 이 기기 목록에서 티켓을 찾고, 사유(CMP-010 Select)와 메모(100자, 개인정보 금지)를 적어 기록한다.
// - 모든 예외 통과는 사후 검토(CS 처리함)에 오른다. 관람객 이름·연락처는 보이지 않는다.
// - 기록 보내기는 데이터 연결 단계에서 붙인다(지금은 대화상자를 닫기만 한다).
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ScannerLayout } from "../app/layout";
import { overrideMatch, overrideReasons } from "../fixtures/scanner";

const MEMO_MAX = 100;

export function OverrideFields({ prefix, layout, inDialog = false }: { prefix: string; layout: ScannerLayout; inDialog?: boolean }) {
  const [memo, setMemo] = useState("");
  const t = layout === "t";
  const grid = t && !inDialog;
  const seat = (
    <div className="field">
      <label className="label" htmlFor={`${prefix}-seat`}>
        좌석 표시 검색
      </label>
      <div className="input-group">
        <i className="ic ic-search" aria-hidden="true" />
        <input id={`${prefix}-seat`} type="search" defaultValue={overrideMatch.query} autoComplete="off" aria-describedby={`${prefix}-seat-h`} />
      </div>
      <span className="hint" id={`${prefix}-seat-h`}>
        관객 월렛·예매 확인의 좌석 표시로 찾습니다
      </span>
    </div>
  );
  const found = (
    <fieldset className="col" style={{ gap: 6 }}>
      <legend className={grid ? "label" : "sr-only"} style={grid ? { marginBottom: 6 } : undefined}>
        이 기기 목록에서 찾은 티켓
      </legend>
      <label
        className="check-row"
        style={{ alignItems: "center", minHeight: grid ? 56 : 52, padding: "6px 12px", border: "2px solid var(--border-primary)", borderRadius: 8 }}
      >
        <input className="rd" type="radio" name={`${prefix}-t`} defaultChecked />
        <span className="col">
          <span className="fw-b">{overrideMatch.seat}</span>
          <span className="t-sm">{overrideMatch.meta}</span>
        </span>
      </label>
    </fieldset>
  );
  const reason = (
    <div className="field">
      <label className="label" htmlFor={`${prefix}-why`}>
        사유
      </label>
      <div className="input-group">
        <select id={`${prefix}-why`} defaultValue={overrideReasons[0]}>
          {overrideReasons.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <i className="ic ic-chevron-down" aria-hidden="true" />
      </div>
    </div>
  );
  const memoField = (
    <div className="field">
      <label className="label" htmlFor={`${prefix}-memo`}>
        메모 <span className="opt">(선택)</span>
      </label>
      <input
        className="input"
        id={`${prefix}-memo`}
        type="text"
        maxLength={MEMO_MAX}
        autoComplete="off"
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        aria-describedby={`${prefix}-memo-h`}
      />
      <span className="hint fw-b" id={`${prefix}-memo-h`} style={{ color: "var(--text)" }}>
        이름·연락처 같은 개인정보를 적지 마세요 · {memo.length}/{MEMO_MAX}자
      </span>
    </div>
  );
  if (grid) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "16px 20px", alignItems: "start" }}>
        {seat}
        {found}
        {reason}
        {memoField}
      </div>
    );
  }
  return (
    <>
      {seat}
      {found}
      {reason}
      {memoField}
    </>
  );
}

export function OverrideSubmit({ prefix, onDone }: { prefix: string; onDone?: () => void }) {
  return (
    <>
      <button className="btn btn-primary btn-xl btn-block" type="button" aria-describedby={`${prefix}-note`} onClick={onDone}>
        예외 통과 기록
      </button>
      <p className="t-sm" id={`${prefix}-note`}>
        모든 예외 통과는 사후 검토(CS 처리함)에 오릅니다.
      </p>
    </>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 예외 통과 대화상자. 초점을 안에 가두고 Esc로 닫으며, 닫으면 연 버튼으로 초점을 돌린다(d2 CMP-019) */
export function OverrideDialog({ layout, onClose }: { layout: ScannerLayout; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.querySelector<HTMLElement>("input, select")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);

  return (
    <div
      className="scrim"
      style={{ position: "fixed" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ovd-title"
        style={{ maxWidth: layout === "t" ? 560 : 420, maxHeight: "calc(100dvh - 32px)", overflowY: "auto", gap: 12 }}
      >
        <div className="row between">
          <h2 className="dialog-title" id="ovd-title">
            예외 통과
          </h2>
          <button className="icon-btn" type="button" aria-label="닫기" onClick={() => closeRef.current()}>
            <i className="ic ic-close" aria-hidden="true" />
          </button>
        </div>
        <OverrideFields prefix="ovd" layout={layout} inDialog />
        <OverrideSubmit prefix="ovd" onDone={() => closeRef.current()} />
      </div>
    </div>
  );
}

/** 카메라 고장(책임자): 뷰파인더 자리에 바로 보이는 예외 통과 입력 */
export function OverrideInline({ layout, children }: { layout: ScannerLayout; children?: ReactNode }) {
  const t = layout === "t";
  const alertLine = (
    <p className={t ? "row t-lg" : "row t-md fw-b"} role="alert" style={{ gap: 8, alignItems: "flex-start", color: "var(--danger)" }}>
      <i className={t ? "ic ic-alert ic-24" : "ic ic-alert"} aria-hidden="true" />
      카메라를 쓸 수 없습니다. 좌석 표시로 티켓을 찾아 예외 통과로 기록하세요.
    </p>
  );
  if (t) {
    return (
      <section className="col" style={{ padding: 24, gap: 16 }} aria-labelledby="h-ov">
        {alertLine}
        <div className="card col" style={{ padding: 24, gap: 16 }}>
          <h2 className="t-xl" id="h-ov">
            예외 통과
          </h2>
          <OverrideFields prefix="ov" layout={layout} />
          <OverrideSubmit prefix="ov" />
        </div>
        {children}
      </section>
    );
  }
  return (
    <section className="col" style={{ padding: "12px 16px 14px", gap: 8 }} aria-labelledby="h-ov">
      {alertLine}
      <h2 className="t-lg" id="h-ov">
        예외 통과
      </h2>
      <OverrideFields prefix="ov" layout={layout} />
      <OverrideSubmit prefix="ov" />
      {children}
    </section>
  );
}
