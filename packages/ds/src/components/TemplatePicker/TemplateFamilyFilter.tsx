'use client';
// CMP-078 gallery의 공연장 종류 거르기(칩, aria-pressed)와 카드 격자. 고른 종류의 템플릿만 보인다.
import { useState, type ReactNode } from "react";

export function TemplateFamilyFilter({
  families,
  cards,
}: {
  families: readonly string[];
  cards: readonly { family: string; node: ReactNode }[];
}) {
  const [picked, setPicked] = useState(families[0] ?? "전체");
  const shown = cards.filter((c) => picked === "전체" || c.family === picked);
  return (
    <>
      <div className="row wrap" role="group" aria-label="공연장 종류" style={{ gap: 6 }}>
        {families.map((f) => (
          <button
            key={f}
            className={f === picked ? "chip chip-sm is-selected" : "chip chip-sm"}
            type="button"
            aria-pressed={f === picked}
            onClick={() => setPicked(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <ul aria-label={`템플릿 ${shown.length}개`} className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
        {shown.map((c) => c.node)}
      </ul>
    </>
  );
}
