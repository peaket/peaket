'use client';
// CMP-022 좌석 목록(구역 → 열 → 좌석, role="treegrid"). 지도(Canvas, aria-hidden)의 접근성 대안이다(d5 §5.10 ②).
// 보드 SCR-010 '목록으로 보기' 마크업 그대로: R1구역과 12열을 펼친 모습. 줄 하나만 Tab에 들고(roving tabindex),
// ↑↓ Home End로 옮겨 다니고, → ← 로 펼치고 접고, Space·Enter로 좌석을 고른다(고를 수 없는 좌석은 aria-disabled).
// 휴대폰은 12열 3~8번, 태블릿 위는 3~10번을 보인다(보드대로).
import { useRef, useState, type KeyboardEvent } from 'react';
import { SeatSwatch } from '@peaket/ds/SeatStatusBadge';
import { listSeats, openSeatCount, SEAT_ZONES } from '@/entities/seat';
import { cx } from '@/shared/lib/cx';
import { formatWon } from '@/entities/production';

const L1 = 'li min-h-[38px] gap-2 px-3 py-1.5 md:min-h-[42px] md:px-4';
const L2 = 'li min-h-[34px] gap-2 py-1 pr-3 pl-[34px] md:min-h-[38px] md:pr-4 md:pl-10';
const L3 = 'li min-h-8 gap-2.5 py-1 pr-3 pl-[58px] md:min-h-9 md:gap-3 md:pr-4 md:pl-[68px]';

function Gate({ gate }: { gate: string }) {
  return (
    <span role="gridcell" className="muted">
      <span className="t-xs md:hidden">입장 {gate}</span>
      <span className="t-sm hidden md:inline">입장 게이트 {gate}</span>
    </span>
  );
}

function RowCount({ n }: { n: number }) {
  return (
    <span role="gridcell" className="muted">
      <span className="t-xs md:hidden">예매 가능 {n}석</span>
      <span className="t-sm hidden md:inline">예매 가능 {n}석</span>
    </span>
  );
}

