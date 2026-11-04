'use client';
// ⑥ 배너 슬라이드(CMP-071 banner, d5 §5.1, 보드 SCR-001-m/t/d).
// - 5초 [가정] 자동 넘김. 마우스가 올라간 동안 잠시 멈추고 버튼 글자는 바꾸지 않는다.
// - 키보드 초점이 배너 안으로 들어오면 멈추고 [재생]으로 바꾸며, 사용자가 [재생]을 누를 때까지 다시 넘기지 않는다(APG 캐러셀, 낮음-108).
// - 움직임 줄이기 설정이면 처음부터 멈춘다. 멈췄을 때만 슬라이드 영역이 aria-live="polite"다.
// 배치: 휴대폰 = 폭 가득 + 아래 조작 줄, 태블릿 = 오른쪽 아래 알약 조작, 데스크톱 = 양옆 다음 장 미리보기 + 알약 + 양옆 화살표.
// 그림은 운영자가 올린 가로형 배너 파생본(<picture>, ADR-0199 결정 4)이고, 핵심 문구는 이미지 안 글자가 아니라 [홈 구성]의 제목·부제를
// HTML 글자로 이미지 위에 얹는다(d5 §5.1, WCAG 2.2 SC 1.4.5, ADR-0199 결정 5). 첫 장은 첫 화면의 큰 그림(LCP)이라 먼저 받는다.
import Link from 'next/link';
import { useEffect, useState, type FocusEvent } from 'react';
import { PicturePoster } from '@/shared/ui/PicturePoster';
import type { BannerSlide } from '../model/feed';

const BANNER_SIZES = '(min-width: 1280px) 1216px, 100vw';

const PILL = { background: 'var(--inverse)', color: 'var(--on-inverse)', borderRadius: 999 } as const;

export function BannerCarousel({ slides }: { slides: readonly BannerSlide[] }) {
  const n = slides.length;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
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
  /** 한 장이면 양옆 미리보기·조작 버튼·쪽수를 그리지 않는다(HOT-300 새 맥락 리뷰 낮음 16) */
  const multi = n > 1;

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
        {multi ? (
          <span className="hidden h-[400px] w-[min(1216px,calc(100%-64px))] flex-none overflow-hidden rounded-[20px] lg:block" aria-hidden="true">
            <PicturePoster src={prev.imageUrl} alt="" width={1240} height={400} sizes={BANNER_SIZES} style={{ width: '100%', height: '100%' }} />
          </span>
        ) : null}
        <div className="relative lg:w-[min(1216px,calc(100%-64px))] lg:flex-none">
          {/* 태블릿: 오른쪽 아래 알약(일시정지·이전·쪽수·다음) */}
          <div className={multi ? 'row absolute right-3 bottom-3 z-[2] hidden md:flex lg:hidden' : 'hidden'} style={{ ...PILL, gap: 0, padding: '2px 4px' }}>
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
          <div className={multi ? 'row absolute right-5 bottom-5 z-[2] hidden lg:flex' : 'hidden'} style={{ ...PILL, gap: 2, padding: '4px 4px 4px 14px' }}>
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
            className={multi ? 'icon-btn icon-btn-outline absolute left-5 top-[178px] z-[2] hidden lg:grid' : 'hidden'}
            type="button"
            aria-label="이전 슬라이드"
            aria-controls="bn-slides"
            style={{ borderRadius: '50%', boxShadow: 'var(--shadow-md)' }}
            onClick={() => go(-1)}
          >
            <i className="ic ic-chevron-left" aria-hidden="true" />
          </button>
          <button
            className={multi ? 'icon-btn icon-btn-outline absolute right-5 top-[178px] z-[2] hidden lg:grid' : 'hidden'}
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
              <Link href={slide.href} className="relative block rounded-(--r-lg) md:overflow-hidden md:rounded-(--r-xl) lg:rounded-[20px]" style={{ color: 'inherit' }}>
                <PicturePoster
                  src={slide.imageUrl}
                  alt={slide.alt}
                  width={1240}
                  height={400}
                  sizes={BANNER_SIZES}
                  priority={index === 0}
                  className="aspect-[1240/400] overflow-hidden rounded-(--r-lg) md:rounded-none lg:aspect-auto lg:h-[400px]"
                  style={{ width: '100%' }}
                />
                {slide.title ? (
                  // 휴대폰(배너 높이 약 106)은 그림 아래에, 태블릿·데스크톱은 그림 아래쪽에 얹는다(d5 §5.1 '이미지 위나 아래에').
                  // 그림 위 글자는 색 모드와 상관없이 흰색이다(다크 토큰 --on-inverse는 어두운 글자라 막 위에서 읽히지 않는다).
                  // 대체 텍스트가 같은 내용(일시·장소 포함)을 이미 말하므로 화면 낭독에서는 숨긴다(링크 이름이 두 번 읽히지 않게)
                  <span aria-hidden="true" className="col gap-0.5 pt-2 md:absolute md:inset-x-0 md:bottom-0 md:bg-(--scrim) md:px-8 md:py-6 md:text-white lg:px-14 lg:py-10">
                    <span className="t-md fw-b md:text-[28px] md:leading-[34px]">{slide.title}</span>
                    {slide.subtitle ? <span className="t-xs muted md:text-sm md:text-white">{slide.subtitle}</span> : null}
                  </span>
                ) : null}
              </Link>
            </div>
          </div>
        </div>
        {multi ? (
          <span className="hidden h-[400px] w-[min(1216px,calc(100%-64px))] flex-none overflow-hidden rounded-[20px] lg:block" aria-hidden="true">
            <PicturePoster src={next.imageUrl} alt="" width={1240} height={400} sizes={BANNER_SIZES} style={{ width: '100%', height: '100%' }} />
          </span>
        ) : null}
      </div>
      {/* 휴대폰: 아래 조작 줄 */}
      <div className={multi ? 'row between md:hidden' : 'hidden'}>
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
