'use client';
// CMP-071 Carousel banner 변형(홈 큰 배너). 보드 SCR-001-d 마크업을 그대로 낸다:
//   <section aria-roledescription="carousel" aria-label="배너 슬라이드"><div style="display:flex;justify-content:center;gap:16px;overflow:hidden">
//   [이전 장 엿보기(장식)] [가운데: 'n / N'·일시정지 알약(inverse) · 이전/다음 icon-btn-outline · 슬라이드 묶음] [다음 장 엿보기]</div></section>
// - 5초(interval)마다 넘긴다. [일시정지]는 슬라이드 안 첫 탭 순서이고 글자를 '일시정지'↔'재생'으로 바꾼다.
// - 마우스가 올라간 동안 잠시 멈춘다(hover-paused). 키보드 초점이 들어오면 멈추고 [재생]을 누를 때까지 그대로다(focus-paused).
// - 움직임 줄이기 설정이면 자동으로 넘기지 않는다(reduced). 자동 넘김 중에는 바뀐 장을 읽지 않고(aria-live="off"), 멈추면 polite.
// - 각 장은 role="group"·aria-roledescription="slide"·이름 'n / N'. rail(가로 카드 줄)은 이 부품에 없다(화면이 가로 스크롤 목록으로 짠다).
import { useEffect, useId, useState, type CSSProperties, type FocusEvent, type ReactNode } from 'react';
import { usePrefersReducedMotion } from '../../lib/hooks';
import { Icon } from '../../icons';

export interface CarouselProps {
  /** 캐러셀 이름(aria-label). 기본 '배너 슬라이드' */
  label?: string;
  slides: readonly ReactNode[];
  /** 자동 넘김 간격(ms). 기본 5000 */
  interval?: number;
  autoPlay?: boolean;
  defaultIndex?: number;
  /** 처음부터 멈춘 상태(상태 미리보기) */
  defaultPaused?: boolean;
  /** 양옆 엿보기 그림(장식, aria-hidden). 그 장의 번호를 받는다 */
  renderPeek?: (index: number) => ReactNode;
  /** 가운데 장 폭. 기본 보드 값 min(1216px, calc(100% - 64px)) */
  slideWidth?: string;
  className?: string;
  style?: CSSProperties;
}

export function Carousel({
  label = '배너 슬라이드',
  slides,
  interval = 5000,
  autoPlay = true,
  defaultIndex = 0,
  defaultPaused = false,
  renderPeek,
  slideWidth = 'min(1216px, calc(100% - 64px))',
  className,
  style,
}: CarouselProps) {
  const slidesId = `${useId()}-slides`;
  const count = slides.length;
  const [index, setIndex] = useState(Math.min(Math.max(defaultIndex, 0), Math.max(count - 1, 0)));
  const [paused, setPaused] = useState(defaultPaused || !autoPlay);
  const [hovered, setHovered] = useState(false);
  const reduced = usePrefersReducedMotion();
  const playing = !paused && !reduced && count > 1;

  useEffect(() => {
    if (!playing || hovered) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % count), interval);
    return () => clearTimeout(t);
  }, [playing, hovered, index, interval, count]);

  const go = (delta: number) => setIndex((i) => (i + delta + count) % count);
  const onFocusIn = (e: FocusEvent<HTMLElement>) => {
    // 키보드 초점이 들어오면 멈춘다(마우스 누르기로 생긴 초점은 그대로 둔다)
    if (e.target instanceof HTMLElement && e.target.matches(':focus-visible')) setPaused(true);
  };

  const prev = (index - 1 + count) % count;
  const next = (index + 1) % count;
  const arrow: CSSProperties = { position: 'absolute', top: '50%', transform: 'translateY(-50%)', zIndex: 2, borderRadius: '50%', boxShadow: 'var(--shadow-md)' };

  return (
    <section aria-roledescription="carousel" aria-label={label} className={className} style={style} onFocus={onFocusIn}>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 16, overflow: 'hidden' }}>
        {renderPeek && count > 1 ? (
          <div aria-hidden="true" style={{ flex: 'none', width: slideWidth }}>
            {renderPeek(prev)}
          </div>
        ) : null}
        <div style={{ flex: 'none', width: slideWidth, position: 'relative' }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
          {count > 1 ? (
            <>
              <div
                className="row"
                style={{
                  position: 'absolute',
                  right: 20,
                  bottom: 20,
                  zIndex: 2,
                  gap: 2,
                  padding: '4px 4px 4px 14px',
                  borderRadius: 999,
                  background: 'var(--inverse)',
                  color: 'var(--on-inverse)',
                }}
              >
                <span className="t-sm fw-b num" aria-hidden="true">
                  {index + 1} / {count}
                </span>
                <button
                  className="btn btn-sm"
                  type="button"
                  style={{ background: 'transparent', color: 'inherit', padding: '0 10px' }}
                  onClick={() => setPaused((p) => !p)}
                >
                  <Icon name={paused ? 'play' : 'pause'} />
                  <span className="sr-only">슬라이드 </span>
                  {paused ? '재생' : '일시정지'}
                </button>
              </div>
              <button className="icon-btn icon-btn-outline" type="button" aria-label="이전 슬라이드" aria-controls={slidesId} style={{ ...arrow, left: 20 }} onClick={() => go(-1)}>
                <Icon name="chevron-left" />
              </button>
              <button className="icon-btn icon-btn-outline" type="button" aria-label="다음 슬라이드" aria-controls={slidesId} style={{ ...arrow, right: 20 }} onClick={() => go(1)}>
                <Icon name="chevron-right" />
              </button>
            </>
          ) : null}
          <div id={slidesId} aria-live={playing && !hovered ? 'off' : 'polite'}>
            {slides.map((slide, i) => (
              <div key={i} role="group" aria-roledescription="slide" aria-label={`${i + 1} / ${count}`} hidden={i !== index}>
                {slide}
              </div>
            ))}
          </div>
        </div>
        {renderPeek && count > 1 ? (
          <div aria-hidden="true" style={{ flex: 'none', width: slideWidth }}>
            {renderPeek(next)}
          </div>
        ) : null}
      </div>
      {paused && count > 1 ? (
        <p className="sr-only" role="status">
          슬라이드 자동 넘김을 멈췄습니다
        </p>
      ) : null}
    </section>
  );
}
