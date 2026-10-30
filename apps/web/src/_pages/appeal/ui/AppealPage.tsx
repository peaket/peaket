// SCR-042 소명 제출(d5 §5.24, 캔버스 보드 SCR-042-m·t·d를 한 페이지 반응형으로 합쳤다). 주소의 id는 소명 건이다.
// 머리(제목·설명) 아래에 상태별 본문: 작성·제출됨·기한 지남은 CMP-063 AppealForm, 검토 결과·소명 닫힘은 사안 카드 + 결과 카드, 빈 화면.
// 휴대폰 먼저, 태블릿(md)·데스크톱(lg)은 가운데 560 폭 한 단이다. 상태는 ?state=(보드 state 값), 다크는 ?theme=dark.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppealCaseCard, AppealForm } from '@peaket/ds/AppealForm';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { APPEAL_MAX_LENGTH, findAppealByKind, getAppeal, type Appeal } from '@/entities/appeal';
import { getPerformance } from '@/entities/performance';
import { getProduction } from '@/entities/production';
import { SCR042_STATES } from '@/shared/config/screens.account';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { appealView } from '../model/state';

const HINT = '건강 정보 같은 민감한 내용은 적지 않아도 됩니다';
const REVIEW = '기한 안에 소명하면 담당자가 검토합니다';
const INQUIRY_HREF = '/help/inquiries/new';

/** 양도 회수 대상 티켓 글 'LUMEN 콘서트 2026 서울 · 10/25(일) 18:00 · 받은 티켓 1매' */
function targetText(a: Appeal): string | undefined {
  if (!a.target) return undefined;
  const production = getProduction(a.target.productionId);
  const perf = getPerformance(a.target.performanceId);
  return [production?.title, perf?.label, `받은 티켓 ${a.target.quantity}매`].filter(Boolean).join(' · ');
}

