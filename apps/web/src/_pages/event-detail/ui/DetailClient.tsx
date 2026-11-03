'use client';
// SCR-002의 작은 클라이언트 조각: 섹션 바로가기 탭(⑬), 상세정보 더보기(⑭), 로비 열리기까지 남은 시간 버튼(⑦).
import { useEffect, useState, type ReactNode } from 'react';
import { cx } from '@/shared/lib/cx';

/**
 * ⑬ 섹션 바로가기(CMP-030 anchor). 스크롤을 따라 위에 붙고, 보이는 섹션을 aria-current로 표시한다.
 * 휴대폰·태블릿은 작은 탭(.tabs-sm)과 가로 스크롤, 데스크톱은 보통 탭.
 */
export function SectionTabs({ items, initial, stuck = false }: { items: readonly { id: string; label: string }[]; initial: string; stuck?: boolean }) {
  const [active, setActive] = useState(initial);
  useEffect(() => {
    const els = items.map((it) => document.getElementById(it.id)).filter((el): el is HTMLElement => el !== null);
    if (els.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: '-56px 0px -60% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [items]);
  return (
    <nav
      className="tabs tabs-sm tabs-scroll sticky top-0 z-[5] px-2 lg:px-0 lg:[&_.tab]:min-h-11 lg:[&_.tab]:px-3 lg:[&_.tab]:text-[15px] lg:[&_.tab]:leading-5"
      aria-label="섹션 바로가기"
      style={{ background: 'var(--surface)', boxShadow: stuck ? 'var(--shadow-md)' : undefined }}
    >
      {items.map((it) => (
        <a
          key={it.id}
          className={cx('tab', active === it.id && 'is-active')}
          href={`#${it.id}`}
          aria-current={active === it.id ? 'true' : undefined}
          onClick={() => setActive(it.id)}
        >
          {it.label}
        </a>
      ))}
    </nav>
  );
}

/** ⑭ 상세정보: 처음에는 높이 1,200px [가정]까지만 보이고 아래는 흐리게 접는다. 펼쳐도 초점은 버튼에 그대로 둔다 */
export function DetailCollapse({ defaultOpen = false, children }: { defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <div id="detail-body" className="relative" style={open ? undefined : { height: 1200, overflow: 'hidden' }}>
        <div className="col" style={{ gap: 16 }}>
          {children}
        </div>
        {open ? null : (
          <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-40" style={{ background: 'linear-gradient(to bottom, transparent, var(--surface))' }} />
        )}
      </div>
      <button
        className="btn btn-outline btn-lg btn-block lg:inline-flex lg:w-auto lg:min-w-[360px] lg:self-center"
        type="button"
        aria-expanded={open}
        aria-controls="detail-body"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '상세정보 접기' : '상세정보 더보기'}
        <i className={`ic ${open ? 'ic-chevron-up' : 'ic-chevron-down'}`} aria-hidden="true" />
      </button>
    </>
  );
}

/**
 * '로비 열림, 이 기기의 버튼은 아직'(d5 §5.2): 비활성 "곧 들어갈 수 있습니다 · 0:42"(aria-disabled, 남은 초는 낭독하지 않는다).
 * 0이 되면 [[ 로비 입장 ]]으로 바뀌고 aria-live="polite"로 "로비에 들어갈 수 있습니다"를 한 번 읽는다.
 */
export function LobbyCountdown({ seconds, href, describedBy, className }: { seconds: number; href: string; describedBy: string; className?: string }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <>
      {left > 0 ? (
        <button className={cx('btn btn-primary', className)} type="button" aria-disabled="true" aria-describedby={describedBy}>
          곧 들어갈 수 있습니다
          <span aria-hidden="true">
            {' '}
            · <span className="num">{clock}</span>
          </span>
        </button>
      ) : (
        <a className={cx('btn btn-primary', className)} href={href}>
          로비 입장
        </a>
      )}
      <p className="sr-only" aria-live="polite">
        {left <= 0 ? '로비에 들어갈 수 있습니다' : ''}
      </p>
    </>
  );
}
