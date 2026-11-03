// SCR-056 내 문의 내역(/help/inquiries, d5 §5.30, 캔버스 보드 SCR-056-m·t·d의 '내 문의 내역'·'문의 없음'을 한 페이지 반응형으로 합쳤다).
// 휴대폰·태블릿은 줄 목록, 데스크톱(lg)은 표. 머리 오른쪽 위 [문의하기]. 0건이면 빈 화면 카드.
// 로그인 화면이다(비로그인이면 SCR-004를 거쳐 돌아온다 — 퍼블리싱에는 세션이 없어 늘 로그인 모양으로 그린다).
import Link from 'next/link';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { INQUIRIES } from '@/entities/inquiry';
import { SCR056_LIST_STATES } from '@/shared/config/screens.discovery';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { InquiryList } from './InquiryList';

const H1 = 't-xl md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]';

export async function InquiriesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR056_LIST_STATES, '내 문의 내역');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const empty = state === '문의 없음';

  return (
    <AppShell variant="default" dark={dark}>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[1040px] gap-5 px-4 pt-5 pb-10 md:gap-6 md:px-6 md:pt-6 md:pb-12 lg:px-8 lg:pt-10 lg:pb-16">
          <Link className="link-more" href="/help" style={{ alignSelf: 'flex-start', minHeight: 32 }}>
            <i className="ic ic-chevron-left" aria-hidden="true" />
            고객센터
          </Link>
          <div className="row between gap-3 md:gap-4">
            <h1 className={H1}>내 문의 내역</h1>
            {empty ? null : (
              <Link className="btn btn-primary" href="/help/inquiries/new" style={{ minHeight: 44 }}>
                <i className="ic ic-plus hidden lg:inline-block" aria-hidden="true" />
                문의하기
              </Link>
            )}
          </div>

          {empty ? (
            <div className="card state gap-3.5 px-5 py-10 lg:gap-4 lg:px-8 lg:py-16">
              <span className="state-icon">
                <i className="ic ic-inbox" aria-hidden="true" />
              </span>
              <p className="t-lg">문의한 내역이 없습니다</p>
              <Link className="btn btn-primary btn-lg lg:min-w-[240px]" href="/help/inquiries/new">
                문의하기
              </Link>
            </div>
          ) : (
            <InquiryList items={INQUIRIES} />
          )}

          <p className="t-xs muted">문의 기록은 처리가 끝나고 3년 동안 볼 수 있습니다.</p>
        </div>
      </main>
      <PreviewSwitcher path="/help/inquiries" states={SCR056_LIST_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
