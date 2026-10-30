'use client';
// SCR-059 시스템 안내 파트너 변형의 본문(d5 §5.33 파트너 쪽, 보드 SCR-059-partner·-t·-m). 셸 안 가운데 카드 하나에 변형 다섯.
// 데스크톱은 위에서 조금 내린 카드(최대 560), 태블릿은 화면 가운데 480 카드, 휴대폰은 가운데 꽉 찬 카드.
// 문구는 일반 안내만 쓴다(스택·쿼리·토큰을 보이지 않는다, ASVS 16.5.1).
// 퍼블리싱 동안은 ?state=로 다른 변형을 고른다(없는 주소 /system-notice-preview에서). 데이터를 잇는 단계에서 걷어 낸다(ADR-0170).
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { routes } from '@/shared/config/routes';
import { NOTICE_STATES, type NoticeState } from '@/shared/config/states/scr059';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';

export interface NoticeBodyProps {
  kind: 'not-found' | 'error';
  /** 오류 경계의 reset. 없으면 [다시 시도]가 지금 주소를 다시 연다 */
  onRetry?: () => void;
}

/** 화면 목록(/preview)에 올린 일부러 없는 주소 */
const PREVIEW_PATH = '/system-notice-preview';

export function NoticeBody({ kind, onRetry }: NoticeBodyProps) {
  const sp = useSearchParams();
  const fallback: NoticeState = kind === 'error' ? '500' : '404';
  // 실제 오류 경계에서는 늘 500이다. 상태 고르기는 없는 주소(404)에서만 받는다
  const state = kind === 'error' ? fallback : resolvePreviewState(sp ?? undefined, NOTICE_STATES, fallback);
  const theme = resolvePreviewTheme(sp ?? undefined);
  return (
    <>
      <NoticeView state={state} onRetry={onRetry} />
      {kind === 'not-found' ? (
        <PreviewStateSwitcher path={PREVIEW_PATH} states={NOTICE_STATES} current={state} keep={{ theme: theme === 'dark' ? 'dark' : undefined }} />
      ) : null}
    </>
  );
}

/** 상태 하나의 카드(Suspense 대체 화면으로도 쓴다) */
export function NoticeView({ state, onRetry }: { state: NoticeState; onRetry?: () => void }) {
  return (
    <div className="flex min-h-[calc(100dvh-180px)] flex-col items-center justify-center lg:min-h-0 lg:justify-start lg:pt-10">
      <Card state={state} onRetry={onRetry} />
    </div>
  );
}

function Card({ state, onRetry }: { state: NoticeState; onRetry?: () => void }) {
  switch (state) {
    case '500':
      return (
        <Frame icon="ic-alert-circle" tone="is-danger" title="일시적인 오류입니다" role="alert">
          <Body>잠시 후 다시 시도해 주세요</Body>
          <button
            className="btn btn-secondary mt-1 max-lg:min-h-[52px] max-lg:rounded-[var(--r-lg)] max-lg:px-5 max-lg:text-[16px] max-lg:leading-[22px] lg:mt-0"
            type="button"
            onClick={() => (onRetry ? onRetry() : window.location.reload())}
          >
            <i className="ic ic-refresh" aria-hidden="true" />
            다시 시도
          </button>
        </Frame>
      );
    case '429':
      return (
        <Frame icon="ic-clock" tone="is-warning" title="요청이 많아 잠시 기다려야 합니다">
          {/* 남은 시간은 응답의 Retry-After에서 온다(그림 예 18초) */}
          <Body live>18초 뒤 자동으로 다시 시도합니다</Body>
        </Frame>
      );
    case '미지원 브라우저':
      return (
        <Frame icon="ic-globe" title="지원하지 않는 브라우저입니다">
          {/* 판정은 필수 기능 검사 실패나 iOS·iPadOS 16.4 미만(NFR-019). 데스크톱과 휴대폰·태블릿의 안내가 다르다 */}
          <Body className="lg:hidden">iPhone·iPad는 Safari(iOS·iPadOS 16.4 이상), Android는 Chrome·삼성 인터넷에서 열어 주세요</Body>
          <Body className="max-lg:hidden">Chrome·Edge·Whale이나 Mac의 Safari에서 열어 주세요</Body>
        </Frame>
      );
    case '미지원(인앱 브라우저)':
      return (
        <Frame icon="ic-external" title="지원하지 않는 브라우저입니다">
          <Body>이 앱 안의 브라우저에서는 콘솔을 열 수 없습니다</Body>
          <InAppActions />
        </Frame>
      );
    default:
      return (
        <Frame icon="ic-search" title="주소를 찾을 수 없습니다">
          <Link className="link-more min-h-11" href={routes.home()}>
            홈으로
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </Frame>
      );
  }
}

function Frame({
  icon,
  tone,
  title,
  role,
  children,
}: {
  icon: string;
  tone?: 'is-danger' | 'is-warning';
  title: string;
  role?: 'alert';
  children: ReactNode;
}) {
  return (
    <div
      className="card state w-full gap-3 px-5 py-7 md:max-w-[480px] md:gap-3.5 md:px-8 md:py-10 lg:max-w-[560px] lg:gap-3 lg:py-12"
      role={role}
    >
      <span className={`state-icon${tone ? ` ${tone}` : ''} max-md:h-14 max-md:w-14`}>
        <i className={`ic ${icon}`} aria-hidden="true" />
      </span>
      <h1 className="t-xl max-md:text-[20px] max-md:leading-[27px]">{title}</h1>
      {children}
    </div>
  );
}

function Body({ children, live, className }: { children: ReactNode; live?: boolean; className?: string }) {
  return (
    <p className={`t-md muted max-md:text-[14px] max-md:leading-[19px]${className ? ` ${className}` : ''}`} aria-live={live ? 'polite' : undefined}>
      {children}
    </p>
  );
}

/** 인앱 브라우저: [다른 브라우저로 열기](SCR-058과 같은 버튼, ADR-0061) · [주소 복사] */
function InAppActions() {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="mt-1 flex w-full flex-col gap-2.5 md:w-auto md:flex-row md:flex-wrap md:justify-center md:gap-2">
        {/* 실제로 다른 브라우저를 여는 동작(Android intent·iPhone 안내)은 데이터를 잇는 단계에서 붙인다 */}
        <button className="btn btn-primary btn-lg" type="button" aria-describedby="ia-h">
          <i className="ic ic-external" aria-hidden="true" />
          다른 브라우저로 열기
        </button>
        <button
          className="btn btn-secondary btn-lg"
          type="button"
          onClick={() => void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true))}
        >
          <i className={copied ? 'ic ic-check' : 'ic ic-copy'} aria-hidden="true" />
          {copied ? '복사했습니다' : '주소 복사'}
        </button>
      </div>
      <p className="hint" id="ia-h">
        <span className="md:hidden">Android는 바로 열고, iPhone은 여는 방법을 안내합니다</span>
        <span className="max-md:hidden">Android는 바로 열고, iPad는 여는 방법을 안내합니다</span>
      </p>
      <span className="sr-only" role="status">
        {copied ? '주소를 복사했습니다' : ''}
      </span>
    </>
  );
}
