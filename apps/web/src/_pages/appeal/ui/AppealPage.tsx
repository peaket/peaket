// SCR-042 소명 제출(d5 §5.24, 캔버스 보드 SCR-042-m·t·d를 한 페이지 반응형으로 합쳤다). 주소의 id는 소명 건이다.
// 머리(제목·설명) 아래에 상태별 본문: 작성·제출됨·기한 지남은 CMP-063 AppealForm, 검토 결과·소명 닫힘은 사안 카드 + 결과 카드, 빈 화면.
// 휴대폰 먼저, 태블릿(md)·데스크톱(lg)은 가운데 560 폭 한 단이다. 상태는 ?state=(보드 state 값), 다크는 ?theme=dark.
// 부정 예매 소명(apl-0003 결제자, CMP-063 fraud)은 보드가 없어 d5 §5.24 '부정 예매 소명' 그림을 따른다. 팬 화면 사본(FraudAppealView)의 칸만 보이고,
// 사건의 다른 계정·점수·가중치·근거 신호·조사관은 보이지 않는다(docs/security/authz-matrix.md §4.1 마지막 행).
// 2026-10-31 법률 검토(ADR-0173)로 잠금 최대 기한 문장, 양도 잠금 풀림·조치 결과·이의 결과, 받은 사람 변형(apl-0004, CMP-063 fraud holder:
// 사유 범주·잠금 줄·이용 제한·이의·우선 구매 없음)을 더했다(apply-legal-review-to-screens).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppealCaseCard, AppealForm, type AppealLockedTickets } from '@peaket/ds/AppealForm';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import {
  ACTIONED_LABEL,
  APPEAL_MAX_LENGTH,
  FAMILY_NOTICE,
  FRAUD_ACCEPTED_TEXT,
  FRAUD_APPEAL_TITLE,
  FRAUD_REJECTED_TEXT,
  FRAUD_STATUS_LABEL,
  FRAUD_SUBMITTED_SCHEDULE,
  FRAUD_SUBTITLE,
  HOLDER_CANCELLED_TEXT,
  HOLDER_ENTRY_TEXT,
  HOLDER_EXCLUDED_TEXT,
  HOLDER_FIELD_LABEL,
  HOLDER_HINT,
  HOLDER_INQUIRY_TEXT,
  HOLDER_NOTICE,
  HOLDER_REFUND_TEXT,
  HOLDER_REVIEW,
  HOLDER_SUBMITTED_SCHEDULE,
  HOLDER_SUBTITLE,
  HOLDER_TITLE,
  LOCK_RELEASED_TEXT,
  OBJECTION_RESULT_LABEL,
  actionResultLines,
  findAppealByKind,
  fraudPartyShows,
  fraudReasonLabels,
  getAppeal,
  heldTicketsText,
  holderTicketResultLines,
  lockNoticeText,
  lockedTicketsText,
  releasedTicketsText,
  unlockedTicketsText,
  type Appeal,
  type AppealKind,
} from '@/entities/appeal';
import { getPerformance } from '@/entities/performance';
import { getProduction } from '@/entities/production';
import { SCR042_STATES, type Scr042State } from '@/shared/config/screens.account';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { appealView, type AppealView } from '../model/state';
import { ObjectionToggle } from './ObjectionToggle';

const HINT = '건강 정보 같은 민감한 내용은 적지 않아도 됩니다';
const REVIEW = '기한 안에 소명하면 담당자가 검토합니다';
const INQUIRY_HREF = '/help/inquiries/new';
const BTN_SECONDARY = 'btn btn-secondary btn-block';

/** 경로의 소명 건 종류마다 기본 상태(부정 예매는 받은 사람이면 '받은 표 확인 요청') */
function defaultState(a: Appeal): Scr042State {
  const byKind: Record<AppealKind, Scr042State> = { restriction: '작성', reclaim: '양도 회수 사유', fraud: '부정 예매 소명' };
  return a.kind === 'fraud' && a.party === 'HOLDER' ? '받은 표 확인 요청' : byKind[a.kind];
}

/** 한 경로에서 여러 종류를 미리 본다: 상태의 종류·갈래가 경로의 건과 다르면 그 종류의 예시 건을 쓴다 */
function pickAppeal(v: AppealView, base: Appeal): Appeal {
  if (v.kind === base.kind && v.party === base.party) return base;
  return findAppealByKind(v.kind, v.party) ?? base;
}

