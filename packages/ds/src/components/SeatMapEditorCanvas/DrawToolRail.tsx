'use client';
// CMP-051 '① 배치 그리기'의 세로 도구 막대(d5 §6.5): 선택 · 무대 · 사각형 · 다각형 · 부채꼴 · 곡선 띠. 아이콘 + 글자, 고른 도구는 aria-pressed.
// 화살표 위·아래로 도구 사이를 옮긴다(role="toolbar", aria-orientation="vertical").
import { useRef, useState, type KeyboardEvent } from "react";

export type DrawTool = "select" | "stage" | "rect" | "polygon" | "sector" | "arcband";

const TOOLS: readonly { key: DrawTool; icon: string; text: string; label: string }[] = [
  { key: "select", icon: "ic-cursor", text: "선택", label: "선택" },
  { key: "stage", icon: "ic-rect", text: "무대", label: "무대 그리기" },
  { key: "rect", icon: "ic-rect", text: "사각형", label: "사각형 구역 그리기" },
  { key: "polygon", icon: "ic-polygon", text: "다각형", label: "다각형 구역 그리기" },
  { key: "sector", icon: "ic-sector", text: "부채꼴", label: "부채꼴 구역 그리기" },
  { key: "arcband", icon: "ic-arcband", text: "곡선 띠", label: "곡선 띠 구역 그리기" },
];

export function DrawToolRail({ defaultTool = "select" }: { defaultTool?: DrawTool }) {
  const [tool, setTool] = useState<DrawTool>(defaultTool);
  const ref = useRef<HTMLDivElement>(null);
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    btns[(i + (e.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length]?.focus();
  }
  return (
    <div
      ref={ref}
      className="seg"
      role="toolbar"
      aria-label="그리기 도구"
      aria-orientation="vertical"
      style={{ flexDirection: "column", alignSelf: "start" }}
      onKeyDown={onKey}
    >
      {TOOLS.map((t) => (
        <button
          key={t.key}
          className={t.key === tool ? "seg-item is-active" : "seg-item"}
          type="button"
          aria-pressed={t.key === tool}
          aria-label={t.label}
          title={t.label}
          onClick={() => setTool(t.key)}
          style={{ flexDirection: "column", width: 56, height: 54, padding: "0 2px", gap: 3, fontSize: 11, lineHeight: "14px" }}
        >
          <i className={`ic ${t.icon}`} aria-hidden="true" />
          <span>{t.text}</span>
        </button>
      ))}
    </div>
  );
}
