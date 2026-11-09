'use client';
// 접근성 좌석 목록(CMP-022, d5 §5.10 ②, docs/frontend.md §5.2, ADR-0227). 구역 → 열 → 좌석의 ARIA 트리이고 보이는 줄만 DOM에 둔다(TanStack Virtual).
// 목록 전체가 Tab 한 번으로 들어오는 한 자리다: 지금 줄만 tabindex 0이고, 지금 줄은 스크롤로 벗어나도 DOM에 남겨 초점을 잃지 않는다.
// 좌석 상태는 Worker 메시지로만 받는다(SeatsLive가 넘긴다). 화면에서 늦게 가져온다(첫 JS 예산, §5.8).
import { SeatSwatch } from '@peaket/ds/SeatStatusBadge';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { SeatPick } from '../model/booking-machine';
import { flatten, navigate, rowName, rowsOf, seatLabel, seatName, seatRowText, seatSelectable, sectionName, stateName, typeahead, type ListAction, type ListNode, type ListSection, type OpenSection } from '../model/seat-list';

/** 줄 높이(CSS px). 누를 수 있는 크기 44px을 넘긴다 */
const ROW_PX = 48;
/** 글자로 찾기에서 입력을 이어 붙이는 시간 [가정] */
const TYPEAHEAD_MS = 500;

export interface SeatListProps {
  sections: readonly ListSection[] | null;
  open: OpenSection | null;
  tierNames: ReadonlyMap<string, string>;
  prices: ReadonlyMap<string, number>;
  /** 구역을 연다(다른 구역은 닫힌다, null이면 닫기) */
  onOpenSection(section: number | null): void;
  onSeat(seat: SeatPick, seatIndex: number): void;
}

