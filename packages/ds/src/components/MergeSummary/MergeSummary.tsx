'use client';
// CMP-056 MergeSummary(계정 합치기 요약). 정본: d2 CMP-056, d5 §5.22, d3 SCR-040, 캔버스 보드 SCR-040-m·t·d.
// 보드 마크업: <section class="card col" aria-labelledby> 머리 줄(h2.t-lg '계정 합치기' + ready는 .timer · blocked는 badge-danger · merging은 badge-primary)
//   ready: p.t-md.fw-b 질문 → dl.kv(남는 계정·합쳐지는 계정) → '옮겨 오는 것'(h3 + ul 두 칸 그리드 + 주문 안내 p.t-xs)
//          → '대표 계정 것을 그대로 쓰는 것' → [카카오로 다시 로그인하고 계속] [합치지 않고 닫기]
//          휴대폰은 위에서 아래로 쌓고 사이에 .divider, 태블릿은 dl | 옮겨 오는 것 두 칸, 데스크톱은 (dl+그대로 쓰는 것) | .card-flat(옮겨 오는 것).
//   blocked: 질문 → .banner.banner-danger role=alert(막는 사유) → '합치기 전에 확인하는 다섯 가지'(줄마다 확인·막음 아이콘, 줄이 없으면 빼고 안내만) → [합치지 않고 닫기].
//   merging: role=status 문장 + .progress(단계 수) → ol.timeline(완료·진행 중·대기) → 닫아도 계속된다는 안내.
//   expired: .banner.banner-warning role=alert → [닫기]. loading: 요약 스켈레톤(aria-busy).
// - 옮겨지는 자산은 ul, 막는 사유는 role="alert", 최종 확인 버튼은 요약 아래(d2 CMP-056). 문구는 부르는 화면이 넘기고, 고정 이름은 labels로 바꾼다.
import { useId, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Icon } from "../../icons";
import { Countdown } from "../Countdown/Countdown";

export type MergeSummaryStatus = "loading" | "ready" | "blocked" | "merging" | "expired";
export type MergeStepState = "done" | "active" | "waiting";

export interface MergeSummaryLabels {
  title: string;
  survivor: string;
  absorbed: string;
  moves: string;
  keeps: string;
  timer: string;
  blockedBadge: string;
  mergingBadge: string;
  checks: string;
  dismiss: string;
  close: string;
  loading: string;
  stepDone: string;
  stepActive: string;
  stepWaiting: string;
  steps: string;
}

export const MERGE_SUMMARY_LABELS: MergeSummaryLabels = {
  title: "계정 합치기",
  survivor: "남는 계정(대표)",
  absorbed: "합쳐지는 계정",
  moves: "옮겨 오는 것",
  keeps: "대표 계정 것을 그대로 쓰는 것",
  timer: "합치기 제안 남은 시간",
  blockedBadge: "합칠 수 없음",
  mergingBadge: "처리 중",
  checks: "합치기 전에 확인하는 다섯 가지",
  dismiss: "합치지 않고 닫기",
  close: "닫기",
  loading: "합칠 내용을 계산하는 중",
  stepDone: "완료",
  stepActive: "진행 중",
  stepWaiting: "대기",
  steps: "처리 단계",
};

export interface MergeCheck {
  title: ReactNode;
  /** '해당 없음' 또는 막는 사유 한 줄 */
  detail: ReactNode;
  /** 막는 사유면 참(x-circle, 위험 색) */
  blocked: boolean;
}

export interface MergeStep {
  label: ReactNode;
  state: MergeStepState;
}