/** 대상 글. 양도 회수 'LUMEN 콘서트 2026 서울 · 10/25(일) 18:00 · 받은 티켓 1매', 부정 예매 소명은 매수 없이 공연과 회차만 */
function targetText(a: Appeal): string | undefined {
  if (!a.target) return undefined;
  const production = getProduction(a.target.productionId);
  const perf = getPerformance(a.target.performanceId);
  const quantity = a.target.quantity !== undefined ? `받은 티켓 ${a.target.quantity}매` : undefined;
  return [production?.title, perf?.label, quantity].filter(Boolean).join(' · ');
}

/**
 * 부정 예매 소명(결제자)의 잠긴 티켓 묶음. 잠긴 동안은 잠금 최대 기한 문장(lockExpiresAt, ADR-0173 결정 3)을 붙인다.
 * unlocked: 소명 인정 뒤(같은 티켓, 안내 없음) · released: 소명 상태는 그대로이고 잠금만 풀린 뒤
 */
function lockedTickets(a: Appeal, mode: 'locked' | 'unlocked' | 'released' = 'locked'): AppealLockedTickets | undefined {
  const seats = a.lockedSeatLabels;
  if (!seats || seats.length === 0) return undefined;
  if (mode === 'unlocked') return { heading: unlockedTicketsText(seats.length), items: seats };
  if (mode === 'released') return { heading: releasedTicketsText(seats.length), items: seats };
  return { heading: lockedTicketsText(seats.length), items: seats, notice: a.lockExpiresAtText ? lockNoticeText(a.lockExpiresAtText) : undefined };
}

/** 받은 사람이 가진 이 사건의 표(잠기지 않음, 표 아이콘). withNotes면 입장·환급 안내 두 줄을 붙인다 */
function heldTickets(a: Appeal, withNotes: boolean): AppealLockedTickets | undefined {
  const seats = a.heldSeatLabels;
  if (!seats || seats.length === 0) return undefined;
  return { heading: heldTicketsText(seats.length), items: seats, icon: 'ticket', notice: withNotes ? [HOLDER_ENTRY_TEXT, HOLDER_REFUND_TEXT] : undefined };
}

