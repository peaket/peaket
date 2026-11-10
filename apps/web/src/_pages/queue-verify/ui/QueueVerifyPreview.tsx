// SCR-009 추가 검증의 퍼블리싱 미리보기(d5 §5.9, d3 SCR-009 행, 캔버스 보드 SCR-009-m·t·d를 한 페이지 반응형으로 합쳤다). 주소의 id는 회차다.
// 개발 서버에서 ?state=를 줄 때만 쓴다(QueueVerifyPage, ADR-0228). 운영 묶음에는 들지 않는다. 데이터에 잇는 화면은 QueueVerifyLive다.
// 휴대폰: 본문이 바로 흐른다(여백 24/16). 태블릿(md): 가운데 560 칸. 데스크톱(lg): 바탕(surface-basement) 위 560 카드.
// 순서: 단계 표시 → ① 안내 배너(확인된 사항의 범주만) → ② 사람 확인 자리(CMP-047, 시뮬레이터 자리) → ③ 본인확인 다시 하기
// → ④ 순번 안내 → ⑤ 설명 요청·재검토 신청 → ⑥ 개인정보 처리방침 링크. 통과·재검토 결과 상태는 ①~⑤ 대신 결과 한 덩어리를 보인다.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { buttonClass } from '@peaket/ds/Button';
import { previewHref, resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { getPerformance } from '@/entities/performance';
import { getProduction } from '@/entities/production';
import { getVenue } from '@/entities/venue';
import { VerifyIdentityButton } from '@/features/identity-verify';
import { SCR009_STATES, type Scr009State } from '@/shared/config/screens.booking';
import { cx } from '@/shared/lib/cx';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { COPY } from '../model/view';
import { AppealForm } from './AppealForm';
import { AcceptedResult, AppealHeading, AppealReceived, DangerBanner, IntroBanner, PassedResult, PrivacyLink, RejectedResult, TurnNote, VerifyFrame, VerifySteps } from './parts';

type Props = PageProps<{ eventId: string }>;

/** 확인된 사항의 범주(세부 기준은 공개하지 않는다, d5 §5.9 ①) */
const FLAG_CATEGORY = '짧은 시간 많은 요청';
/** 재검토 접수 상태에서 보인 '보낸 내용'(보드 값) */
const SENT_TEXT = '오픈 직전에 새로고침을 여러 번 눌렀습니다. 자동 프로그램은 쓰지 않았습니다.';

function view(st: Scr009State) {
  const passBefore = st === '통과, 차례 전';
  const passAfter = st === '통과, 차례 지남';
  const accBefore = st === '재검토 결과 인정(차례 전)';
  const accAfter = st === '재검토 결과 인정(차례 지남)';
  const rejected = st === '재검토 결과 기각';
  const submitted = st === '재검토 접수';
  const accepted = accBefore || accAfter;
  const passed = passBefore || passAfter;
  const done = accepted || rejected || passed;
  const reverify = st === '본인확인 다시 필요' || st === '다른 분으로 확인됨';
  return { active: !done, fail: st === '챌린지 실패', submitted, open: !submitted && !done, passed, passBefore, accepted, accBefore, rejected, reverify, mismatch: st === '다른 분으로 확인됨', retry: st === '잠시 뒤 다시 시도' };
}

export async function QueueVerifyPreview({ params, searchParams }: Props) {
  const { eventId } = await params;
  const perf = getPerformance(eventId);
  const production = perf ? getProduction(perf.productionId) : undefined;
  const venue = production ? getVenue(production.venueId) : undefined;
  if (!perf || !production || !venue) notFound();
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR009_STATES, '검증 중');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const keep = { theme: dark ? 'dark' : undefined };
  const path = `/queue/${perf.id}/verify`;
  const v = view(state);

  return (
    <AppShell
      variant="focus"
      dark={dark}
      focus={{ title: production.title, subtitle: `${perf.label} · ${venue.name}`, closeHref: `/events/${perf.id}` }}
    >
      <VerifyFrame>
        <div className="col" style={{ gap: 14 }}>
          <h1 className="t-xl">추가 검증</h1>
          {v.active ? <VerifySteps current={v.reverify ? 2 : 1} /> : null}
          {v.passed ? <VerifySteps current={3} /> : null}
        </div>

        {v.active ? <IntroBanner reason={FLAG_CATEGORY} /> : null}

        {v.active ? (
          <section className="col" style={{ gap: 10 }} aria-labelledby="ch-h">
            <h2 className="t-md fw-b" id="ch-h">
              사람 확인
            </h2>
            {/* CMP-047 사람 확인 위젯 자리(시뮬레이터 자리, design.md 결정 8). 실제 SDK는 붙이지 않는다 */}
            <div
              className="card center min-h-[132px] md:min-h-40"
              role="group"
              aria-label="사람 확인 심층 챌린지"
              style={{ borderStyle: 'dashed', padding: 16, textAlign: 'center' }}
            >
              <div className="col items-center" style={{ gap: 8 }}>
                <i className="ic ic-shield ic-32 muted" aria-hidden="true" />
                <span className="t-sm muted">사람 확인 창이 이 자리에 열립니다</span>
              </div>
            </div>
            {v.fail ? (
              <DangerBanner
                text={COPY.challengeFailed}
                action={
                  <Link className={cx(buttonClass({ variant: 'outline', size: 'sm' }), 'self-start')} href={previewHref(path, '검증 중', keep)}>
                    다시 시도
                  </Link>
                }
              />
            ) : null}
            {v.retry ? (
              <DangerBanner
                text={COPY.challengeFailed}
                sub={
                  <span className="t-sm">
                    {COPY.autoRetry} · <span className="num">7초</span>
                  </span>
                }
              />
            ) : null}
          </section>
        ) : null}

        {v.active ? (
          <div className="col" style={{ gap: 8 }}>
            <p className="t-sm" id="iv-purpose">
              같은 분인지 다시 확인합니다
            </p>
            {v.reverify ? <DangerBanner text={v.mismatch ? COPY.personMismatch : COPY.reverifyAgain} /> : null}
            {/* 이 화면 위에 기관 창(SCR-006 재확인 목적)이 열린다. 복귀 화면의 상태 미리보기를 걷어(HOT-323) 링크 대신 흐름 버튼으로 잇는다 */}
            <VerifyIdentityButton purpose="reverify" className={buttonClass({ variant: 'primary', size: 'lg', block: true })} describedBy="iv-purpose">
              <i className="ic ic-phone" aria-hidden="true" />
              휴대폰 본인확인 다시 하기
            </VerifyIdentityButton>
          </div>
        ) : null}

        {v.active ? <TurnNote /> : null}

        {v.passed ? <PassedResult turn={v.passBefore ? 'before' : 'after'} /> : null}
        {v.accepted ? <AcceptedResult turn={v.accBefore ? 'before' : 'after'} /> : null}
        {v.rejected ? <RejectedResult reason={FLAG_CATEGORY} /> : null}

        {v.active ? (
          <section className="col border-t border-(--border)" id="appeal" style={{ gap: 12, paddingTop: 20 }} aria-labelledby="ap-h">
            <AppealHeading received={v.submitted} />
            {v.open ? <AppealForm submittedHref={previewHref(path, '재검토 접수', keep)} /> : null}
            {v.submitted ? <AppealReceived text={SENT_TEXT} /> : null}
          </section>
        ) : null}

        <PrivacyLink />
      </VerifyFrame>
      <PreviewSwitcher path={path} states={SCR009_STATES} current={state} keep={keep} />
    </AppShell>
  );
}
