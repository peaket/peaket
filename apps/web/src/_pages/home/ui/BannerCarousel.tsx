'use client';
// ⑥ 배너 슬라이드(CMP-071 banner, d5 §5.1, 보드 SCR-001-m/t/d).
// - 5초 [가정] 자동 넘김. 마우스가 올라간 동안 잠시 멈추고 버튼 글자는 바꾸지 않는다.
// - 키보드 초점이 배너 안으로 들어오면 멈추고 [재생]으로 바꾸며, 사용자가 [재생]을 누를 때까지 다시 넘기지 않는다(APG 캐러셀, 낮음-108).
// - 움직임 줄이기 설정이면 처음부터 멈춘다. 멈췄을 때만 슬라이드 영역이 aria-live="polite"다.
// 배치: 휴대폰 = 폭 가득 + 아래 조작 줄, 태블릿 = 오른쪽 아래 알약 조작, 데스크톱 = 양옆 다음 장 미리보기 + 알약 + 양옆 화살표.
import Link from 'next/link';
import { useEffect, useState, type FocusEvent } from 'react';
import { ProductionPoster } from '@/entities/production';
import type { BannerSlide } from '../model/feed';

const PILL = { background: 'var(--inverse)', color: 'var(--on-inverse)', borderRadius: 999 } as const;

