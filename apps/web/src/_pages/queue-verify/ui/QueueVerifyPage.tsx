// SCR-009 추가 검증(d5 §5.9, d3 SCR-009 행, 캔버스 보드 SCR-009-m·t·d를 한 페이지 반응형으로 합쳤다). 주소의 id는 회차다.
// 휴대폰: 본문이 바로 흐른다(여백 24/16). 태블릿(md): 가운데 560 칸. 데스크톱(lg): 바탕(surface-basement) 위 560 카드.
// 순서: 단계 표시 → ① 안내 배너(확인된 사항의 범주만) → ② 사람 확인 자리(CMP-047, 시뮬레이터 자리) → ③ 본인확인 다시 하기
// → ④ 순번 안내 → ⑤ 설명 요청·재검토 신청 → ⑥ 개인정보 처리방침 링크. 통과·재검토 결과 상태는 ①~⑤ 대신 결과 한 덩어리를 보인다.
import Link from 'next/link';
import { Fragment } from 'react';
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
import { AppealForm } from './AppealForm';

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
  return { active: !done, fail: st === '챌린지 실패', submitted, open: !submitted && !done, passed, passBefore, accepted, accBefore, rejected };
}

/** 단계 표시: 휴대폰은 간격을 4px로 줄이고, 폭 320에서는 상자 안에서만 가로로 민다 */
function VerifySteps({ current }: { current: number }) {
  const steps = ['안내', '사람 확인', '본인확인', '완료'];
  return (
    <nav className="stepper relative gap-1 overflow-x-auto md:gap-2" aria-label="검증 단계">
      {steps.map((label, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <Fragment key={label}>
            {i > 0 ? <span className={cx('step-line min-w-2 basis-2 md:min-w-3 md:basis-4', (done || now) && 'is-done')} aria-hidden="true" /> : null}
            <span className={cx('step gap-1 md:gap-2', done && 'is-done', now && 'is-current')} aria-current={now ? 'step' : undefined}>
              <span className="step-num">{done ? <i className="ic ic-check" aria-hidden="true" /> : i + 1}</span>
              {label}
              {done ? <span className="sr-only"> 완료</span> : null}
            </span>
          </Fragment>
        );
      })}
    </nav>
  );
}

function CategoryRow({ center = false }: { center?: boolean }) {
  return (
    <div className={cx('row wrap', center && 'justify-center')} style={{ gap: 6 }}>
      <span className="t-sm muted">확인된 사항의 범주</span>
      <span className="badge badge-outline">{FLAG_CATEGORY}</span>
    </div>
  );
}

const RESULT = 'col items-center text-center';
const RESULT_STYLE = { gap: 14, padding: '32px 8px 16px' } as const;