export function SeatTreeList({ hintId }: { hintId: string }) {
  const [zoneOpen, setZoneOpen] = useState(true);
  const [rowOpen, setRowOpen] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(listSeats(12, 3, 10).filter((s) => s.selected).map((s) => s.label)));
  const [active, setActive] = useState('z-R1');
  const gridRef = useRef<HTMLDivElement>(null);
  const seats = listSeats(12, 3, 10);

  const rows = () => Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[role="row"]') ?? []).filter((el) => el.getClientRects().length > 0);
  const move = (to: HTMLElement | undefined) => {
    if (!to) return;
    setActive(to.dataset.key ?? '');
    to.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = rows();
    const cur = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[role="row"]') : null;
    if (!cur) return;
    const i = list.indexOf(cur);
    const key = cur.dataset.key ?? '';
    if (e.key === 'ArrowDown') move(list[i + 1]);
    else if (e.key === 'ArrowUp') move(list[i - 1]);
    else if (e.key === 'Home') move(list[0]);
    else if (e.key === 'End') move(list[list.length - 1]);
    else if (e.key === 'ArrowRight') {
      if (key === 'z-R1') setZoneOpen(true);
      else if (key === 'r-12') setRowOpen(true);
    } else if (e.key === 'ArrowLeft') {
      if (key === 'z-R1') setZoneOpen(false);
      else if (key === 'r-12') setRowOpen(false);
    } else if ((e.key === ' ' || e.key === 'Enter') && key.startsWith('s-') && cur.getAttribute('aria-disabled') !== 'true') {
      const label = key.slice(2);
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return next;
      });
    } else return;
    e.preventDefault();
  };

  const rowProps = (key: string) => ({ 'data-key': key, tabIndex: active === key ? 0 : -1, onFocus: () => setActive(key) });
  const first = SEAT_ZONES.find((z) => z.id === 'R1');
  const others = ['R2', 'S1', 'S2', 'A1', 'A2'].map((id) => SEAT_ZONES.find((z) => z.id === id)!);

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div ref={gridRef} className="col" role="treegrid" aria-label="좌석 목록: 구역, 열, 좌석" aria-describedby={hintId} aria-multiselectable="true" onKeyDown={onKeyDown}>
        {first ? (
          <div className={L1} role="row" aria-level={1} aria-expanded={zoneOpen} aria-posinset={1} aria-setsize={6} {...rowProps('z-R1')}>
            <span className="row grow" role="gridcell" style={{ gap: 6 }}>
              <i className={cx('ic ic-16', zoneOpen ? 'ic-chevron-down' : 'ic-chevron-right')} aria-hidden="true" />
              <span className="fw-b">{first.name}</span>
              <span className="t-sm muted">
                {first.grade} · {formatWon(first.price)}
              </span>
            </span>
            <Gate gate={first.gate} />
          </div>
        ) : null}
        {zoneOpen ? (
          <>
            <div className={L2} role="row" aria-level={2} aria-expanded={false} aria-posinset={11} aria-setsize={20} {...rowProps('r-11')}>
              <span className="row grow" role="gridcell" style={{ gap: 6 }}>
                <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
                <span className="t-sm fw-b">11열</span>
              </span>
              <RowCount n={openSeatCount(11)} />
            </div>
            <div className={L2} role="row" aria-level={2} aria-expanded={rowOpen} aria-posinset={12} aria-setsize={20} {...rowProps('r-12')}>
              <span className="row grow" role="gridcell" style={{ gap: 6 }}>
                <i className={cx('ic ic-16', rowOpen ? 'ic-chevron-down' : 'ic-chevron-right')} aria-hidden="true" />
                <span className="t-sm fw-b">12열</span>
              </span>
              <RowCount n={openSeatCount(12)} />
            </div>
            {rowOpen
              ? seats.map((s, i) => {
                  const sel = picked.has(s.label);
                  const open = !s.disabled;
                  return (
                    <div
                      key={s.label}
                      className={cx(L3, i >= 6 && 'max-md:hidden')}
                      role="row"
                      aria-level={3}
                      aria-posinset={i + 3}
                      aria-setsize={30}
                      aria-selected={sel}
                      aria-disabled={s.disabled}
                      {...rowProps(`s-${s.label}`)}
                    >
                      <span className="row grow" role="gridcell" style={{ gap: 8 }}>
                        <SeatSwatch status={sel ? 'mine' : s.cls === 'mine' ? 'available' : swatchStatus(s.cls)} round className="md:h-[18px] md:w-[18px]" />
                        <span className="t-sm num">{s.label}</span>
                      </span>
                      <span className={cx('row', open ? 't-sm fw-b' : 't-sm muted')} role="gridcell" style={{ gap: 4 }}>
                        {sel ? <i className="ic ic-check ic-16" aria-hidden="true" /> : null}
                        {sel ? '내 선택' : s.cls === 'mine' ? '예매 가능' : s.status}
                      </span>
                    </div>
                  );
                })
              : null}
            <div className={L2} role="row" aria-level={2} aria-expanded={false} aria-posinset={13} aria-setsize={20} {...rowProps('r-13')}>
              <span className="row grow" role="gridcell" style={{ gap: 6 }}>
                <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
                <span className="t-sm fw-b">13열</span>
              </span>
              <RowCount n={openSeatCount(13)} />
            </div>
          </>
        ) : null}
        {others.map((z, i) => (
          <div
            key={z.id}
            className={L1}
            role="row"
            aria-level={1}
            aria-expanded={false}
            aria-posinset={i + 2}
            aria-setsize={6}
            style={i === others.length - 1 ? { borderBottom: 0 } : undefined}
            {...rowProps(`z-${z.id}`)}
          >
            <span className="row grow" role="gridcell" style={{ gap: 6 }}>
              <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
              <span className="fw-b">{z.name}</span>
              <span className="t-sm muted">
                {z.grade} · {z.level === '매진' ? '매진' : formatWon(z.price)}
              </span>
            </span>
            <Gate gate={z.gate} />
          </div>
        ))}
      </div>
    </div>
  );
}

function swatchStatus(cls: string) {
  if (cls === 'held') return 'held-by-others' as const;
  if (cls === 'sold') return 'sold' as const;
  if (cls === 'unav') return 'unavailable' as const;
  if (cls === 'wc') return 'wheelchair' as const;
  return 'available' as const;
}