export async function AppealPage({ params, searchParams }: PageProps<{ id: string }>) {
  const { id } = await params;
  const base = getAppeal(id);
  if (!base) notFound();
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR042_STATES, base.kind === 'reclaim' ? '양도 회수 사유' : '작성');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = appealView(state);
  // 한 경로에서 두 종류를 미리 본다: 상태의 종류가 경로의 건과 다르면 그 종류의 예시 건을 쓴다
  const appeal = v.kind === base.kind ? base : (findAppealByKind(v.kind) ?? base);
  const reclaim = appeal.kind === 'reclaim';
  const target = targetText(appeal);

  return (
    <AppShell dark={dark}>
      <main className="page-main px-4 pt-4 pb-10 md:px-6 md:pt-8 md:pb-12 lg:pt-10 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[560px] gap-5">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-xl">소명 제출</h1>
            <p className="t-sm muted">예매 제한이나 양도 회수에 대해 사정을 설명합니다</p>
          </div>

          {v.mode === 'form' ? (
            <AppealForm
              key={state}
              idPrefix="ap"
              variant={appeal.kind}
              state={v.formState}
              title={reclaim ? '양도 회수 예고' : '예매 제한'}
              statusLabel={reclaim ? undefined : '제한 중'}
              reasonCategory={appeal.reasonCategory}
              target={target}
              deadlineText={appeal.deadlineText}
              remainingText={`남은 시간 ${appeal.remainingHours}시간`}
              scheduleText={reclaim ? `${REVIEW}. 소명이 합리적이면 회수하지 않습니다` : REVIEW}
              hint={HINT}
              maxLength={APPEAL_MAX_LENGTH}
              defaultValue={v.draft ? appeal.draftText : undefined}
              submitted={{
                submittedAtText: `${appeal.submittedAtText} 제출`,
                // 처리 일정: 예매 제한은 제출일부터 3영업일 [가정], 양도 회수는 그 승인 업무의 기한(입장 시작 전)이다(d5 §5.24)
                scheduleText: reclaim ? (
                  `${REVIEW}. 결과는 입장이 시작되기 전에 알려 드립니다`
                ) : (
                  <>
                    {REVIEW}. 결과는 3영업일 안(<span className="nowrap">{appeal.resultDueText}</span>까지)에 알려 드립니다
                  </>
                ),
                // 양도 회수 소명은 결과 화면과 같이 마이 티켓으로 보낸다(추천안)
                action: reclaim ? (
                  <Link className="btn btn-secondary btn-block" href="/my/tickets">
                    마이 티켓
                  </Link>
                ) : (
                  <Link className="btn btn-secondary btn-block" href="/my/settings">
                    계정 설정
                  </Link>
                ),
              }}
              overdue={{
                message: '기한이 지났습니다. 고객센터로 문의해 주세요',
                action: (
                  <Link className="btn btn-primary btn-lg btn-block" href={INQUIRY_HREF}>
                    문의하기
                  </Link>
                ),
              }}
            />
          ) : null}

          {v.mode === 'result' ? (
            <>
              <AppealCaseCard
                headingId="ap-h"
                variant={appeal.kind}
                title={reclaim ? '양도 회수' : '예매 제한'}
                reasonCategory={appeal.reasonCategory}
                target={target}
                submittedAtText={reclaim ? undefined : appeal.submittedAtText}
              />
              <section className="card col gap-3 px-4 py-5 md:px-5 md:py-6" role="status" aria-labelledby="ap-res-h">
                <h2 id="ap-res-h" className="t-lg">
                  검토 결과
                </h2>
                <dl className="kv">
                  <dt>결과</dt>
                  <dd>
                    {v.result === 'lift' ? <span className="badge badge-success">제한 해제</span> : null}
                    {v.result === 'keep' ? <span className="badge badge-danger">제한 유지</span> : null}
                    {v.result === 'not-reclaimed' ? <span className="badge badge-success">회수하지 않음</span> : null}
                    {v.result === 'reclaimed' ? <span className="badge badge-danger">회수됨</span> : null}
                  </dd>
                </dl>
                {v.result === 'keep' ? (
                  <div className="col" style={{ gap: 4 }}>
                    <span className="eyebrow">사유</span>
                    <p className="t-sm">{appeal.reviewNote}</p>
                  </div>
                ) : null}
                {v.result === 'reclaimed' ? <p className="t-sm">계정 보호 절차로 결제한 분에게 돌아갔습니다</p> : null}
                {reclaim ? (
                  <Link className="btn btn-secondary btn-block" href="/my/tickets">
                    마이 티켓
                  </Link>
                ) : (
                  <Link className="btn btn-secondary btn-block" href="/my/settings">
                    계정 설정
                  </Link>
                )}
              </section>
            </>
          ) : null}

          {v.mode === 'closed' ? (
            <>
              <AppealCaseCard
                headingId="ap-h"
                title="예매 제한"
                reasonCategory={appeal.reasonCategory}
                submittedAtText={appeal.submittedAtText}
              />
              <section className="card col gap-3 px-4 py-5 md:px-5 md:py-6" role="status" aria-labelledby="ap-cl-h">
                <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <h2 id="ap-cl-h" className="t-lg">
                    소명을 처리하지 못했습니다
                  </h2>
                  <span className="badge">닫힘</span>
                </div>
                <p className="t-sm">소명 대상이 이 계정의 것이 아니거나 소명 기한이 지나 이 소명을 닫았습니다. 고객센터로 문의해 주세요</p>
                <Link className="btn btn-primary btn-lg btn-block" href={INQUIRY_HREF}>
                  문의하기
                </Link>
              </section>
            </>
          ) : null}

          {v.mode === 'empty' ? (
            <div className="state px-4 py-14">
              <span className="state-icon">
                <i className="ic ic-inbox" aria-hidden="true" />
              </span>
              <h2 className="t-lg">진행 중인 소명 건이 없습니다</h2>
              <Link className="link-more" href="/my/settings">
                계정 설정
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
            </div>
          ) : null}
        </div>
      </main>
      <PreviewSwitcher path={`/my/appeals/${id}`} states={SCR042_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
