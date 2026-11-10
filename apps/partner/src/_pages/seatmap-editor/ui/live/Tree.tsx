'use client';
// 왼쪽 계층 트리(role="tree", d5 §6.5): 무대·구역 > 열. 보이는 줄만 그린다(줄 높이를 정해 스크롤 위치로 자른다, frontend §3.9).
// 구역 줄을 누르면 그 구역을 고르고, 열 줄을 누르면(③ 좌석 다듬기) 그 열 전체를 고른다. 이름은 글자 자식으로만 그린다.
import { useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { EditorStore } from '../../model/store';

const ROW_H = 32;
const VIEW_H = 480;

interface Line {
  key: string;
  level: 1 | 2;
  label: string;
  count?: number;
  kind: 'stage' | 'section' | 'row';
  sectionId?: string;
  stageIndex?: number;
  row?: string;
}

export function Tree({ store }: { store: EditorStore }) {
  const doc = useStore(store, (s) => s.doc);
  const sel = useStore(store, (s) => s.sel);
  const step = useStore(store, (s) => s.step);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [top, setTop] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    const out: Line[] = doc.stage.map((s, i) => ({ key: `stage-${i}`, level: 1, label: s.name ?? `무대 ${i + 1}`, kind: 'stage', stageIndex: i }));
    for (const id of doc.order) {
      const s = doc.sections[id]!;
      out.push({ key: `sec-${id}`, level: 1, label: s.name, count: s.seats.length, kind: 'section', sectionId: id });
      if (open.has(id)) {
        const rows = new Map<string, number>();
        for (const x of s.seats) rows.set(x.row, (rows.get(x.row) ?? 0) + 1);
        for (const [row, n] of rows) out.push({ key: `row-${id}-${row}`, level: 2, label: `${row}열`, count: n, kind: 'row', sectionId: id, row });
      }
    }
    return out;
  }, [doc, open]);
  const first = Math.max(0, Math.floor(top / ROW_H) - 4);
  const last = Math.min(lines.length, Math.ceil((top + VIEW_H) / ROW_H) + 4);
  const choose = (l: Line) => {
    const s = store.getState();
    if (l.kind === 'stage' && s.step === 1) s.select({ kind: 'stage', index: l.stageIndex! });
    else if (l.kind === 'section' && (s.step === 1 || s.step === 2)) s.select({ kind: 'section', id: l.sectionId! });
    else if (l.kind === 'row' && s.step === 3) s.selectSeats(s.doc.sections[l.sectionId!]!.seats.filter((x) => x.row === l.row).map((x) => x.seatId));
    else if (l.kind === 'section' && s.step === 3) s.selectSeats(s.doc.sections[l.sectionId!]!.seats.map((x) => x.seatId));
  };
  const isSel = (l: Line) => sel !== null && ((l.kind === 'section' && sel.kind === 'section' && sel.id === l.sectionId) || (l.kind === 'stage' && sel.kind === 'stage' && sel.index === l.stageIndex));
  return (
    <div ref={box} style={{ height: VIEW_H, overflowY: 'auto' }} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
      {lines.length === 0 ? <p className="t-sm muted" style={{ padding: 8 }}>무대와 구역을 그리면 여기에 보입니다.</p> : null}
      <ul role="tree" aria-label="좌석 계층" style={{ position: 'relative', height: lines.length * ROW_H, listStyle: 'none', margin: 0, padding: 0 }}>
        {lines.slice(first, last).map((l, k) => {
          const i = first + k;
          const expandable = l.kind === 'section' && (l.count ?? 0) > 0;
          return (
            <li
              key={l.key}
              role="treeitem"
              aria-level={l.level}
              aria-selected={isSel(l)}
              aria-expanded={expandable ? open.has(l.sectionId!) : undefined}
              aria-posinset={i + 1}
              aria-setsize={lines.length}
              tabIndex={i === 0 ? 0 : -1}
              className="row t-sm"
              style={{ position: 'absolute', top: i * ROW_H, left: 0, right: 0, height: ROW_H, gap: 4, paddingLeft: l.level === 2 ? 28 : 4, cursor: 'pointer', background: isSel(l) ? 'var(--primary-subtle)' : undefined, borderRadius: 6 }}
              onClick={() => choose(l)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  choose(l);
                } else if (expandable && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) setOpen((o) => toggle(o, l.sectionId!, e.key === 'ArrowRight'));
              }}
            >
              {expandable ? (
                <button className="icon-btn icon-btn-sm" type="button" tabIndex={-1} aria-label={open.has(l.sectionId!) ? `${l.label} 접기` : `${l.label} 펼치기`} onClick={(e) => { e.stopPropagation(); setOpen((o) => toggle(o, l.sectionId!)); }}>
                  <i className={`ic ${open.has(l.sectionId!) ? 'ic-chevron-down' : 'ic-chevron-right'}`} aria-hidden="true" />
                </button>
              ) : (
                <span style={{ width: 28 }} aria-hidden="true" />
              )}
              <span className="ellipsis grow">{l.label}</span>
              {l.count !== undefined ? <span className="num muted t-xs">{l.count.toLocaleString('ko-KR')}석</span> : null}
            </li>
          );
        })}
      </ul>
      {step === 3 ? <p className="t-xs muted" style={{ padding: 8 }}>열을 누르면 그 열 전체를 고릅니다.</p> : null}
    </div>
  );
}

function toggle(o: ReadonlySet<string>, id: string, force?: boolean): ReadonlySet<string> {
  const n = new Set(o);
  const on = force ?? !n.has(id);
  if (on) n.add(id);
  else n.delete(id);
  return n;
}