export interface MergeSummaryProps {
  status: MergeSummaryStatus;
  /** ready 질문(되돌릴 수 없다는 말을 함께) */
  question?: ReactNode;
  /** blocked 머리 문장 */
  blockedQuestion?: ReactNode;
  survivor: ReactNode;
  absorbed: ReactNode;
  moves: readonly { label: ReactNode; value: ReactNode }[];
  /** 옮겨 오는 것 아래 작은 글(흡수 계정 주문 안내) */
  movesNote?: ReactNode;
  /** 대표 계정 것을 그대로 쓰는 것(예: '닉네임 · 동의 내역') */
  keeps: ReactNode;
  /** 제안 남은 초(ready 머리의 .timer, 목업·미리보기: 멈춘 값) */
  remaining?: number;
  /** 제안이 끝나는 시각(epoch ms). 주면 시계가 흐른다(실제 흐름, BOT-043). remaining보다 먼저다 */
  deadline?: number;
  /** blocked: 막는 사유(role=alert) */
  blockedReason?: ReactNode;
  /** blocked: 다섯 범주 */
  checks?: readonly MergeCheck[];
  /** merging */
  merging?: { message: ReactNode; progressLabel: string; steps: readonly MergeStep[]; note?: ReactNode };
  /** expired 안내 글 */
  expiredText?: ReactNode;
  /** 대표 계정 제공자로 다시 로그인하는 버튼(ready). provider가 없으면(고를 수단이 여럿) 기본 버튼 모양이다 */
  continueAction?: { label: string; provider?: "kakao" | "naver" | "google"; onClick?: () => void };
  onDismiss?: () => void;
  labels?: Partial<MergeSummaryLabels>;
  className?: string;
}

/** md 이상에서 btn-lg 크기로 키운다(휴대폰 보드는 보통 크기) */
const LG_FROM_MD = "md:min-h-[52px] md:px-5 md:text-base md:leading-[22px] md:rounded-(--r-lg)";

