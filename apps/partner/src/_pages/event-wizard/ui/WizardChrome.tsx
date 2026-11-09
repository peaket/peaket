// 위저드의 틀: 새 공연 머리, 공연 문맥 배지·배너, 단계 표시(CMP-013 Stepper, 키트 .stepper), 하단 고정 막대.
// 데스크톱 lg는 단계 이름을 모두 보이고, 태블릿은 지금 단계 이름만 보인다(나머지는 sr-only, 보드 SCR-021-t). 휴대폰은 읽기 전용 요약이라 숨긴다.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SALE_STATUS_BADGE, SALE_STATUS_LABEL, type Production } from '@/entities/production';
import { PARTNER_SUPPORT_HREF, routes } from '@/shared/config/routes';
import { AdminOnly } from '@/features/admin-only';
import { ADMIN_ONLY_REASON } from '@/entities/partner-user';
import { defaultReviewBadge } from '@/widgets/event-context';
import { edit, summary } from '../model/fixtures';
import type { ReviewSituation, WizardView } from '../model/view';

export { WizardStepper } from './parts/WizardStepper';

/* ---------- 머리 ---------- */

export function NewHeader({ keepQuery }: { keepQuery?: string }) {
  const home = keepQuery ? `${routes.events()}?${keepQuery}` : routes.events();
  return (
    <div className="col" style={{ gap: 8 }}>
      <nav className="breadcrumb max-lg:hidden" aria-label="위치">
        <Link href={home}>공연 관리</Link>
        <i className="ic ic-chevron-right" aria-hidden="true" />
        <span>새 공연 등록</span>
      </nav>
      <Link className="link-more lg:hidden" href={home} style={{ alignSelf: 'flex-start' }}>
        <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
        공연 관리
      </Link>
      <div className="page-head">
        <h1>새 공연 등록</h1>
        <div className="row">
          <span className="badge">초안</span>
        </div>
      </div>
    </div>
  );
}

/** 공연 문맥 머리의 배지(보드 SCR-021-d·m) */
export function reviewBadges(p: Production, review: ReviewSituation): ReactNode {
  const sale = p.saleStatus !== 'NONE' && p.saleStatus !== 'PRIVATE' ? <span className={SALE_STATUS_BADGE[p.saleStatus]}>{SALE_STATUS_LABEL[p.saleStatus]}</span> : null;
  switch (review) {
    case 'approved':
      return (
        <>
          <span className="badge badge-success">판매 승인됨</span>
          {sale}
        </>
      );
    case 'reReq':
      return (
        <>
          <span className="badge badge-warning">재승인 대기</span>
          {sale}
        </>
      );
    case 'reRej':
      return (
        <>
          <span className="badge badge-danger">변경 반려</span>
          {sale}
        </>
      );
    case 'suspended':
      return <span className="badge badge-danger">판매 중지</span>;
    case 'wait':
      return (
        <>
          <span className="badge badge-warning">재승인 대기</span>
          <span className="badge badge-warning">오픈 예약 멈춤</span>
        </>
      );
    case 'rejected':
      return (
        <>
          <span className="badge badge-danger">반려</span>
          <span className="badge badge-outline">비공개</span>
        </>
      );
    default:
      return defaultReviewBadge(p);
  }
}