export async function QueueVerifyPage({ params, searchParams }: Props) {
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
      <main
        className="page-main items-center px-4 pt-6 pb-10 md:px-6 md:pt-10 md:pb-12 lg:bg-(--surface-basement) lg:px-8 lg:pt-12 lg:pb-16"
        id="main"
        tabIndex={-1}
      >
        <div className="col w-full max-w-[560px] gap-6 lg:rounded-(--r-xl) lg:border lg:border-(--border) lg:bg-(--surface) lg:px-7 lg:py-8">
          <div className="col" style={{ gap: 14 }}>
            <h1 className="t-xl">추가 검증</h1>
            {v.active ? <VerifySteps current={1} /> : null}
            {v.passed ? <VerifySteps current={3} /> : null}
          </div>

          {v.active ? (
            <section className="banner banner-info" role="region" aria-label="추가 검증 안내">
              <i className="ic ic-shield" aria-hidden="true" />
              <div className="banner-body col" style={{ gap: 10 }}>
                <p className="t-md fw-b">자동으로 확인된 사항이 있어 한 번 더 확인합니다. 통과하면 원래 순번의 차례에 입장합니다</p>
                <CategoryRow />
                <p>설명을 요청하거나 재검토를 신청할 수 있습니다</p>
              </div>
            </section>
          ) : null}

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
                <div className="banner banner-danger" role="alert">
                  <i className="ic ic-alert-circle" aria-hidden="true" />
                  <div className="banner-body col" style={{ gap: 8 }}>
                    <span>확인하지 못했습니다. 다시 시도해 주세요</span>
                    <Link className={cx(buttonClass({ variant: 'outline', size: 'sm' }), 'self-start')} href={previewHref(path, '검증 중', keep)}>
                      다시 시도
                    </Link>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {v.active ? (
            <div className="col" style={{ gap: 8 }}>
              <p className="t-sm" id="iv-purpose">
                같은 분인지 다시 확인합니다
              </p>
              {/* 이 화면 위에 기관 창(SCR-006 재확인 목적)이 열린다. 복귀 화면의 상태 미리보기를 걷어(HOT-323) 링크 대신 흐름 버튼으로 잇는다 */}
              <VerifyIdentityButton purpose="reverify" className={buttonClass({ variant: 'primary', size: 'lg', block: true })} describedBy="iv-purpose">
                <i className="ic ic-phone" aria-hidden="true" />
                휴대폰 본인확인 다시 하기
              </VerifyIdentityButton>
            </div>
          ) : null}

          {v.active ? (
            <p className="row t-sm" style={{ alignItems: 'flex-start', gap: 8 }}>
              <i className="ic ic-info ic-16 muted" aria-hidden="true" style={{ marginTop: 2 }} />
              <span>통과하면 원래 순번이 그대로입니다. 차례가 이미 지났다면 통과 즉시 입장합니다</span>
            </p>
          ) : null}

          {v.passed ? (
            <section className={RESULT} role="status" style={RESULT_STYLE}>
              <span className="state-icon is-success">
                <i className="ic ic-check-circle" aria-hidden="true" />
              </span>
              <p className="t-lg">{v.passBefore ? '원래 순번으로 돌아갑니다' : '바로 입장합니다'}</p>
              {/* 넘어가는 중(차례 전 → SCR-008 대기열, 차례 지남 → SCR-010 좌석 선택). 새 글은 두지 않는다(d5 추천 적용 2026-10-28) */}
              <span className="spinner muted" aria-hidden="true" />
            </section>
          ) : null}

          {v.accepted ? (
            <section className={RESULT} role="alert" style={RESULT_STYLE}>
              <span className="state-icon is-success">
                <i className="ic ic-check-circle" aria-hidden="true" />
              </span>
              <p className="t-lg">
                {v.accBefore
                  ? '확인 결과 자동 판정이 잘못되었습니다. 원래 순번으로 돌아갑니다'
                  : '확인 결과 자동 판정이 잘못되었습니다. 바로 입장합니다'}
              </p>
              <span className="badge badge-success">재검토 결과 · 인정</span>
            </section>
          ) : null}

          {v.rejected ? (
            <section className={RESULT} role="alert" style={RESULT_STYLE}>
              <span className="state-icon">
                <i className="ic ic-x-circle" aria-hidden="true" />
              </span>
              <p className="t-lg">재검토 결과 판정을 유지합니다. 이 대기 참여는 끝납니다</p>
              <CategoryRow center />
              <p className="t-sm muted">이 판정은 이번 대기 참여에만 적용되며 계정 제재가 아닙니다</p>
              <Link className="link-more" href="/help/inquiries/new">
                문의하기
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
            </section>
          ) : null}

          {v.active ? (
            <section className="col border-t border-(--border)" id="appeal" style={{ gap: 12, paddingTop: 20 }} aria-labelledby="ap-h">
              <div className="row between">
                <h2 className="t-md fw-b" id="ap-h">
                  설명 요청·재검토 신청
                </h2>
                {v.submitted ? <span className="badge badge-primary">접수됨</span> : null}
              </div>
              {v.open ? <AppealForm submittedHref={previewHref(path, '재검토 접수', keep)} /> : null}
              {v.submitted ? (
                <div className="col" style={{ gap: 12 }}>
                  <div className="card-flat col" style={{ gap: 6, padding: '14px 16px' }}>
                    <span className="eyebrow">보낸 내용</span>
                    <p className="t-sm">{SENT_TEXT}</p>
                  </div>
                  <ol className="stepper relative gap-1 overflow-x-auto md:gap-2" aria-label="재검토 진행">
                    <li className="step is-current gap-1 md:gap-2" aria-current="step">
                      <span className="step-num">
                        <i className="ic ic-check" aria-hidden="true" />
                      </span>
                      접수됨
                    </li>
                    <li className="step-line min-w-2 basis-2 md:min-w-3 md:basis-4" aria-hidden="true" />
                    <li className="step gap-1 md:gap-2">
                      <span className="step-num">2</span>검토 중
                    </li>
                    <li className="step-line min-w-2 basis-2 md:min-w-3 md:basis-4" aria-hidden="true" />
                    <li className="step gap-1 md:gap-2">
                      <span className="step-num">3</span>결과 통지
                    </li>
                  </ol>
                  <p className="hint" role="status">
                    재검토를 신청했습니다. 티켓 오픈 전후(오픈 10분 전부터 60분 뒤까지)에는 30분 안에 확인하려고 합니다. 결과와 설명은 늦어도 10영업일 안에
                    이메일로 보내고 웹 푸시로도 알려 드립니다
                  </p>
                </div>
              ) : null}
            </section>
          ) : null}

          <Link className="link-more self-start" href="/policy/privacy">
            개인정보 처리방침: 자동화된 결정
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </div>
      </main>
      <PreviewSwitcher path={path} states={SCR009_STATES} current={state} keep={keep} />
    </AppShell>
  );
}
