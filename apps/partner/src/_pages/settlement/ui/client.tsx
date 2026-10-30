'use client';
// SCR-027의 작은 클라이언트 부품: 하위 탭(ds Tabs) · 내려받기 형식 메뉴(키트 .menu) · 그래프/표 전환 · 글자 수 세는 칸 · 태블릿 이상에서만 그리기.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Tabs } from '@peaket/ds/Tabs';

/* ---------- 하위 탭(정산서 · 판매 요약 · 예매자 명단 · 다운로드 이력) ---------- */

export type SubTab = 'settle' | 'summary' | 'roster' | 'log';

const SUB_TABS: readonly { value: SubTab; label: string }[] = [
  { value: 'settle', label: '정산서' },
  { value: 'summary', label: '판매 요약' },
  { value: 'roster', label: '예매자 명단' },
  { value: 'log', label: '다운로드 이력' },
];

export function SubTabs({ initial, panels }: { initial: SubTab; panels: Record<SubTab, ReactNode> }) {
  return (
    <Tabs items={SUB_TABS} defaultValue={initial} label="정산·명단 하위 메뉴" size="sm" scroll>
      {(v) => panels[v as SubTab]}
    </Tabs>
  );
}

/* ---------- 내려받기 형식 메뉴(CSV·XLSX·PDF, FR-027) ---------- */

const FORMATS = ['CSV', 'XLSX', 'PDF'] as const;

/** 휴대폰에서는 꽉 찬 버튼(보드 SCR-027-m btn-block), 태블릿부터 글자 폭 */
export function DownloadMenu({ label, menuLabel }: { label: string; menuLabel: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    function onDown(e: MouseEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function close() {
    setOpen(false);
    btn.current?.focus();
  }

  function onMenuKey(e: KeyboardEvent, i: number) {
    const n = FORMATS.length;
    const go = (j: number) => {
      e.preventDefault();
      items.current[(j + n) % n]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(n - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') setOpen(false);
  }

  return (
    <div ref={wrap} className="flex max-md:w-full md:inline-flex" style={{ position: 'relative' }}>
      <button
        ref={btn}
        className="btn btn-outline max-md:w-full"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <i className="ic ic-download" aria-hidden="true" />
        {label}
        <i className="ic ic-chevron-down" aria-hidden="true" />
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label={menuLabel} style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 20 }}>
          {FORMATS.map((f, i) => (
            <button
              key={f}
              ref={(el) => {
                items.current[i] = el;
              }}
              className="menu-item"
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={close}
              onKeyDown={(e) => onMenuKey(e, i)}
            >
              <i className="ic ic-download" aria-hidden="true" />
              {f}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- 그래프와 '표로 보기'(CMP-033, d5 §3.9) ---------- */

export function ChartToggle({ titleId, title, sub, chart, table }: { titleId: string; title: ReactNode; sub: ReactNode; chart: ReactNode; table: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="card pad col" style={{ gap: 12 }} aria-labelledby={titleId}>
      <div className="row between" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="col" style={{ gap: 2 }}>
          <h3 className="t-md fw-b" id={titleId}>
            {title}
          </h3>
          <span className="t-xs muted">{sub}</span>
        </div>
        <button className="btn btn-outline btn-sm" type="button" aria-pressed={asTable} style={{ flex: 'none' }} onClick={() => setAsTable((v) => !v)}>
          <i className={asTable ? 'ic ic-chart' : 'ic ic-list'} aria-hidden="true" />
          {asTable ? '그래프로 보기' : '표로 보기'}
        </button>
      </div>
      {asTable ? table : chart}
    </section>
  );
}

/* ---------- 글자 수를 세는 설명 칸(이의 제기, 2,000자) ---------- */

export function CountedTextarea({ id, hintId, max }: { id: string; hintId: string; max: number }) {
  const [n, setN] = useState(0);
  const countId = `${id}-count`;
  return (
    <>
      <textarea
        className="textarea min-h-[112px] lg:min-h-24"
        id={id}
        aria-describedby={`${hintId} ${countId}`}
        maxLength={max}
        onChange={(e) => setN([...e.target.value].length)}
      />
      <span className="hint" id={hintId}>
        어느 금액이 얼마여야 하는지와 근거(거래일, 주문 번호 등)를 적으면 빨리 확인합니다. 팬의 이름이나 연락처는 적지 않습니다.
      </span>
      <span className="counter" id={countId}>
        {n.toLocaleString('ko-KR')} / {max.toLocaleString('ko-KR')}자
      </span>
    </>
  );
}

/* ---------- 태블릿(md 768) 이상에서만 그리기 ---------- */
// 휴대폰은 예매자 명단 보기·내려받기가 범위 밖이라(d5 §3.9) 명단 내려받기 대화상자를 열지 않는다(보드 SCR-027-m은 안내 카드만).

export function MinMd({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const sync = () => setOk(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return ok ? <>{children}</> : null;
}