/** 탭 아래 배너(태블릿·데스크톱. 휴대폰은 요약 카드 안에 같은 글이 있다) */
export function EventBanners({ review, isMember }: { review: ReviewSituation; isMember: boolean }) {
  const cancel = (id: string, note: string) =>
    isMember ? (
      <AdminOnly isMember id={id} className="btn btn-outline btn-sm">
        변경 취소
      </AdminOnly>
    ) : (
      <span className="col" style={{ gap: 4, alignItems: 'flex-end' }}>
        <button className="btn btn-outline btn-sm" type="button" aria-describedby={`${id}-h`}>
          변경 취소
        </button>
        <span className="t-xs muted" id={`${id}-h`}>
          {note}
        </span>
      </span>
    );
  switch (review) {
    case 'approved':
      return (
        <div className="banner banner-warning max-md:hidden">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">승인 뒤 가격·회차·좌석 등급·좌석맵·판매 정책을 바꾸면 다시 판매 승인을 받고, 오픈 전이면 오픈 예약이 멈춥니다</div>
        </div>
      );
    case 'reReq':
      return (
        <div className="banner banner-info max-md:hidden" role="status" style={{ flexWrap: 'wrap' }}>
          <i className="ic ic-clock" aria-hidden="true" />
          <div className="banner-body" style={{ flex: '1 1 400px' }}>
            <span className="banner-title">재승인 대기 · 바꾼 항목: {edit.changed}</span>
            공개 중인 내용과 판매는 승인될 때까지 그대로입니다. 판매 승인 요청 {edit.requestedAt}
          </div>
          <div style={{ marginLeft: 'auto', flex: 'none' }}>{cancel('rv-cancel', '파트너 관리자 · 마지막 승인 내용으로 돌아갑니다')}</div>
        </div>
      );
    case 'reRej':
      return (
        <div className="banner banner-danger max-md:hidden" role="alert" style={{ flexWrap: 'wrap' }}>
          <i className="ic ic-x-circle" aria-hidden="true" />
          <div className="banner-body" style={{ flex: '1 1 400px' }}>
            <span className="banner-title">변경 반려 · 바꾼 항목: {edit.changed}</span>
            사유: [반려 사유]
            <br />
            공개 중인 내용과 판매는 승인될 때까지 그대로입니다
          </div>
          <div className="col" style={{ gap: 6, alignItems: 'flex-end', marginLeft: 'auto', flex: 'none' }}>
            {isMember ? (
              <>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="rj-role">
                    변경 취소
                  </button>
                  <button className="btn btn-primary btn-sm" type="button" aria-disabled="true" aria-describedby="rj-role">
                    고쳐서 다시 요청
                  </button>
                </div>
                <span className="row t-xs tx-warning" id="rj-role" style={{ gap: 4 }}>
                  <i className="ic ic-lock ic-14" aria-hidden="true" />
                  {ADMIN_ONLY_REASON}
                </span>
              </>
            ) : (
              <>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-outline btn-sm" type="button" aria-describedby="rj-cancel-h">
                    변경 취소
                  </button>
                  <button className="btn btn-primary btn-sm" type="button">
                    고쳐서 다시 요청
                  </button>
                </div>
                <span className="t-xs muted" id="rj-cancel-h">
                  파트너 관리자 · 변경 취소는 마지막 승인 내용으로 돌아갑니다
                </span>
              </>
            )}
          </div>
        </div>
      );
    case 'suspended':
      return (
        <div className="banner banner-danger max-md:hidden" role="status" style={{ flexWrap: 'wrap' }}>
          <i className="ic ic-ban" aria-hidden="true" />
          <div className="banner-body" style={{ flex: '1 1 400px' }}>
            <span className="banner-title">판매 중지 · 사유: {edit.suspendReason}</span>
            공개와 새 판매가 멈췄습니다. 이미 판매한 티켓은 유효하고 정산 지급은 보류됩니다. 문의는 파트너 지원으로 해 주세요
          </div>
          <a className="link-more" href={PARTNER_SUPPORT_HREF} style={{ flex: 'none' }}>
            파트너 지원 문의
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </a>
        </div>
      );
    // '승인 대기'·'반려'는 휴대폰 보드에만 있어 그 글을 태블릿·데스크톱 배너로 옮겼다(추천안)
    case 'wait':
      return (
        <div className="banner banner-warning max-md:hidden" role="status">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">다시 판매 승인을 받는 중입니다 · 오픈 예약이 멈췄습니다</span>
            승인 뒤 가격과 회차를 바꿔 PEAKET 운영자가 다시 확인합니다. 다시 승인될 때까지 오픈 예약이 멈춥니다. 바뀐 항목: 가격, 회차
          </div>
        </div>
      );
    case 'rejected':
      return (
        <div className="banner banner-danger max-md:hidden" role="status">
          <i className="ic ic-x-circle" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">판매 승인이 반려되었습니다</span>
            사유: {summary.rejectReason} · {summary.rejectedAt} 반려. 고쳐서 다시 요청하면 PEAKET 운영자가 다시 확인합니다.
          </div>
        </div>
      );
    default:
      return null;
  }
}

