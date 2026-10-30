// SCR-059 시스템 안내 카드 한 장(d5 §5.33, d3 SCR-059 행, 캔버스 보드 SCR-059-m·t·d를 한 부품 반응형으로 합쳤다).
// 변형 여섯: 판매 일시 중단 · 404 · 500 · 429 · 오프라인 · 미지원. 문구는 일반 안내만(스택·쿼리·토큰을 보이지 않는다, ASVS 16.5.1).
// 휴대폰은 카드 꽉 찬 폭(아이콘 56·제목 t-lg), 태블릿(md)은 480·제목 t-xl, 데스크톱(lg)은 520. 500과 판매 일시 중단만 role="alert"(d3).
// 'use client'가 없어 서버·클라이언트 어디서나 쓴다. 다시 시도 버튼만 클라이언트 부품이다.
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Scr059State } from '@/shared/config/screens.discovery';
import { RetryButton } from './RetryButton';

/** 클러스터 밖(GitHub Pages)에 두는 공개 상태 페이지(ADR-0032, Upptime). 주소는 [가정] — 배포 단계에서 정한다 */
export const STATUS_PAGE_URL = 'https://status.peaket.example/';

/** 429·503의 Retry-After 예시(보드·d5 §9.2와 같은 18초) */
export const RETRY_AFTER_EXAMPLE_SEC = 18;

const CARD =
  'card state mx-auto w-full gap-3 px-5 py-7 md:w-[480px] md:max-w-full md:gap-3.5 md:px-8 md:py-10 lg:w-[520px] lg:px-10 lg:py-11';
const ICON = 'h-14 w-14 md:h-16 md:w-16';
const H1 = 't-lg md:text-[24px] md:leading-8 md:tracking-[-0.005em]';
const P = 't-sm muted md:text-base md:leading-[22px]';
const LINK = 'link-more min-h-11 lg:min-h-8';

export interface SystemNoticeCardProps {
  variant: Scr059State;
  /** 500 '다시 시도'(error.tsx의 reset). 없으면 페이지를 다시 불러온다 */
  onRetry?: () => void;
  /** 429 남은 초(Retry-After) */
  retryAfterSec?: number;
}

export function SystemNoticeCard({ variant, onRetry, retryAfterSec = RETRY_AFTER_EXAMPLE_SEC }: SystemNoticeCardProps) {
  switch (variant) {
    case '판매 일시 중단':
      return (
        <div className={CARD} role="alert">
          <span className={`state-icon is-warning ${ICON}`}>
            <i className="ic ic-pause" aria-hidden="true" />
          </span>
          <h1 className={H1}>지금은 예매를 잠시 멈췄습니다</h1>
          <p className={P}>마이 티켓의 입장 QR은 그대로 열립니다</p>
          <div className="col items-center" style={{ gap: 2 }}>
            <a
              className={LINK}
              href={STATUS_PAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="복구 소식 보기, 피켓 상태 안내 페이지, 새 창"
            >
              복구 소식 보기
              <i className="ic ic-external" aria-hidden="true" />
            </a>
            <p className="t-xs muted">피켓이 멈춰도 열리는 별도 안내 페이지에서 복구 진행 상황을 알려 드립니다(새 창)</p>
          </div>
        </div>
      );
    case '404':
      return (
        <div className={CARD}>
          <span className={`state-icon ${ICON}`}>
            <i className="ic ic-search" aria-hidden="true" />
          </span>
          <h1 className={H1}>주소를 찾을 수 없습니다</h1>
          <Link className={LINK} href="/">
            홈으로
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </div>
      );
    case '500':
      return (
        <div className={CARD} role="alert">
          <span className={`state-icon is-danger ${ICON}`}>
            <i className="ic ic-alert-circle" aria-hidden="true" />
          </span>
          <h1 className={H1}>일시적인 오류입니다</h1>
          <p className={P}>잠시 후 다시 시도해 주세요</p>
          <RetryButton onRetry={onRetry} />
        </div>
      );
    case '429':
      return (
        <div className={CARD}>
          <span className={`state-icon is-warning ${ICON}`}>
            <i className="ic ic-clock" aria-hidden="true" />
          </span>
          <h1 className={H1}>요청이 많아 잠시 기다려야 합니다</h1>
          <p className={P}>
            <span className="fw-b num" role="timer">
              {retryAfterSec}초
            </span>{' '}
            뒤 자동으로 다시 시도합니다
          </p>
        </div>
      );
    case '오프라인':
      return (
        <div className={CARD}>
          <span className={`state-icon ${ICON}`}>
            <i className="ic ic-wifi-off" aria-hidden="true" />
          </span>
          <h1 className={H1}>인터넷 연결이 없습니다</h1>
          <Link className={LINK} href="/my/tickets">
            마이 티켓 열기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </div>
      );
    case '미지원':
      return (
        <div className={CARD}>
          <span className={`state-icon ${ICON}`}>
            <i className="ic ic-globe" aria-hidden="true" />
          </span>
          <h1 className={H1}>이 브라우저에서는 예매할 수 없습니다</h1>
          <p className={P}>최신 브라우저로 열어 주세요</p>
        </div>
      );
  }
}

/** 셸 본문(main) — 카드를 가운데에 둔다(보드 main: justify-content center, 휴대폰 20/16 · 태블릿 48/24 · 데스크톱 56/32) */
export function SystemNoticeMain({ children }: { children: ReactNode }) {
  return (
    <main className="page-main justify-center px-4 py-5 md:items-center md:px-6 md:py-12 lg:px-8 lg:py-14" id="main" tabIndex={-1}>
      {children}
    </main>
  );
}
