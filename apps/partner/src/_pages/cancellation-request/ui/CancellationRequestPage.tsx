// SCR-044 회차 취소·연기 요청(/events/[id]/cancellation). 보드 SCR-044-m·t·d를 한 페이지 반응형으로 합쳤다(d5 §6.12, §3.9).
// 데스크톱: 12칸 폼(회차·종류·바뀐 일시 / 사유 / 증빙·귀책 의견) · 안내 글과 [요청 보내기] 한 줄 · 요청 상태 카드 · 상태 화면의 3칸 타일 /
// 태블릿: 2칸 폼, [요청 보내기]는 오른쪽 아래 · 타일 2칸(배상 합계는 한 줄 전체) / 휴대폰: 보기만(폼 자리에 안내 카드), 상태 카드는 세로로 쌓는다.
// 요청을 보내면 PEAKET 운영자가 귀책을 판정하고 다른 1명이 승인해야 확정된다. 요청은 파트너 관리자만 한다(실무자는 403).
import Link from 'next/link';
import { previewHref } from '@peaket/ds/Preview';
import { ProgressBar } from '@peaket/ds/ProgressBar';
import { Select } from '@peaket/ds/Select';
import { TextArea } from '@peaket/ds/TextArea';
import { TextField } from '@peaket/ds/TextField';
import { formatWon, requireProduction, type Production } from '@/entities/production';
import { routes } from '@/shared/config/routes';
import { CANCELLATION_STATES, type CancellationState } from '@/shared/config/states/scr044';
import { readPreview, type RouteProps } from '@/shared/lib/preview';
import { AdminOnly } from '@/features/admin-only';
import { BigScreenNotice } from '@/shared/ui/BigScreenNotice';
import { Modal } from '@/shared/ui/Modal';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { EventContextHeader } from '@/widgets/event-context';
import { FAULT_OPTIONS, decision, postponeRequest as req, refundProgress as rp, rejectedRequest } from '../model/request';

/** 요청을 파트너 관리자만 할 수 있다는 이유 글(d5 §6.12 '실무자 보기', 추천 적용 2026-10-28) */
const REQUEST_ADMIN_REASON = '회차 취소·연기 요청은 파트너 관리자만 할 수 있습니다';

const FORM_STATES: readonly CancellationState[] = ['요청 폼', '요청 확인', '이미 요청 중', '반려', '공연 종료 뒤', '실무자 보기'];

interface Ctx {
  state: CancellationState;
  isMember: boolean;
  /** 요청 대상 회차(그림 예는 둘째 회차 10/26(월) 17:00 KST) */
  roundLabel: string;
  rounds: readonly string[];
  /** 같은 화면의 다른 상태로 가는 주소 */
  href: (s: CancellationState) => string;
}