export async function AppealPage({ params, searchParams }: PageProps<{ id: string }>) {
  const { id } = await params;
  const base = getAppeal(id);
  if (!base) notFound();
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR042_STATES, defaultState(base));
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = appealView(state);
  const appeal = pickAppeal(v, base);
  const reclaim = appeal.kind === 'reclaim';
  const fraud = appeal.kind === 'fraud';
  const holder = fraud && appeal.party === 'HOLDER';
  const target = targetText(appeal);
  // 부정 예매 소명: 결제자에게만 알린 사유 범주를 모두 배지로(이름표는 openapi FraudReasonCategory 다섯). 받은 사람에게는 없다
  const shows = fraud ? fraudPartyShows(holder ? 'HOLDER' : 'PAYER') : undefined;
  const reasonLabels = shows?.reasonCategories && appeal.reasonCategories ? fraudReasonLabels(appeal.reasonCategories) : undefined;
  const formTitle = holder ? HOLDER_TITLE : fraud ? FRAUD_APPEAL_TITLE : reclaim ? '양도 회수 예고' : '예매 제한';
  // '답변 기다림'은 제출 전(OPEN)에만. 제출 뒤에는 제출 카드의 <제출됨>이 상태를 알린다
  const formStatus = fraud ? (v.formState === 'default' ? FRAUD_STATUS_LABEL : undefined) : reclaim ? undefined : '제한 중';
  const subtitle = holder ? HOLDER_SUBTITLE : fraud ? FRAUD_SUBTITLE : '예매 제한이나 양도 회수에 대해 사정을 설명합니다';

  return (
    <AppShell dark={dark}>
      <main className="page-main px-4 pt-4 pb-10 md:px-6 md:pt-8 md:pb-12 lg:pt-10 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[560px] gap-5">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-xl">소명 제출</h1>
            <p className="t-sm muted">{subtitle}</p>
          </div>

          {v.mode === 'form' ? (
            <AppealForm
              key={state}
              idPrefix="ap"
              variant={holder ? 'fraud-holder' : appeal.kind}
              state={v.formState}
              title={formTitle}
              statusLabel={formStatus}
              reasonCategory={appeal.reasonCategory}
              reasonCategories={reasonLabels}
              target={target}
              targetLabel={fraud ? '공연' : undefined}
              lockedTickets={holder ? heldTickets(appeal, true) : shows?.lockLine ? lockedTickets(appeal) : undefined}
              notice={holder ? HOLDER_NOTICE : fraud ? FAMILY_NOTICE : undefined}
              deadlineText={appeal.deadlineText}
              remainingText={`남은 시간 ${appeal.remainingHours}시간`}
              scheduleText={holder ? HOLDER_REVIEW : reclaim ? `${REVIEW}. 소명이 합리적이면 회수하지 않습니다` : REVIEW}
              fieldLabel={holder ? HOLDER_FIELD_LABEL : undefined}
              hint={holder ? HOLDER_HINT : HINT}
              maxLength={APPEAL_MAX_LENGTH}
              defaultValue={v.draft ? appeal.draftText : undefined}
              submitted={{
                submittedAtText: `${appeal.submittedAtText} 제출`,
                // 처리 일정: 예매 제한은 제출일부터 3영업일 [가정], 양도 회수는 그 승인 업무의 기한(입장 시작 전)이다(d5 §5.24).
                // 부정 예매 소명은 d5 ③ 글 그대로(결과와 사유 범주를 알리고, 잠금은 늦어도 14일 뒤 풀린다). 받은 사람은 결과만 알린다
                scheduleText: holder ? (
                  `${HOLDER_REVIEW}. ${HOLDER_SUBMITTED_SCHEDULE}`
                ) : fraud ? (
                  `${REVIEW}. ${FRAUD_SUBMITTED_SCHEDULE}`
                ) : reclaim ? (
                  `${REVIEW}. 결과는 입장이 시작되기 전에 알려 드립니다`
                ) : (
                  <>
                    {REVIEW}. 결과는 3영업일 안(<span className="nowrap">{appeal.resultDueText}</span>까지)에 알려 드립니다
                  </>
                ),
                // 양도 회수·부정 예매 소명은 결과 화면과 같이 마이 티켓으로 보낸다(추천안)
                action: reclaim || fraud ? (
                  <Link className={BTN_SECONDARY} href="/my/tickets">
                    마이 티켓
                  </Link>
                ) : (
                  <Link className={BTN_SECONDARY} href="/my/settings">
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

          {v.mode === 'result' && shows && !holder ? <PayerResult appeal={appeal} v={v} target={target} reasonLabels={reasonLabels} shows={shows} /> : null}

          {v.mode === 'result' && holder ? <HolderResult appeal={appeal} v={v} target={target} /> : null}

          {v.mode === 'result' && !fraud ? (
            <>
              <AppealCaseCard
                headingId="ap-h"
                variant={appeal.kind}
                title={reclaim ? '양도 회수' : '예매 제한'}
                reasonCategory={appeal.reasonCategory}
                target={target}
                submittedAtText={reclaim ? undefined : appeal.submittedAtText}
              />
              <ResultCard
                heading="검토 결과"
                badge={
                  <>
                    {v.result === 'lift' ? <span className="badge badge-success">제한 해제</span> : null}
                    {v.result === 'keep' ? <span className="badge badge-danger">제한 유지</span> : null}
                    {v.result === 'not-reclaimed' ? <span className="badge badge-success">회수하지 않음</span> : null}
                    {v.result === 'reclaimed' ? <span className="badge badge-danger">회수됨</span> : null}
                  </>
                }
              >
                {v.result === 'keep' ? (
                  <div className="col" style={{ gap: 4 }}>
                    <span className="eyebrow">사유</span>
                    <p className="t-sm">{appeal.reviewNote}</p>
                  </div>
                ) : null}
                {v.result === 'reclaimed' ? <p className="t-sm">계정 보호 절차로 결제한 분에게 돌아갔습니다</p> : null}
                {reclaim ? (
                  <Link className={BTN_SECONDARY} href="/my/tickets">
                    마이 티켓
                  </Link>
                ) : (
                  <Link className={BTN_SECONDARY} href="/my/settings">
                    계정 설정
                  </Link>
                )}
              </ResultCard>
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

/** 결과 카드 틀(role="status", 머리 글 + 결과 배지 kv) */
function ResultCard({ heading, badge, children }: { heading: string; badge: ReactNode; children: ReactNode }) {
  return (
    <section className="card col gap-3 px-4 py-5 md:px-5 md:py-6" role="status" aria-labelledby="ap-res-h">
      <h2 id="ap-res-h" className="t-lg">
        {heading}
      </h2>
      <dl className="kv">
        <dt>결과</dt>
        <dd>{badge}</dd>
      </dl>
      {children}
    </section>
  );
}

/** 좌석 목록(표 아이콘). 조치 결과의 취소한 표 · 받은 사람의 표마다 결과 */
function SeatList({ headingId, heading, label, items }: { headingId: string; heading?: string; label?: string; items: readonly string[] }) {
  return (
    <div className="col" style={{ gap: 8 }}>
      {heading ? (
        <h3 id={headingId} className="t-sm fw-b">
          {heading}
        </h3>
      ) : null}
      <ul className="col" style={{ gap: 6 }} aria-labelledby={heading ? headingId : undefined} aria-label={heading ? undefined : label}>
        {items.map((item) => (
          <li key={item} className="row t-sm" style={{ gap: 8 }}>
            <i className="ic ic-ticket ic-16 muted" aria-hidden="true" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 결제자(party PAYER)의 결과: 인정·불인정·양도 잠금 풀림·조치 결과·이의 결과(d5 §5.24 상태 표).
 * 조치 결과의 [이의 내기]는 같은 소명 입력 칸을 다시 연다. 이의 인정이면 우선 구매 권리 카드(좌석·가격·기한).
 */
function PayerResult({
  appeal,
  v,
  target,
  reasonLabels,
  shows,
}: {
  appeal: Appeal;
  v: AppealView;
  target?: string;
  reasonLabels?: string[];
  /** fraudPartyShows(party): 결제자 칸(잠금 줄·이용 제한·이의·우선 구매)을 이 값으로 고른다(POL-046, ADR-0173 결정 4) */
  shows: ReturnType<typeof fraudPartyShows>;
}) {
  const lockMode = v.result === 'accepted' ? 'unlocked' : v.result === 'released' ? 'released' : 'locked';
  // 조치 뒤에는 잠긴 표 목록 대신 결과 카드의 취소한 표가 보인다
  const showLocked = shows.lockLine && (v.result === 'accepted' || v.result === 'rejected' || v.result === 'released');
  const action = appeal.actionResult;
  const lines = action
    ? actionResultLines({
        cancelledCount: action.cancelledSeatLabels.length,
        restrictedUntilText: action.restrictedUntilText,
        objectionDueText: action.objectionDueText ?? '',
      })
    : undefined;
  return (
    <>
      <AppealCaseCard
        headingId="ap-h"
        variant="fraud"
        title={FRAUD_APPEAL_TITLE}
        reasonCategories={reasonLabels}
        target={target}
        targetLabel="공연"
        submittedAtText={appeal.submittedAtText}
        lockedTickets={showLocked ? lockedTickets(appeal, lockMode) : undefined}
      />
      {v.result === 'accepted' || v.result === 'rejected' ? (
        <ResultCard
          heading="검토 결과"
          badge={v.result === 'accepted' ? <span className="badge badge-success">인정</span> : <span className="badge badge-danger">불인정</span>}
        >
          <p className="t-sm">{v.result === 'accepted' ? FRAUD_ACCEPTED_TEXT : FRAUD_REJECTED_TEXT}</p>
          {v.result === 'accepted' ? (
            <Link className={BTN_SECONDARY} href="/my/tickets">
              마이 티켓
            </Link>
          ) : (
            <Link className={BTN_SECONDARY} href={INQUIRY_HREF}>
              문의하기
            </Link>
          )}
        </ResultCard>
      ) : null}
      {v.result === 'released' ? (
        <>
          <div className="banner banner-info" role="status">
            <i className="ic ic-info" aria-hidden="true" />
            <div className="banner-body">{LOCK_RELEASED_TEXT}</div>
          </div>
          <Link className={BTN_SECONDARY} href="/my/tickets">
            마이 티켓
          </Link>
        </>
      ) : null}
      {v.result === 'actioned' && lines ? (
        <ResultCard heading="조치 결과" badge={<span className="badge badge-danger">{ACTIONED_LABEL}</span>}>
          {lines.cancelled ? (
            <>
              <p className="t-sm">{lines.cancelled}</p>
              <SeatList headingId="ap-cancel-h" heading={lines.cancelledHeading} items={action?.cancelledSeatLabels ?? []} />
            </>
          ) : null}
          {shows.restriction && lines.restriction ? <p className="t-sm fw-b">{lines.restriction}</p> : null}
          {shows.objection ? (
            <>
              <hr className="divider" />
              <p className="t-sm">{lines.objection}</p>
              <ObjectionToggle idPrefix="ob" title={FRAUD_APPEAL_TITLE} deadlineText={action?.objectionDueText ?? ''} hint={HINT} maxLength={APPEAL_MAX_LENGTH} />
            </>
          ) : null}
        </ResultCard>
      ) : null}
      {v.result === 'objection-accepted' || v.result === 'objection-rejected' ? (
        <ResultCard
          heading="이의 결과"
          badge={
            v.result === 'objection-accepted' ? (
              <span className="badge badge-success">{OBJECTION_RESULT_LABEL.ACCEPTED}</span>
            ) : (
              <span className="badge badge-danger">{OBJECTION_RESULT_LABEL.REJECTED}</span>
            )
          }
        >
          <div className="col" style={{ gap: 4 }}>
            <span className="eyebrow">이유</span>
            <p className="t-sm">{appeal.objectionNote}</p>
          </div>
          {v.result === 'objection-accepted' && shows.priorityPurchase && appeal.priorityPurchase ? (
            <section className="card-flat col px-4 py-3.5 md:p-4" style={{ gap: 10 }} aria-labelledby="ap-pp-h">
              <h3 id="ap-pp-h" className="t-sm fw-b">
                우선 구매
              </h3>
              <dl className="kv">
                <dt>좌석</dt>
                <dd>{appeal.priorityPurchase.seatText}</dd>
                <dt>가격</dt>
                <dd>{appeal.priorityPurchase.priceText}</dd>
                <dt>기한</dt>
                <dd>
                  <span className="nowrap">{appeal.priorityPurchase.deadlineText}</span>까지
                </dd>
              </dl>
              {/* 우선 구매는 입장 확정 요청에 권리 ID를 실어 산다(forensic-replay §6.7.5). 퍼블리싱은 공연 상세로 보낸다(추천 적용 2026-10-31) */}
              <Link className="btn btn-primary btn-lg btn-block" href={appeal.target ? `/events/${appeal.target.performanceId}` : '/my/tickets'}>
                우선 구매하기
              </Link>
            </section>
          ) : (
            <Link className={BTN_SECONDARY} href={v.result === 'objection-rejected' ? INQUIRY_HREF : '/my/tickets'}>
              {v.result === 'objection-rejected' ? '문의하기' : '마이 티켓'}
            </Link>
          )}
        </ResultCard>
      ) : null}
    </>
  );
}

/**
 * 받은 사람(party HOLDER)의 결과(d5 §5.24 '받은 사람의 변형'): 취소 대상에서 빠짐 · 취소됨(표마다 결과).
 * 이의 기한과 [이의 내기]는 두지 않고 고객 문의로 보낸다(이의는 결제자의 조치에 대한 것, ADR-0173 결정 4).
 */
function HolderResult({ appeal, v, target }: { appeal: Appeal; v: AppealView; target?: string }) {
  const held = appeal.heldSeatLabels ?? [];
  const cancelled = appeal.actionResult?.cancelledSeatLabels ?? [];
  const excluded = v.result === 'holder-excluded';
  return (
    <>
      <AppealCaseCard
        headingId="ap-h"
        variant="fraud-holder"
        title={HOLDER_TITLE}
        target={target}
        targetLabel="공연"
        submittedAtText={appeal.submittedAtText}
        lockedTickets={excluded ? heldTickets(appeal, false) : undefined}
      />
      <ResultCard
        heading="검토 결과"
        badge={excluded ? <span className="badge badge-success">취소하지 않음</span> : <span className="badge badge-danger">취소됨</span>}
      >
        {excluded ? (
          <>
            <p className="t-sm">{HOLDER_EXCLUDED_TEXT}</p>
            <Link className={BTN_SECONDARY} href="/my/tickets">
              마이 티켓
            </Link>
          </>
        ) : (
          <>
            <SeatList headingId="ap-held-h" label="내가 가진 표마다 결과" items={holderTicketResultLines(held, cancelled)} />
            <p className="t-sm">{HOLDER_CANCELLED_TEXT}</p>
            <p className="t-sm muted">{HOLDER_INQUIRY_TEXT}</p>
            <Link className={BTN_SECONDARY} href={INQUIRY_HREF}>
              문의하기
            </Link>
          </>
        )}
      </ResultCard>
    </>
  );
}