export function BannerCarousel({ slides, initialPaused = false }: { slides: readonly BannerSlide[]; initialPaused?: boolean }) {
  const n = slides.length;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(initialPaused);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) setPaused(true);
  }, []);
  useEffect(() => {
    if (paused || hover || n < 2) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % n), 5000);
    return () => clearInterval(t);
  }, [paused, hover, n]);

  const go = (d: number) => setIndex((i) => (i + d + n) % n);
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    // 키보드 초점(:focus-visible)일 때만 멈춘다. 마우스로 [일시정지]를 누를 때 먼저 멈춰 버리지 않게 한다.
    if ((e.target as HTMLElement).matches(':focus-visible')) setPaused(true);
  };
  const slide = slides[index];
  if (!slide) return null;
  const prev = slides[(index - 1 + n) % n]!;
  const next = slides[(index + 1) % n]!;
  const count = `${index + 1} / ${n}`;
  const toggleIcon = <i className={`ic ${paused ? 'ic-play' : 'ic-pause'}`} aria-hidden="true" />;
  const toggleText = paused ? '재생' : '일시정지';

  return (
    <section
      aria-roledescription="carousel"
      aria-label="배너 슬라이드"
      className="col gap-2 px-4 md:px-6 lg:px-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={onFocus}
    >
      <div className="lg:flex lg:justify-center lg:gap-4 lg:overflow-hidden">
        <span className={`poster poster-${prev.art} hidden aspect-auto h-[400px] w-[min(1216px,calc(100%-64px))] rounded-[20px] lg:flex`} aria-hidden="true" />
        <div className="relative lg:w-[min(1216px,calc(100%-64px))] lg:flex-none">
          {/* 태블릿: 오른쪽 아래 알약(일시정지·이전·쪽수·다음) */}
          <div className="row absolute right-3 bottom-3 z-[2] hidden md:flex lg:hidden" style={{ ...PILL, gap: 0, padding: '2px 4px' }}>
            <button className="icon-btn icon-btn-sm" type="button" aria-label={`슬라이드 ${toggleText}`} style={{ color: 'inherit' }} onClick={() => setPaused((v) => !v)}>
              {toggleIcon}
            </button>
            <button className="icon-btn icon-btn-sm" type="button" aria-label="이전 슬라이드" aria-controls="bn-slides" style={{ color: 'inherit' }} onClick={() => go(-1)}>
              <i className="ic ic-chevron-left" aria-hidden="true" />
            </button>
            <span className="t-sm fw-b num" aria-hidden="true" style={{ padding: '0 2px' }}>
              {count}
            </span>
            <button className="icon-btn icon-btn-sm" type="button" aria-label="다음 슬라이드" aria-controls="bn-slides" style={{ color: 'inherit' }} onClick={() => go(1)}>
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </button>
          </div>
          {/* 데스크톱: 알약(쪽수·일시정지)과 양옆 화살표 */}
          <div className="row absolute right-5 bottom-5 z-[2] hidden lg:flex" style={{ ...PILL, gap: 2, padding: '4px 4px 4px 14px' }}>
            <span className="t-sm fw-b num" aria-hidden="true">
              {count}
            </span>
            <button className="btn btn-sm" type="button" style={{ background: 'transparent', color: 'inherit', padding: '0 10px' }} onClick={() => setPaused((v) => !v)}>
              {toggleIcon}
              <span className="sr-only">슬라이드 </span>
              {toggleText}
            </button>
          </div>
          <button
            className="icon-btn icon-btn-outline absolute left-5 top-[178px] z-[2] hidden lg:grid"
            type="button"
            aria-label="이전 슬라이드"
            aria-controls="bn-slides"
            style={{ borderRadius: '50%', boxShadow: 'var(--shadow-md)' }}
            onClick={() => go(-1)}
          >
            <i className="ic ic-chevron-left" aria-hidden="true" />
          </button>
          <button
            className="icon-btn icon-btn-outline absolute right-5 top-[178px] z-[2] hidden lg:grid"
            type="button"
            aria-label="다음 슬라이드"
            aria-controls="bn-slides"
            style={{ borderRadius: '50%', boxShadow: 'var(--shadow-md)' }}
            onClick={() => go(1)}
          >
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </button>
          <div id="bn-slides" aria-live={paused ? 'polite' : 'off'}>
            <div role="group" aria-roledescription="slide" aria-label={count}>
              <Link href={slide.href} className="block rounded-(--r-lg) md:rounded-(--r-xl) lg:rounded-[20px]" style={{ color: 'inherit' }}>
                <ProductionPoster
                  art={slide.art}
                  label={slide.alt}
                  kicker={slide.kicker}
                  title={slide.title}
                  sub={slide.sub}
                  className="aspect-[1240/400] rounded-(--r-lg) px-4 py-3 md:aspect-auto md:h-[232px] md:rounded-(--r-xl) md:px-8 md:py-7 lg:h-[400px] lg:rounded-[20px] lg:px-14 lg:py-11"
                  titleClassName="text-[18px] leading-[20px] md:text-[34px] md:leading-[36px]"
                  kickerClassName="md:text-xs md:leading-4"
                  subClassName="md:text-[13px] md:leading-[17px]"
                />
              </Link>
            </div>
          </div>
        </div>
        <span className={`poster poster-${next.art} hidden aspect-auto h-[400px] w-[min(1216px,calc(100%-64px))] rounded-[20px] lg:flex`} aria-hidden="true" />
      </div>
      {/* 휴대폰: 아래 조작 줄 */}
      <div className="row between md:hidden">
        <button className="btn btn-ghost btn-sm" type="button" style={{ padding: '0 8px' }} onClick={() => setPaused((v) => !v)}>
          {toggleIcon}
          <span className="sr-only">슬라이드 </span>
          {toggleText}
        </button>
        <div className="row" style={{ gap: 0 }}>
          <button className="icon-btn icon-btn-sm" type="button" aria-label="이전 슬라이드" aria-controls="bn-slides" onClick={() => go(-1)}>
            <i className="ic ic-chevron-left" aria-hidden="true" />
          </button>
          <span className="t-sm fw-b num" aria-hidden="true" style={{ padding: '0 2px' }}>
            {count}
          </span>
          <button className="icon-btn icon-btn-sm" type="button" aria-label="다음 슬라이드" aria-controls="bn-slides" onClick={() => go(1)}>
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </button>
        </div>
      </div>
      <p className="sr-only" role="status">
        {paused ? '슬라이드 자동 넘김을 멈췄습니다' : ''}
      </p>
    </section>
  );
}