export default async function CancellationRequestPage({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  const pv = readPreview(await searchParams, CANCELLATION_STATES, '요청 폼');
  const production = requireProduction(id);
  const path = routes.eventTab(id, 'cancellation');
  const ctx: Ctx = {
    state: pv.state,
    isMember: pv.isMember,
    roundLabel: targetRound(production),
    rounds: production.rounds.length ? production.rounds.map((r) => r.startsAt) : [targetRound(production)],
    href: (s) => previewHref(path, s, pv.keep),
  };
  const showForm = FORM_STATES.includes(pv.state);

  return (
    <>
      <EventContextHeader production={production} current="cancellation" />

      <section className="col" style={{ gap: 16 }} aria-labelledby="cx-h">
        <div className="col" style={{ gap: 4 }}>
          <h2 className="t-lg" id="cx-h">
            회차 취소·연기 요청
          </h2>
          <p className="t-sm muted">요청을 받으면 PEAKET 운영자가 귀책을 판정하고, 판정한 사람 말고 1명이 더 승인해야 확정됩니다.</p>
        </div>
        <div className="banner banner-info">
          <i className="ic ic-scale" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title" style={{ marginBottom: 0 }}>
              취소 확정과 귀책 판정은 PEAKET이 합니다
            </span>
          </div>
        </div>

        {showForm ? (
          <>
            <RequestForm ctx={ctx} />
            <HistoryCard ctx={ctx} />
          </>
        ) : (
          <StatusCard ctx={ctx} settlementHref={routes.eventTab(id, 'settlement')} />
        )}
      </section>

      {/* 휴대폰은 요청을 보내지 않아(보기만) 확인 대화상자도 열지 않는다 */}
      <div className="max-md:hidden">
        <ConfirmDialog ctx={ctx} />
      </div>

      <PreviewStateSwitcher path={path} states={CANCELLATION_STATES} current={pv.state} keep={pv.keep} />
    </>
  );
}

function targetRound(p: Production): string {
  return (p.rounds[1] ?? p.rounds[0])?.startsAt ?? '10/26(월) 17:00 KST';
}

/* ---------- 요청 폼 ---------- */

function RequestForm({ ctx }: { ctx: Ctx }) {
  const ended = ctx.state === '공연 종료 뒤';
  // 공연 종료 뒤: 끝난 첫 회차를 고른 모습. 서버가 거부하고 회차 칸에 이유를 보인다
  const round = ended ? (ctx.rounds[0] ?? ctx.roundLabel) : ctx.roundLabel;
  return (
    <section className="card col gap-3 p-4 md:gap-5 md:p-6" aria-labelledby="fm-h">
      <h3 className="t-md fw-b" id="fm-h">
        요청 내용
      </h3>
      <BigScreenNotice title="요청 보내기와 다시 요청은 태블릿이나 데스크톱에서 합니다" />

      <div className="col max-md:hidden" style={{ gap: 20 }}>
        {ctx.state === '이미 요청 중' && (
          <div className="banner banner-danger" role="alert">
            <i className="ic ic-alert-circle" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">이미 요청한 회차입니다</span>
              {ctx.roundLabel} 회차는 {req.requestedAt}에 보낸 연기 요청이 판정을 기다리고 있습니다.{' '}
              <Link className="link" href={ctx.href('판정 대기')}>
                요청 상태 보기
              </Link>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-12 lg:gap-x-6">
          <Select
            id="cx-round"
            label="회차 (필수)"
            fieldClassName="lg:col-span-4"
            defaultValue={round}
            options={ctx.rounds.map((r) => ({ value: r, label: r }))}
            hint={ended ? undefined : '종료된 회차는 요청할 수 없습니다'}
            error={ended ? '종료된 회차는 요청할 수 없습니다' : undefined}
          />
          <fieldset className="col lg:col-span-4">
            <legend className="label" style={{ marginBottom: 6 }}>
              요청 종류 (필수)
            </legend>
            <div className="row" style={{ gap: 24, minHeight: 48 }}>
              <label className="check-row" htmlFor="k-cancel">
                <input className="rd" id="k-cancel" type="radio" name="cx-kind" value="cancel" />
                취소
              </label>
              <label className="check-row" htmlFor="k-post">
                <input className="rd" id="k-post" type="radio" name="cx-kind" value="postpone" defaultChecked />
                연기
              </label>
            </div>
          </fieldset>
          <TextField
            id="cx-when"
            label="바뀐 일시 (연기면 필수)"
            fieldClassName="col-start-2 lg:col-span-4 lg:col-start-auto"
            icon="calendar"
            defaultValue={req.newAtInput}
            hint="공연장 시각(KST)으로 적습니다"
          />
          <TextArea
            id="cx-reason"
            label="사유 (필수)"
            fieldClassName="col-span-full lg:col-span-12"
            style={{ minHeight: 96 }}
            defaultValue={req.reason}
          />
          <TextField
            id="cx-ev"
            label="증빙 참조"
            optional
            fieldClassName="lg:col-span-6"
            defaultValue={req.evidenceRef}
            hint="파일은 받지 않고 증빙을 찾을 수 있는 참조만 받습니다"
          />
          <Select
            id="cx-fault"
            label="귀책 의견"
            optional
            fieldClassName="lg:col-span-6"
            defaultValue={req.fault}
            options={FAULT_OPTIONS.map((f) => ({ value: f, label: f }))}
            hint="참고값입니다. 판정은 PEAKET 운영자가 합니다"
          />
        </div>

        <div className="divider" />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
          <p className="t-sm muted">
            연기가 확정되면 환급을 원하는 예매자에게 위약금 없이 전액 환급합니다. 신청 기한은 바뀐 공연의 시작 전까지입니다. 주최 측 귀책이나 공연 내용 변경으로
            판정되면 실제 결제 금액의 10%인 배상금을 PEAKET이 먼저 지급하고, 같은 파트너의 다른 회차 정산금에서 돌려받습니다.
          </p>
          <div className="flex-none self-end lg:self-auto">
            <AdminOnly
              isMember={ctx.isMember}
              id="cx-send"
              className="btn btn-primary btn-lg"
              opensModal="cx-confirm"
              reason={REQUEST_ADMIN_REASON}
            >
              <i className="ic ic-upload" aria-hidden="true" />
              요청 보내기
            </AdminOnly>
          </div>
        </div>
      </div>
    </section>
  );
}

/** 요청 상태(폼 화면 아래): 앞선 요청이 반려됐거나, 같은 회차가 판정을 기다린다 */
function HistoryCard({ ctx }: { ctx: Ctx }) {
  const title = `${ctx.roundLabel} 회차 · 연기 요청`;
  return (
    <section className="card col gap-3 p-4 md:p-6" aria-labelledby="hs-h">
      <h3 className="t-md fw-b" id="hs-h">
        요청 상태
      </h3>
      {ctx.state === '이미 요청 중' ? (
        <div className="card-flat pad col" style={{ gap: 6 }}>
          <div className="row between wrap" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="badge badge-primary">판정 대기</span>
              <span className="t-sm fw-b">{title}</span>
            </div>
            <span className="t-xs muted">
              요청 {req.requestedAt} · 판정 기한 {req.judgeDueAt}
            </span>
          </div>
          <Link className="link-more" href={ctx.href('판정 대기')}>
            요청 상태 자세히 보기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <div className="card-flat pad col" style={{ gap: 8 }}>
          <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
            <div className="row wrap" style={{ gap: 8 }}>
              <span className="badge badge-danger">반려</span>
              <span className="t-sm fw-b">{title}</span>
            </div>
            <span className="t-xs muted">
              요청 {rejectedRequest.requestedAt} · 반려 {rejectedRequest.rejectedAt}
            </span>
          </div>
          <p className="t-sm">반려 사유: {rejectedRequest.reason}</p>
          {/* 휴대폰은 다시 요청하지 않는다(위 안내 카드). [다시 요청]은 고친 폼으로 같은 확인 대화상자를 연다(추천안) */}
          <div className="max-md:hidden" style={{ alignSelf: 'flex-start' }}>
            <AdminOnly
              isMember={ctx.isMember}
              id="cx-retry"
              className="btn btn-outline btn-sm"
              opensModal="cx-confirm"
              reason={REQUEST_ADMIN_REASON}
            >
              <i className="ic ic-redo" aria-hidden="true" />
              <span className="sr-only">{ctx.roundLabel} 회차 연기 </span>
              다시 요청
            </AdminOnly>
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------- 요청 확인(CMP-020 DangerConfirm 모양) ---------- */

function ConfirmDialog({ ctx }: { ctx: Ctx }) {
  return (
    <Modal id="cx-confirm" labelledBy="cf-t" describedBy="cf-d" maxWidth={460} defaultOpen={ctx.state === '요청 확인'}>
      <span className="state-icon is-warning" style={{ width: 48, height: 48 }}>
        <i className="ic ic-alert" aria-hidden="true" />
      </span>
      <h2 className="dialog-title" id="cf-t">
        회차 연기를 요청합니다
      </h2>
      <p className="t-md" id="cf-d">
        요청을 보냅니다. 확정과 귀책 판정은 PEAKET이 합니다
      </p>
      <dl className="kv card-flat pad">
        <dt>회차</dt>
        <dd>{ctx.roundLabel}</dd>
        <dt>바뀐 일시</dt>
        <dd>{req.newAt}</dd>
        <dt>귀책 의견(참고값)</dt>
        <dd>{req.fault}</dd>
      </dl>
      <p className="t-sm muted">판정은 요청을 받은 뒤 1영업일 안에 합니다. 확정되면 예매자 전원에게 환불 일정이 안내됩니다.</p>
      <div className="dialog-actions">
        <button className="btn btn-ghost" type="button" data-modal-close>
          돌아가서 고치기
        </button>
        {/* 퍼블리싱: 보내면 '판정 대기' 상태로 간다 */}
        <Link className="btn btn-danger" href={ctx.href('판정 대기')}>
          연기 요청 보내기
        </Link>
      </div>
    </Modal>
  );
}

/* ---------- 요청 상태(판정 대기 · 확정·환불 진행) ---------- */

function StatusCard({ ctx, settlementHref }: { ctx: Ctx; settlementHref: string }) {
  const running = ctx.state === '확정·환불 진행';
  return (
    <section className="card col gap-4 p-4 md:gap-[18px] md:p-6" aria-labelledby="rq-h">
      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start md:justify-between">
        <div className="col" style={{ gap: 2 }}>
          <h3 className="t-md fw-b" id="rq-h">
            {ctx.roundLabel} 회차 · 연기 요청
          </h3>
          <span className="t-xs muted">
            요청 {req.requestedAt} · {req.requestedBy}
          </span>
        </div>
        <div className="input-group input-group-sm md:w-[220px]">
          <select aria-label="회차" defaultValue={ctx.roundLabel}>
            {ctx.rounds.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <i className="ic ic-chevron-down" aria-hidden="true" />
        </div>
      </div>

      {running ? <Running settlementHref={settlementHref} /> : <Judging />}

      <div className="divider" />
      <dl className="t-sm grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 md:grid-cols-[120px_minmax(0,1fr)] md:gap-x-4">
        <dt className="muted">요청 종류</dt>
        <dd>
          {req.kind} · 바뀐 일시 {req.newAt}
        </dd>
        <dt className="muted">사유</dt>
        <dd>{req.reason}</dd>
        <dt className="muted">증빙 참조</dt>
        <dd>{req.evidenceRef}</dd>
        <dt className="muted">귀책 의견</dt>
        <dd>{req.fault}(참고값)</dd>
      </dl>
    </section>
  );
}

function Step({ dot, title, meta }: { dot?: 'ok' | 'info'; title: string; meta: string }) {
  return (
    <li className="tl-item">
      <span className={dot ? `tl-dot ${dot}` : 'tl-dot'} aria-hidden="true" />
      <div className="col" style={{ gap: 2 }}>
        <span className="t-sm fw-b">{title}</span>
        <span className="t-xs muted">{meta}</span>
      </div>
    </li>
  );
}

function Judging() {
  return (
    <>
      {/* 데스크톱·태블릿: 배지 두 개 한 줄 / 휴대폰: 배지 아래 기한 한 줄 */}
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap" role="status">
        <span className="badge badge-lg badge-primary self-start">판정 대기</span>
        <span className="badge badge-lg max-md:hidden">
          <i className="ic ic-clock" aria-hidden="true" />
          판정 기한 {req.judgeDueAt} · 1영업일
        </span>
        <p className="row t-sm md:hidden" style={{ gap: 6, alignItems: 'flex-start' }}>
          <i className="ic ic-clock ic-16 muted" aria-hidden="true" style={{ marginTop: 2 }} />
          <span>판정 기한 {req.judgeDueAt} · 1영업일</span>
        </p>
      </div>
      <ol className="timeline" aria-label="요청 진행 단계">
        <Step dot="ok" title="요청 접수 · 완료" meta={req.requestedAt} />
        <Step
          dot="info"
          title="귀책 판정 · 진행 중"
          meta="PEAKET 운영자가 주최 측 귀책, 불가항력, 공연 내용 변경 중 하나로 판정합니다. 요청을 받은 뒤 1영업일 안에 합니다."
        />
        <Step title="확정 · 대기" meta="판정한 사람 말고 1명이 더 승인해야 확정됩니다" />
        <Step title="예매자 안내와 환불 · 대기" meta="확정되면 예매자 전원에게 환불 일정이 안내됩니다" />
      </ol>
    </>
  );
}

function Running({ settlementHref }: { settlementHref: string }) {
  return (
    <>
      <div className="row wrap" style={{ gap: 8 }} role="status">
        <span className="badge badge-lg badge-success">
          <i className="ic ic-check" aria-hidden="true" />
          확정
        </span>
        <span className="badge badge-lg badge-primary">환불 진행 중 · {rp.percent}%</span>
      </div>
      <ol className="timeline" aria-label="요청 진행 단계">
        <Step dot="ok" title="요청 접수 · 완료" meta={req.requestedAt} />
        <Step
          dot="ok"
          title={`판정 · ${decision.verdict}`}
          meta={`${decision.judgedAt} · 판정 사유: ${decision.verdictReason} · 파트너 의견 '${req.fault}'은 참고값으로 보았습니다`}
        />
        <Step dot="ok" title="확정 · 완료" meta={`${decision.confirmedAt} · ${decision.approvers}명 승인 · 예매자 전원에게 환불 일정을 안내했습니다`} />
        <Step dot="info" title="예매자 환불 · 진행 중" meta={`연기 환급 신청 기한 ${rp.deadline}(바뀐 공연 시작 전까지)`} />
      </ol>
      <div className="card-flat pad col" style={{ gap: 8 }}>
        <div className="row between wrap" style={{ gap: '4px 8px' }}>
          <span className="t-sm fw-b">환불 진행률</span>
          <span className="t-sm num">
            신청 {rp.requested}건 중 {rp.done}건 완료 · {rp.percent}%
          </span>
        </div>
        <ProgressBar value={rp.percent} label="환불 진행률" size="lg" />
        <span className="t-xs muted">실패한 건은 PEAKET CS가 따로 처리합니다. 오류가 많아지면 스스로 멈추고, 멈춘 사유를 여기에 보입니다.</span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div className="stat">
          <span className="stat-label">팬 환급 신청</span>
          <span className="stat-value">{rp.requested}건</span>
          <span className="stat-meta">신청 기한 {rp.deadline}</span>
        </div>
        <div className="stat">
          <span className="stat-label">배상 대상</span>
          <span className="stat-value">{rp.compensationTargets}명</span>
          <span className="stat-meta">실제 결제 금액의 10%</span>
        </div>
        <div className="stat col-span-full lg:col-span-1">
          <span className="stat-label">배상 합계</span>
          <span className="stat-value">{formatWon(rp.compensationTotal)}</span>
          <span className="stat-meta">대상 수와 합계만 보입니다</span>
        </div>
      </div>
      <p className="t-xs muted">
        배상은 PEAKET이 먼저 지급하고 같은 파트너의 다른 회차 정산금 상계, 계약 보증, 청구 순서로 돌려받습니다.{' '}
        <Link className="link" href={settlementHref}>
          정산서 보기
        </Link>
      </p>
    </>
  );
}
