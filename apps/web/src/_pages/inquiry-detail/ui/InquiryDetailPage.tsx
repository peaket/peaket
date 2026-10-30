// SCR-056 문의 상세(/help/inquiries/[id], d5 §5.30, 캔버스 보드 SCR-056-m·t·d의 '문의 상세'·'접수 완료'·'분쟁 문의 상세'·'닫힌 문의'·'문의를 찾을 수 없음').
// 머리(상태·접수 번호·유형·접수 일시·관련 주문) → (분쟁 유형) 기한 상자 → 문의 기록(시간 순 ol) → 추가 문의 또는 닫힌 문의 안내.
// 한 열(태블릿 640, 데스크톱 720 가운데). 태블릿부터 머리 정보가 바탕 상자, 추가 문의가 카드.
// 상태: ?state=가 없으면 주소의 문의를 그대로 그린다(없는 문의·남의 문의는 똑같이 '찾을 수 없음'). ?submitted=1은 막 접수한 직후(토스트).
// 로그인 화면이다(비로그인이면 SCR-004를 거쳐 돌아온다 — 퍼블리싱에는 세션이 없어 늘 로그인 모양으로 그린다).
import Link from 'next/link';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import {
  DEMO_DISPUTE_INQUIRY_ID,
  DEMO_INQUIRY_ID,
  getInquiry,
  InquiryStatusBadge,
  type Inquiry,
  type InquiryMessage,
} from '@/entities/inquiry';
import { SCR056_DETAIL_STATES, type Scr056DetailState } from '@/shared/config/screens.discovery';
import { firstParam, type PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { FollowUpForm, SubmittedToast } from './DetailClient';

type Props = PageProps<{ id: string }>;

const H1 = 't-xl md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]';
const WRAP = 'mx-auto w-full max-w-[1040px] px-4 pt-5 pb-10 md:px-6 md:pt-6 md:pb-12 lg:px-8 lg:pt-10 lg:pb-16';

function fallbackState(found: Inquiry | undefined, submitted: boolean): Scr056DetailState {
  if (!found) return '문의를 찾을 수 없음';
  if (submitted) return '접수 완료';
  if (found.dispute) return '분쟁 문의 상세';
  if (found.status === '닫힘') return '닫힌 문의';
  return '문의 상세';
}

/** 상태에 맞춰 그릴 문의(보드 예시: 일반은 inq-0001, 분쟁은 inq-0002) */
function viewInquiry(state: Scr056DetailState, found: Inquiry | undefined): Inquiry | null {
  if (state === '문의를 찾을 수 없음') return null;
  if (state === '분쟁 문의 상세') return found?.dispute ? found : (getInquiry(DEMO_DISPUTE_INQUIRY_ID) ?? null);
  const base = found && !found.dispute ? found : getInquiry(DEMO_INQUIRY_ID);
  if (!base) return null;
  if (state === '접수 완료') return { ...base, status: '접수됨', newAnswer: false, answeredDate: undefined, messages: base.messages.slice(0, 1) };
  if (state === '닫힌 문의') return { ...base, status: '닫힘', closedDate: base.closedDate ?? '10/29(목)' };
  return base;
}

export async function InquiryDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const found = getInquiry(id);
  const state = resolvePreviewState(sp, SCR056_DETAIL_STATES, fallbackState(found, firstParam(sp, 'submitted') === '1'));
  const dark = resolvePreviewTheme(sp) === 'dark';
  const q = viewInquiry(state, found);

  return (
    <AppShell variant="default" dark={dark}>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className={WRAP}>
          {q ? <Detail q={q} /> : <NotFound />}
        </div>
      </main>
      {state === '접수 완료' && q ? <SubmittedToast no={q.no} /> : null}
      <PreviewSwitcher path={`/help/inquiries/${id}`} states={SCR056_DETAIL_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}

function BackLink() {
  return (
    <Link className="link-more" href="/help/inquiries" style={{ alignSelf: 'flex-start', minHeight: 32 }}>
      <i className="ic ic-chevron-left" aria-hidden="true" />내 문의 내역
    </Link>
  );
}

const DOT: Record<InquiryMessage['kind'], string> = { '내 문의': 'info', '진행 경과': 'warn', 답변: 'ok' };

function Detail({ q }: { q: Inquiry }) {
  const open = q.status !== '닫힘';
  return (
    <div className="col mx-auto w-full gap-7 md:max-w-[640px] md:gap-8 lg:max-w-[720px]">
      <BackLink />
      <div className="col gap-3 md:gap-3.5">
        <div className="row wrap" style={{ gap: '6px 8px' }}>
          <InquiryStatusBadge status={q.status} />
          {q.status === '닫힘' && q.closedDate ? <span className="t-xs muted">{q.closedDate} 닫힘</span> : null}
        </div>
        <h1 className={H1}>{q.title}</h1>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-2 text-sm leading-5 md:gap-x-5 md:gap-y-2.5 md:rounded-(--r-xl) md:bg-(--surface-muted) md:px-5 md:py-4 lg:gap-x-6 lg:px-6 lg:py-[18px]">
          <dt className="muted">접수 번호</dt>
          <dd className="mono">{q.no}</dd>
          <dt className="muted">유형</dt>
          <dd>{q.type}</dd>
          <dt className="muted">접수</dt>
          <dd className="num">{q.submittedAt}</dd>
          <dt className="muted">관련 주문</dt>
          {q.order ? (
            <dd className="col gap-1 md:flex-row md:flex-wrap md:gap-x-3 md:gap-y-1">
              <span>
                {q.order.label}
                {q.order.bookingNo ? (
                  <>
                    {' '}
                    <span className="mono">{q.order.bookingNo}</span>
                  </>
                ) : null}
              </span>
              {/* 예매 확인서 = 예매·주문 내역의 주문 상세(SCR-055). 굿즈 주문의 링크 글은 추천안 */}
              <Link className="link-more" href={`/my/orders/${encodeURIComponent(q.order.id)}`} style={{ alignSelf: 'flex-start', minHeight: 32 }}>
                {q.order.kind === 'ticket' ? '예매 확인서 보기' : '주문 상세 보기'}
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
            </dd>
          ) : (
            <dd>선택 안 함</dd>
          )}
        </dl>
        {q.dispute ? (
          <div className="banner banner-info" role="note" aria-label="처리 기한">
            <i className="ic ic-clock" aria-hidden="true" />
            <div className="banner-body">
              진행 경과 안내 기한 <span className="num">{q.dispute.progressDue}</span>(3영업일) · 결과 안내 기한 <span className="num">{q.dispute.resultDue}</span>(10영업일)
            </div>
          </div>
        ) : null}
      </div>

      <section className="col gap-3.5 md:gap-4" aria-labelledby="h-rec">
        <h2 className="t-lg" id="h-rec">
          문의 기록
        </h2>
        <ol className="timeline">
          {q.messages.map((m) => (
            <li key={`${m.kind}-${m.at}`} className="tl-item">
              <span className={`tl-dot ${DOT[m.kind]}`} aria-hidden="true" />
              <div className="col min-w-0 gap-1.5 lg:gap-2">
                <span className="row wrap" style={{ gap: '2px 8px' }}>
                  <span className="t-sm fw-b">{m.kind}</span>
                  {m.kind === '내 문의' ? (
                    <span className="t-xs muted num">{m.at}</span>
                  ) : (
                    <span className="t-xs muted">
                      피켓 고객센터 · <span className="num">{m.at}</span>
                    </span>
                  )}
                </span>
                <p className={m.kind === '답변' ? 'card t-sm' : 'card-flat t-sm'} style={{ padding: '12px 14px' }}>
                  {m.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {open ? (
        <section className="col gap-3 md:rounded-(--r-xl) md:border md:border-(--border) md:bg-(--surface) md:p-6 lg:gap-3.5" aria-labelledby="h-more">
          <h2 className="t-lg" id="h-more">
            추가 문의
          </h2>
          <FollowUpForm id="q-more" />
        </section>
      ) : (
        <div className="card-flat col gap-3.5 p-4 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-4 md:p-6" role="note">
          <p className="row t-md fw-b" style={{ gap: 8, alignItems: 'flex-start' }}>
            <i className="ic ic-lock" aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
            닫힌 문의입니다. 더 궁금한 점은 새로 문의해 주세요
          </p>
          <Link className="btn btn-primary btn-lg btn-block md:w-auto" href="/help/inquiries/new">
            새로 문의하기
          </Link>
        </div>
      )}
    </div>
  );
}

/** 없는 문의와 남의 문의는 같은 화면(있는지 여부를 알리지 않는다) */
function NotFound() {
  return (
    <div className="col gap-5 md:gap-6 lg:items-center">
      <BackLink />
      <div className="card state w-full gap-3 px-5 py-9 lg:w-[520px] lg:gap-3.5 lg:px-10 lg:py-11">
        <span className="state-icon h-14 w-14 lg:h-16 lg:w-16">
          <i className="ic ic-search" aria-hidden="true" />
        </span>
        <h1 className="t-lg lg:text-xl">문의를 찾을 수 없습니다</h1>
        <Link className="link-more" href="/help/inquiries" style={{ minHeight: 44 }}>
          내 문의 내역
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
