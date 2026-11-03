// SCR-056 고객센터 FAQ(d5 §5.30, d3 SCR-056 행, 캔버스 보드 SCR-056-m·t·d의 'FAQ'·'비로그인'을 한 페이지 반응형으로 합쳤다).
// 휴대폰: 머리(h1·검색) → 자주 묻는 질문 → 문의하기 카드 → 내 문의 → 약관·정책. 태블릿(md): 문의하기·내 문의가 두 칸 카드.
// 데스크톱(lg): 본문 1040 상자, 질문 8열 + 오른쪽 4열(문의하기·내 문의·약관 카드). FAQ는 누구나, 문의는 로그인 뒤(비로그인은 로그인 버튼).
import Link from 'next/link';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ANSWER_DUE_TEXT, INQUIRIES, InquiryStatusBadge, inquiryHref, inquiryTypeShort } from '@/entities/inquiry';
import { SCR056_HELP_STATES } from '@/shared/config/screens.discovery';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { FAQ_ITEMS } from '../model/faq';
import { FaqSection } from './FaqSection';

const LOGIN_TO_ASK = `/login?next=${encodeURIComponent('/help/inquiries/new')}`;
/** 휴대폰은 맨 섹션, 태블릿부터 카드 */
const CARD_MD = 'md:rounded-(--r-xl) md:border md:border-(--border) md:bg-(--surface) md:p-6 lg:p-4';

export async function HelpPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR056_HELP_STATES, 'FAQ');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const guest = state === '비로그인';
  // 내 문의 미리보기: 최근 두 건(보드)
  const recent = INQUIRIES.slice(0, 2);

  const aside = (
    <div className="col gap-7 md:gap-8 lg:col-span-4 lg:gap-5">
      {guest ? (
        <section className="card col gap-3 p-4 md:p-6" aria-labelledby="h-ask-g">
          <div className="section-title">
            <h2 id="h-ask-g">문의하기</h2>
          </div>
          <p className="t-sm muted">자주 묻는 질문은 누구나 볼 수 있고, 문의는 로그인한 뒤 남길 수 있습니다. {ANSWER_DUE_TEXT}</p>
          <Link className="btn btn-primary btn-lg btn-block" href={LOGIN_TO_ASK}>
            로그인하고 문의하기
          </Link>
        </section>
      ) : (
        <div className="col gap-7 md:grid md:grid-cols-2 md:items-start md:gap-4 lg:flex lg:flex-col lg:gap-5">
          <section className="card col gap-3 p-4 md:p-6" aria-labelledby="h-ask">
            <div className="section-title">
              <h2 id="h-ask">문의하기</h2>
            </div>
            <p className="t-sm muted">{ANSWER_DUE_TEXT}</p>
            <Link className="btn btn-primary btn-lg btn-block" href="/help/inquiries/new">
              문의하기
            </Link>
            <Link className="link-more" href="/help/inquiries" style={{ alignSelf: 'center', minHeight: 32 }}>
              내 문의 내역
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </Link>
          </section>

          <section className={`col ${CARD_MD}`} aria-labelledby="h-my">
            <div className="section-title">
              <h2 id="h-my">내 문의</h2>
            </div>
            <ul className="col">
              {recent.map((q, i) => (
                <li key={q.id}>
                  <Link
                    className={i === recent.length - 1 ? 'col gap-1.5 border-b border-(--border) py-3.5 md:border-b-0 md:pb-0 lg:pt-3' : 'col gap-1.5 border-b border-(--border) py-3.5 lg:py-3'}
                    href={inquiryHref(q.id)}
                    style={{ color: 'inherit' }}
                  >
                    <span className="row wrap" style={{ gap: 6 }}>
                      <InquiryStatusBadge status={q.status} />
                      {q.newAnswer ? <span className="badge badge-solid">새 답변</span> : null}
                      <span className="t-xs muted">{inquiryTypeShort(q.type)}</span>
                    </span>
                    <span className="t-md fw-b ellipsis">{q.title}</span>
                    <span className="t-sm muted">
                      접수 <span className="num">{q.submittedDate}</span>
                      {q.answeredDate ? (
                        <>
                          {' '}
                          · 답변 <span className="num">{q.answeredDate}</span>
                        </>
                      ) : null}
                      {/* 휴대폰은 관련 공연도 한 줄에(보드 SCR-056-m) */}
                      {q.order ? <span className="md:hidden"> · {q.order.short}</span> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      <nav className="col gap-2.5 lg:rounded-(--r-xl) lg:bg-(--surface-muted) lg:p-4" aria-labelledby="h-pol">
        <div className="section-title">
          <h2 id="h-pol">약관·정책</h2>
        </div>
        <div className="row wrap gap-x-[18px] gap-y-2 lg:flex-col lg:items-start lg:gap-2.5">
          {[
            { href: '/policy/dispute', label: '분쟁 해결 기준' },
            { href: '/policy/terms', label: '이용약관' },
            { href: '/policy/privacy', label: '개인정보 처리방침' },
          ].map((l) => (
            <Link key={l.href} className="link-more" href={l.href}>
              {l.label}
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );

  return (
    <AppShell variant="default" dark={dark} guest={guest}>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[1040px] gap-7 px-4 pt-5 pb-10 md:gap-8 md:px-6 md:pt-6 md:pb-12 lg:gap-7 lg:px-8 lg:pt-10 lg:pb-16">
          <FaqSection items={FAQ_ITEMS} aside={aside} />
        </div>
      </main>
      <PreviewSwitcher path="/help" states={SCR056_HELP_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