export function SeatList({ sections, open, tierNames, prices, onOpenSection, onSeat }: SeatListProps) {
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = useRef(new Map<string, HTMLDivElement>());
  // 목록을 열면 첫 줄로 초점을 옮긴다(목록이 버튼보다 앞에 있어 키보드 사용자가 되돌아가지 않게)
  const wantFocus = useRef(true);
  const typed = useRef({ text: '', at: 0 });

  // 구역이 바뀌면 그 구역의 열을 접은 채로 시작한다
  const openSectionId = open?.section;
  useEffect(() => setOpenRows(new Set()), [openSectionId]);

  const rows = useMemo(() => (open ? rowsOf(open) : []), [open?.section, open?.seats]); // eslint-disable-line react-hooks/exhaustive-deps -- 상태 배열이 바뀌어도 열은 그대로다
  const nodes = useMemo(() => flatten(sections ?? [], open, rows, openRows), [sections, open, rows, openRows]);
  const title = sections?.find((s) => s.section === open?.section)?.name ?? '';
  const wheelchair = useMemo(() => new Set(open?.seats.wheelchair ?? []), [open?.seats]);

  // 지금 줄이 없으면(접혔거나 구역이 바뀌었다) 그린 첫 줄이 tabindex를 갖는다. 초점을 옮기는 일은 아래 효과가 한다
  const found = nodes.findIndex((n) => n.id === activeId);
  const activeIndex = found >= 0 ? found : 0;
  const active = nodes[activeIndex]?.id ?? null;
  const activeRef = useRef(activeIndex);
  activeRef.current = activeIndex;

  const virtual = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: 8,
    getItemKey: (i) => nodes[i]!.id,
    // 지금 줄은 화면 밖이어도 그린다(스크롤로 없어지면 초점을 잃는다)
    rangeExtractor: (range) => {
      const base = defaultRangeExtractor(range);
      const i = activeRef.current;
      return i < range.count && !base.includes(i) ? [...base, i].sort((a, b) => a - b) : base;
    },
  });

  // 구역이 바뀌면 앞 구역의 줄이 사라져 지금 줄의 위치가 달라진다: 지금 줄이 화면 안에 있게 다시 맞춘다
  useEffect(() => {
    if (activeRef.current < virtual.options.count) virtual.scrollToIndex(activeRef.current, { align: 'auto' });
  }, [openSectionId]); // eslint-disable-line react-hooks/exhaustive-deps -- 구역이 바뀔 때만 한다

  // 지금 줄이 사라졌으면(늦게 온 응답으로 구역이 바뀐 때) 연 구역 줄로 옮긴다. 초점이 목록에 있었다면 함께 옮긴다
  const lost = activeId !== null && found < 0;
  useEffect(() => {
    if (!lost) return;
    const focused = document.activeElement;
    if (focused === document.body || scrollRef.current?.contains(focused)) wantFocus.current = true;
    setActiveId(nodes.find((n) => n.kind === 'section' && n.expanded)?.id ?? nodes[0]?.id ?? null);
  }, [lost, nodes]);

  useEffect(() => {
    if (!wantFocus.current || !active) return;
    const el = items.current.get(active);
    if (el) {
      el.focus({ preventScroll: true });
      wantFocus.current = false;
    }
  });

  const moveTo = (id: string) => {
    wantFocus.current = true;
    setActiveId(id);
    const i = nodes.findIndex((n) => n.id === id);
    if (i >= 0) virtual.scrollToIndex(i, { align: 'auto' });
  };

  const setRow = (row: string, on: boolean) =>
    setOpenRows((s) => {
      const next = new Set(s);
      if (on) next.add(row);
      else next.delete(row);
      return next;
    });

  const expand = (n: ListNode, on: boolean) => {
    if (n.kind === 'section') onOpenSection(on ? n.section : null);
    else if (n.kind === 'row') setRow(n.row, on);
  };

  const pickSeat = (offset: number) => {
    if (!open || !seatSelectable(stateName(open, offset))) return;
    onSeat({ seatId: open.seats.seatId[offset]!, label: seatLabel(title, open, offset), tier: open.tiers[open.seats.tier[offset]!] ?? null }, open.baseIndex + offset);
  };

  const run = (a: ListAction) => {
    const n = nodes.find((x) => x.id === a.id);
    if (!n) return;
    if (a.type === 'focus') return moveTo(a.id);
    if (a.type === 'open') return expand(n, true);
    if (a.type === 'close') return expand(n, false);
    if (n.kind === 'seat') pickSeat(n.offset);
    else expand(n, !n.expanded);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const action = navigate(nodes, active, e.key);
    if (action) {
      e.preventDefault();
      return run(action);
    }
    if (e.key.length !== 1) return;
    const now = e.timeStamp;
    typed.current = { text: now - typed.current.at > TYPEAHEAD_MS ? e.key : typed.current.text + e.key, at: now };
    const id = typeahead(nodes, open, active, typed.current.text);
    if (id) moveTo(id);
  };

  if (!sections) {
    return (
      <div className="grid h-full place-items-center" role="status">
        <span className="spinner muted" aria-hidden="true" />
        <span className="sr-only">좌석 목록을 불러오는 중</span>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-auto" role="tree" aria-label="좌석 목록" aria-multiselectable="true" onKeyDown={onKeyDown}>
      <div role="presentation" style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {virtual.getVirtualItems().map((v) => {
          const n = nodes[v.index]!;
          const seat = n.kind === 'seat' && open ? { state: stateName(open, n.offset), tierId: open.tiers[open.seats.tier[n.offset]!] ?? '' } : null;
          const name =
            n.kind === 'section'
              ? sectionName(n)
              : n.kind === 'row'
                ? rowName(n)
                : open && seat
                  ? seatName(title, open, n.offset, tierNames.get(seat.tierId), prices.get(seat.tierId), wheelchair.has(n.offset))
                  : '';
          return (
            <div
              key={n.id}
              ref={(el) => {
                if (el) items.current.set(n.id, el);
                else items.current.delete(n.id);
              }}
              role="treeitem"
              tabIndex={n.id === active ? 0 : -1}
              aria-label={name}
              aria-level={n.level}
              aria-setsize={n.setsize}
              aria-posinset={n.posinset}
              {...(n.kind === 'seat' ? { 'aria-selected': seat?.state === 'mine', ...(seat && !seatSelectable(seat.state) ? { 'aria-disabled': true } : {}) } : { 'aria-expanded': n.expanded })}
              className="row cursor-pointer items-center gap-2 border-b border-(--border) outline-offset-[-2px] hover:bg-(--surface-muted)"
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_PX, transform: `translateY(${v.start}px)`, paddingLeft: 12 + (n.level - 1) * 20, paddingRight: 12 }}
              onClick={() => {
                setActiveId(n.id);
                run({ type: 'activate', id: n.id });
              }}
            >
              {n.kind === 'seat' ? (
                seat ? <SeatSwatch status={wheelchair.has(n.offset) && seat.state === 'available' ? 'wheelchair' : seat.state} /> : null
              ) : (
                <i className={`ic ${n.expanded ? 'ic-chevron-down' : 'ic-chevron-right'}`} aria-hidden="true" />
              )}
              {n.kind === 'section' ? (
                <span className="t-sm fw-b">{sectionName(n)}</span>
              ) : n.kind === 'row' ? (
                <span className="t-sm">{rowName(n)}</span>
              ) : open && seat ? (
                <span className="t-sm num">{seatRowText(open, n.offset, tierNames.get(seat.tierId), prices.get(seat.tierId), wheelchair.has(n.offset))}</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