/* ---------- 하단 고정 막대 ---------- */

const BAR = 'card row sticky bottom-3 z-10 max-md:hidden max-lg:bottom-0 max-lg:rounded-none';

export function ActionBar({
  view,
  isMember,
  prevHref,
  nextHref,
}: {
  view: WizardView;
  isMember: boolean;
  prevHref?: string;
  nextHref?: string;
}) {
  const style = { padding: '12px 16px', gap: 8, boxShadow: 'var(--shadow-sm)' } as const;
  const prev = prevHref ? (
    <Link className="btn btn-outline" href={prevHref}>
      <i className="ic ic-arrow-left" aria-hidden="true" />
      이전
    </Link>
  ) : (
    <button className="btn btn-outline" type="button">
      <i className="ic ic-arrow-left" aria-hidden="true" />
      이전
    </button>
  );
  const next = nextHref ? (
    <Link className="btn btn-primary" href={nextHref}>
      다음
      <i className="ic ic-arrow-right" aria-hidden="true" />
    </Link>
  ) : (
    <button className="btn btn-primary" type="button">
      다음
      <i className="ic ic-arrow-right" aria-hidden="true" />
    </button>
  );

  // 고치는 화면
  if (view.body.kind !== 'step') {
    if (view.review === 'suspended')
      return (
        <div className={BAR} style={style}>
          {prev}
          <p className="row t-sm fw-m grow" id="sus-lock" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <i className="ic ic-lock ic-16" aria-hidden="true" />
            판매 중지 중에는 등록 정보를 바꿀 수 없습니다
          </p>
          <button className="btn btn-secondary" type="button" aria-disabled="true" aria-describedby="sus-lock">
            변경 저장
          </button>
          {next}
        </div>
      );
    return (
      <div className={BAR} style={style}>
        {prev}
        <span className="grow" />
        <button className="btn btn-secondary" type="button">
          변경 저장
        </button>
        {next}
      </div>
    );
  }

  const step = view.body.step;
  if (step === 1)
    return (
      <div className={BAR} style={style}>
        <button className="btn btn-outline" type="button" disabled aria-describedby="a1-why">
          <i className="ic ic-arrow-left" aria-hidden="true" />
          이전
        </button>
        <span className="sr-only" id="a1-why">
          1단계라 이전 단계가 없습니다
        </span>
        <span className="t-sm muted grow" role="status" style={{ textAlign: 'right' }}>
          자동 임시저장됨 14:31:40 KST
        </span>
        <button className="btn btn-secondary" type="button">
          임시저장
        </button>
        {next}
      </div>
    );
  if (view.saving)
    return (
      <div className={BAR} style={style}>
        {prev}
        <span className="t-sm muted grow" role="status" id="a4-st" style={{ textAlign: 'right' }}>
          입력이 바뀌어 자동 임시저장 중입니다
        </span>
        <button className="btn btn-secondary" type="button" aria-busy="true" aria-disabled="true" aria-describedby="a4-st">
          <span className="spinner" aria-hidden="true" />
          임시저장 중
        </button>
        {next}
      </div>
    );
  if (step === 5) {
    const label = view.review === 'rejected' ? '고쳐서 다시 요청' : '판매 승인 요청';
    return (
      <div className={BAR} style={{ ...style, alignItems: isMember ? 'flex-start' : 'center' }}>
        {prev}
        <span className="t-sm muted grow" role="status" style={{ textAlign: 'right', alignSelf: 'center' }}>
          자동 임시저장됨 14:36:12 KST
        </span>
        <button className="btn btn-secondary" type="button">
          임시저장
        </button>
        <AdminOnly isMember={isMember} id="a5-req" className="btn btn-primary">
          {label}
        </AdminOnly>
      </div>
    );
  }
  return (
    <div className={BAR} style={style}>
      {prev}
      <span className="t-sm muted grow" role="status" style={{ textAlign: 'right' }}>
        자동 임시저장됨 {step === 2 ? '14:32:05' : '14:33:10'} KST
      </span>
      <button className="btn btn-secondary" type="button">
        임시저장
      </button>
      {next}
    </div>
  );
}
