'use client';
// SCR-002의 작은 클라이언트 조각: 섹션 바로가기 탭(⑬), 상세정보 더보기(⑭), 상세 이미지(실패하면 대체 텍스트), 찜 버튼(⑫).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LikeToggle } from '@/features/like-production';
import { derivativeUrl } from '@/shared/lib/image-loader';
import { cx } from '@/shared/lib/cx';
import { derivativeSrcSet } from '@/shared/ui/PicturePoster';
import { useDetailPersonal } from './DetailPersonal';

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

/** 접힌 상세정보의 높이 상한 [가정](d5 §5.2 ⑭) */
const COLLAPSED_PX = 1200;

/**
 * ⑭ 상세정보: 처음에는 높이 1,200px [가정]까지만 보이고 아래는 흐리게 접는다. 펼쳐도 초점은 버튼에 그대로 둔다.
 * 내용이 1,200px 이하면 접지 않고 흐림·[상세정보 더보기]도 두지 않는다(내용 높이를 재서 정한다. 이미지가 늦게 와도 다시 잰다).
 */
export function DetailCollapse({ defaultOpen = false, children }: { defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const [overflows, setOverflows] = useState(false);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > COLLAPSED_PX);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const folded = overflows && !open;
  return (
    <>
      <div id="detail-body" className="relative" style={open ? undefined : { maxHeight: COLLAPSED_PX, overflow: 'hidden' }}>
        <div ref={inner} className="col" style={{ gap: 16 }}>
          {children}
        </div>
        {folded ? (
          <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-40" style={{ background: 'linear-gradient(to bottom, transparent, var(--surface))' }} />
        ) : null}
      </div>
      {overflows ? (
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
      ) : null}
    </>
  );
}

/**
 * ⑭ 상세 이미지 한 장(파생본 <picture>, ADR-0199 결정 4). 크기를 모르는 세로로 긴 그림이라 폭만 맞춘다.
 * 응답이 실패하면 그 자리에 대체 텍스트를 글로 보인다(d5 §5.2 '상세 이미지 실패').
 */
export function DetailImage({ url, alt, index, total }: { url: string; alt: string; index: number; total: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <p className="t-sm" style={{ padding: 16, border: '1px dashed var(--border-input)', borderRadius: 'var(--r-md)' }}>
        {alt}
      </p>
    );
  }
  const sizes = '(min-width: 1280px) 800px, 100vw';
  return (
    <picture style={{ display: 'block' }}>
      <source type="image/avif" srcSet={derivativeSrcSet(url, 'avif')} sizes={sizes} />
      <source type="image/webp" srcSet={derivativeSrcSet(url, 'webp')} sizes={sizes} />
      {/* eslint-disable-next-line @next/next/no-img-element -- 파생본을 CDN에서 바로 받는다(이미지 최적화 경로를 쓰지 않는다) */}
      <img
        src={derivativeUrl(url, 960, 'webp')}
        alt={`상세 이미지 ${index + 1}/${total}: ${alt}`}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        style={{ width: '100%', height: 'auto', borderRadius: 'var(--r-md)' }}
      />
    </picture>
  );
}

/** ⑫ 찜 버튼: 상태는 서버 값(`GET /v1/wishes?productionIds=`), 받기 전에는 누를 수 없다 */
export function WishButton({ variant, loginHref, className }: { variant: 'icon' | 'outline'; loginHref: string; className?: string }) {
  const { status, wishKnown, wished, setWish } = useDetailPersonal();
  return (
    <LikeToggle
      variant={variant}
      pressed={wished}
      onToggle={setWish}
      disabled={status !== 'guest' && !wishKnown}
      guest={status === 'guest'}
      loginHref={loginHref}
      {...(className ? { className } : {})}
    />
  );
}