export function MergeSummary({
  status,
  question,
  blockedQuestion,
  survivor,
  absorbed,
  moves,
  movesNote,
  keeps,
  remaining,
  deadline,
  blockedReason,
  checks = [],
  merging,
  expiredText,
  continueAction,
  onDismiss,
  labels: labelsProp,
  className,
}: MergeSummaryProps) {
  const base = useId();
  const headId = `${base}-h`;
  const movesId = `${base}-mv`;
  const checksId = `${base}-bk`;
  const L = { ...MERGE_SUMMARY_LABELS, ...labelsProp };

  const head = (
    <div className="row between" style={{ gap: 8 }}>
      <h2 className="t-lg" id={headId}>
        {L.title}
      </h2>
      {status === "ready" && deadline !== undefined ? (
        <Countdown deadline={deadline} label={L.timer} announce="none" warnBelow={0} />
      ) : status === "ready" && remaining !== undefined ? (
        <Countdown remaining={remaining} running={false} label={L.timer} announce="none" warnBelow={0} />
      ) : null}
      {status === "blocked" ? <span className="badge badge-danger">{L.blockedBadge}</span> : null}
      {status === "merging" ? <span className="badge badge-primary">{L.mergingBadge}</span> : null}
    </div>
  );

  return (
    <section className={cx("card col gap-4 px-4 py-5 md:p-6 lg:gap-[18px]", className)} aria-labelledby={headId} aria-busy={status === "loading" ? true : undefined}>
      {head}

      {status === "loading" ? (
        <div className="col" style={{ gap: 12 }}>
          <span className="sr-only">{L.loading}</span>
          <span className="skel" style={{ height: 22, width: "88%" }} />
          <span className="skel" style={{ height: 44 }} />
          <span className="skel" style={{ height: 72 }} />
          <span className="skel" style={{ height: 52 }} />
        </div>
      ) : null}

      {status === "expired" ? (
        <>
          <div className="banner banner-warning" role="alert">
            <Icon name="clock" />
            <div className="banner-body">{expiredText}</div>
          </div>
          <button className="btn btn-outline btn-block" type="button" onClick={onDismiss}>
            {L.close}
          </button>
        </>
      ) : null}

      {status === "ready" ? (
        <>
          <p className="t-md fw-b">{question}</p>
          <div className="flex flex-col gap-4 md:grid md:grid-cols-2 md:items-start md:gap-x-6 md:gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-x-8 lg:gap-y-[18px]">
            <dl className="kv md:col-start-1 md:row-start-1">
              <dt>{L.survivor}</dt>
              <dd>{survivor}</dd>
              <dt>{L.absorbed}</dt>
              <dd>{absorbed}</dd>
            </dl>
            <div className="divider md:hidden" />
            <div className="col gap-2.5 md:col-start-2 md:row-start-1 lg:row-span-2 lg:rounded-(--r-xl) lg:bg-(--surface-muted) lg:p-4">
              <h3 className="t-sm fw-b" id={movesId}>
                {L.moves}
              </h3>
              <ul className="t-sm grid grid-cols-2 gap-x-5 gap-y-2 lg:gap-x-6" aria-labelledby={movesId}>
                {moves.map((m, i) => (
                  <li key={i} className="row between">
                    <span className="muted">{m.label}</span>
                    <span className="num fw-b">{m.value}</span>
                  </li>
                ))}
              </ul>
              {movesNote ? <p className="t-xs muted">{movesNote}</p> : null}
            </div>
            <div className="divider md:hidden" />
            <div className="col gap-1.5 md:col-span-2 md:row-start-2 lg:col-span-1 lg:col-start-1">
              <h3 className="t-sm fw-b">{L.keeps}</h3>
              <p className="t-sm">{keeps}</p>
            </div>
          </div>
          <div className="divider hidden md:block" />
          <div className="flex flex-col gap-2 md:flex-row lg:flex-row-reverse lg:justify-start">
            {continueAction ? (
              <button className={`btn btn-${continueAction.provider ?? "primary"} btn-lg btn-block md:w-auto md:grow lg:grow-0`} type="button" onClick={continueAction.onClick}>
                {continueAction.provider ? <i className={`prov prov-${continueAction.provider}`} aria-hidden="true" /> : null}
                {continueAction.label}
              </button>
            ) : null}
            <button className={cx("btn btn-ghost btn-block md:w-auto", LG_FROM_MD)} type="button" onClick={onDismiss}>
              {L.dismiss}
            </button>
          </div>
        </>
      ) : null}

      {status === "blocked" ? (
        <>
          <p className="t-md fw-b">{blockedQuestion}</p>
          {blockedReason ? (
            <div className="banner banner-danger" role="alert">
              <Icon name="alert-circle" />
              <div className="banner-body">{blockedReason}</div>
            </div>
          ) : null}
          {checks.length > 0 ? (
            <div className="col" style={{ gap: 12 }}>
              <h3 className="t-sm fw-b" id={checksId}>
                {L.checks}
              </h3>
              <ul className="col" aria-labelledby={checksId} style={{ gap: 12 }}>
                {checks.map((c, i) => (
                  <li key={i} className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                    <Icon name={c.blocked ? "x-circle" : "check-circle"} className={c.blocked ? "tx-danger" : "tx-success"} />
                    <span className="col" style={{ gap: 2 }}>
                      <span className="t-sm fw-b">{c.title}</span>
                      <span className={cx("t-xs", c.blocked ? "tx-danger" : "muted")}>{c.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <button className="btn btn-outline btn-block" type="button" onClick={onDismiss}>
            {L.dismiss}
          </button>
        </>
      ) : null}

      {status === "merging" && merging ? <MergingProgress merging={merging} labels={L} /> : null}
    </section>
  );
}

function MergingProgress({ merging, labels: L }: { merging: NonNullable<MergeSummaryProps["merging"]>; labels: MergeSummaryLabels }) {
  const total = merging.steps.length;
  const done = merging.steps.filter((s) => s.state === "done").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const badge = { done: ["badge badge-success", L.stepDone], active: ["badge badge-primary", L.stepActive], waiting: ["badge", L.stepWaiting] } as const;
  const dot = { done: "tl-dot ok", active: "tl-dot info", waiting: "tl-dot" } as const;
  return (
    <>
      <div className="col" role="status" style={{ gap: 12 }}>
        <p className="t-md fw-b">{merging.message}</p>
        <div
          className="progress"
          role="progressbar"
          aria-label={merging.progressLabel}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-valuetext={`${total}단계 중 ${done}단계 완료`}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
      <ol className="timeline" aria-label={L.steps}>
        {merging.steps.map((s, i) => (
          <li key={i} className="tl-item">
            <span className={dot[s.state]} aria-hidden="true" />
            <div className="row between" style={{ gap: 8 }}>
              <span className={cx("t-sm", s.state === "active" && "fw-b", s.state === "waiting" && "muted")}>{s.label}</span>
              <span className={badge[s.state][0]}>{badge[s.state][1]}</span>
            </div>
          </li>
        ))}
      </ol>
      {merging.note ? <p className="t-sm muted">{merging.note}</p> : null}
    </>
  );
}
