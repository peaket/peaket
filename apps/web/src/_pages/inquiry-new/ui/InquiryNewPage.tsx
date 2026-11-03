// SCR-056 문의하기(/help/inquiries/new, d5 §5.30, 캔버스 보드 SCR-056-m·t·d의 '문의하기'~'하루 한도'를 한 페이지 반응형으로 합쳤다).
// 한 열(태블릿부터 폭 640 가운데). 태블릿(md)은 문의 유형·관련 주문이 두 칸, 데스크톱(lg)은 유형 칸 폭 360·버튼 오른쪽 정렬.
// 로그인 화면이다(비로그인이면 SCR-004를 거쳐 돌아온다 — 퍼블리싱에는 세션이 없어 늘 로그인 모양으로 그린다).
import Link from 'next/link';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ANSWER_DUE_TEXT } from '@/entities/inquiry';
import { SCR056_NEW_STATES } from '@/shared/config/screens.discovery';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { InquiryForm } from './InquiryForm';

const H1 = 't-xl md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]';

export async function InquiryNewPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR056_NEW_STATES, '문의하기');
  const dark = resolvePreviewTheme(sp) === 'dark';

  return (
    <AppShell variant="default" dark={dark}>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="mx-auto w-full max-w-[1040px] px-4 pt-5 pb-10 md:px-6 md:pt-6 md:pb-12 lg:px-8 lg:pt-10 lg:pb-16">
          <div className="col mx-auto w-full gap-5 md:max-w-[640px] md:gap-6">
            <Link className="link-more" href="/help" style={{ alignSelf: 'flex-start', minHeight: 32 }}>
              <i className="ic ic-chevron-left" aria-hidden="true" />
              고객센터
            </Link>
            <div className="col gap-1.5 md:gap-2">
              <h1 className={H1}>문의하기</h1>
              <p className="t-sm muted md:text-md">{ANSWER_DUE_TEXT}</p>
            </div>
            {/* key: 상태를 바꾸면 입력을 처음 값으로 다시 그린다 */}
            <InquiryForm key={state} state={state} />
          </div>
        </div>
      </main>
      <PreviewSwitcher path="/help/inquiries/new" states={SCR056_NEW_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
