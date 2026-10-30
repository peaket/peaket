// 휴대폰(md 미만) 읽기 전용 요약(보드 SCR-021-m, d5 §3.9: 단계별 입력 내용 보기, 판매 승인 상태와 반려 사유).
// 입력·임시저장·판매 승인 요청·변경 취소는 태블릿 이상에서 하므로 그 자리에 안내 카드를 둔다.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { stellaOrg } from '@/entities/partner-org';
import { formatWon } from '@/entities/production';
import { PARTNER_SUPPORT_HREF, routes } from '@/shared/config/routes';
import { draft, media, summary, tiers, WIZARD_STEPS } from '../model/fixtures';
import type { ReviewSituation, WizardStep } from '../model/view';
import { CopyLinkBanner } from './parts/CopyLinkBanner';

function Kv({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="kv" style={{ gridTemplateColumns: '104px minmax(0,1fr)' }}>
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function StepCard({ n, done, badge, children }: { n: WizardStep; done: boolean; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="card col" id={`m-s${n}`} aria-labelledby={`m-h-s${n}`}>
      <div className="row" style={{ gap: 12, padding: '14px 16px' }}>
        <span className={done ? 'step is-done' : 'step'} aria-hidden="true">
          <span className="step-num">{done ? <i className="ic ic-check" aria-hidden="true" /> : n}</span>
        </span>
        <div className="col grow" style={{ gap: 2 }}>
          <span className="eyebrow">
            {n}단계 · {done ? '입력 완료' : '입력 필요'}
          </span>
          <h3 className="t-md fw-b" id={`m-h-s${n}`}>
            {WIZARD_STEPS[n - 1]}
          </h3>
        </div>
        {badge}
      </div>
      <div className="divider" />
      <div className="col" style={{ gap: 14, padding: '14px 16px 16px' }}>
        {children}
      </div>
    </section>
  );
}

function ReviewCard({ review }: { review: ReviewSituation }) {
  const badge: Record<ReviewSituation, ReactNode> = {
    draft: <span className="badge">초안</span>,
    approved: (
      <span className="badge badge-success">
        <i className="ic ic-check" aria-hidden="true" />
        승인
      </span>
    ),
    wait: <span className="badge">승인 대기</span>,
    rejected: (
      <span className="badge badge-danger">
        <i className="ic ic-x-circle" aria-hidden="true" />
        반려
      </span>
    ),
    reReq: (
      <span className="badge badge-warning">
        <i className="ic ic-clock" aria-hidden="true" />
        재승인 대기
      </span>
    ),
    reRej: (
      <span className="badge badge-danger">
        <i className="ic ic-x-circle" aria-hidden="true" />
        변경 반려
      </span>
    ),
    suspended: (
      <span className="badge badge-danger">
        <i className="ic ic-ban" aria-hidden="true" />
        판매 중지
      </span>
    ),
  };
  let body: ReactNode;
  switch (review) {
    case 'approved':
      body = (
        <>
          <Kv
            rows={[
              ['승인', summary.approvedAt],
              ['공연 규모', summary.scale],
              ['중개수수료율', `${stellaOrg.commissionRate} · 승인 때 고정`],
            ]}
          />
          <p className="hint">승인 뒤 가격·회차·좌석 등급·좌석맵·판매 정책을 바꾸면 다시 판매 승인을 받고, 오픈 전이면 오픈 예약이 멈춥니다</p>
        </>
      );
      break;
    case 'wait':
      body = (
        <>
          <div className="banner banner-warning" role="status">
            <i className="ic ic-alert" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">다시 판매 승인을 받는 중입니다 · 오픈 예약이 멈췄습니다</span>
              승인 뒤 가격과 회차를 바꿔 PEAKET 운영자가 다시 확인합니다. 다시 승인될 때까지 오픈 예약이 멈춥니다. 바뀐 항목: 가격, 회차
            </div>
          </div>
          <p className="t-sm muted">처음 승인 {summary.approvedAt} · PEAKET 운영자가 확인하고 있습니다</p>
        </>
      );
      break;
    case 'rejected':
      body = (
        <>
          <div className="banner banner-danger" role="status">
            <i className="ic ic-x-circle" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">판매 승인이 반려되었습니다</span>
              사유: {summary.rejectReason} · {summary.rejectedAt} 반려. 고쳐서 다시 요청하면 PEAKET 운영자가 다시 확인합니다.
            </div>
          </div>
          <a className="link-more" href="#m-s5" style={{ alignSelf: 'flex-start' }}>
            고칠 항목: 5단계 판매자 정보
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </a>
        </>
      );
      break;
    case 'reReq':
    case 'reRej':
      body = (
        <>
          <div className={review === 'reReq' ? 'banner banner-info' : 'banner banner-danger'} role="status">
            <i className={review === 'reReq' ? 'ic ic-clock' : 'ic ic-x-circle'} aria-hidden="true" />
            <div className="banner-body">
              {review === 'reReq' ? (
                <>
                  <span className="banner-title">재승인 대기 · 바꾼 항목: 가격</span>
                  공개 중인 내용과 판매는 승인될 때까지 그대로입니다
                </>
              ) : (
                <>
                  <span className="banner-title">변경 반려 · 바꾼 항목: 가격</span>
                  사유: [반려 사유]
                  <br />
                  공개 중인 내용과 판매는 승인될 때까지 그대로입니다
                </>
              )}
            </div>
          </div>
          <Kv
            rows={[
              ['처음 승인', summary.approvedAt],
              ['판매 승인 요청', summary.reRequestedAt],
            ]}
          />
        </>
      );
      break;
    case 'suspended':
      body = (
        <>
          <div className="banner banner-danger" role="status">
            <i className="ic ic-ban" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">판매 중지 · 사유: 판매자 신원 확인 필요</span>
              공개와 새 판매가 멈췄습니다. 이미 판매한 티켓은 유효하고 정산 지급은 보류됩니다. 문의는 파트너 지원으로 해 주세요
            </div>
          </div>
          <a className="link-more" href={PARTNER_SUPPORT_HREF} style={{ alignSelf: 'flex-start' }}>
            파트너 지원 문의
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </a>
          <Kv
            rows={[
              ['처음 승인', summary.approvedAt],
              ['편집', '잠김'],
            ]}
          />
        </>
      );
      break;
    default:
      // 새 공연 초안(보드에 없는 휴대폰 모습 — 추천안)
      body = <p className="t-sm muted">아직 판매 승인을 요청하지 않았습니다. 5단계까지 입력한 뒤 태블릿이나 데스크톱에서 판매 승인을 요청합니다.</p>;
  }
  return (
    <section className="card pad col" style={{ gap: 12 }} aria-labelledby="m-h-review">
      <div className="row between" style={{ gap: 8 }}>
        <h2 className="t-md fw-b" id="m-h-review">
          판매 승인
        </h2>
        <span className="row" style={{ gap: 6 }}>
          {badge[review]}
        </span>
      </div>
      <div className="col" style={{ gap: 12 }}>
        {body}
      </div>
    </section>
  );
}

export function MobileSummary({ review, eventId, doneUpTo }: { review: ReviewSituation; eventId: string; doneUpTo: number }) {
  const rejected = review === 'rejected';
  const revising = review === 'reReq' || review === 'reRej';
  const isDone = (n: number) => (rejected && n === 5 ? false : n <= doneUpTo);
  return (
    <div className="col md:hidden" style={{ gap: 16 }}>
      <ReviewCard review={review} />

      {review === 'suspended' ? null : revising ? (
        <CopyLinkBanner
          title="변경 취소와 고쳐서 다시 요청은 태블릿이나 데스크톱에서 합니다"
          body="파트너 관리자가 합니다. 변경 취소는 마지막 승인 내용으로 돌아갑니다. 휴대폰에서는 볼 수만 있습니다"
        />
      ) : rejected ? (
        <CopyLinkBanner title="공연 등록과 수정은 태블릿이나 데스크톱에서 합니다" body="반려 사유를 고치고 다시 요청하는 일도 큰 화면에서 합니다. 휴대폰에서는 볼 수만 있습니다" />
      ) : (
        <CopyLinkBanner title="공연 등록과 수정은 태블릿이나 데스크톱에서 합니다" body="임시저장과 판매 승인 요청도 큰 화면에서 합니다. 휴대폰에서는 볼 수만 있습니다" />
      )}

      <section className="col" style={{ gap: 12 }} aria-labelledby="m-h-steps">
        <h2 className="t-lg" id="m-h-steps">
          단계별 입력 내용
        </h2>

        <StepCard n={1} done={isDone(1)}>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <span className="poster poster-lumen poster-sm" style={{ width: 52 }} role="img" aria-label={media.poster.alt}>
              <span className="poster-title">LUMEN</span>
            </span>
            <div className="col grow" style={{ gap: 4 }}>
              <span className="t-sm fw-b">포스터·상세 이미지 2장</span>
              <span className="t-xs muted">첫 이미지가 포스터입니다 · 대체 텍스트 입력 완료</span>
            </div>
          </div>
          <Kv
            rows={[
              ['공연명', draft.title],
              ['다른 이름', draft.aliases.join(', ')],
              ['공연장', draft.venueName],
              ['아티스트', draft.artistName],
              ['장르', draft.genre],
              ['관람 연령', '[관람 연령]'],
              ['러닝타임', `${draft.runtimeMin}분`],
              ['기획사·제작사', draft.producer],
              ['안내 사항', <span key="n" className="muted">비어 있음</span>],
            ]}
          />
          <div className="col" style={{ gap: 4 }}>
            <span className="eyebrow">공연 설명</span>
            <p className="t-sm">LUMEN이 서울에서 여는 첫 단독 공연입니다. 대표곡과 새 앨범 수록곡을 밴드 편성으로 들려 드립니다.</p>
          </div>
          <div className="card-flat col" style={{ gap: 2, padding: '10px 12px' }}>
            <span className="t-sm fw-b">공연예술통합전산망 10개 항목</span>
            <span className="t-xs muted">입력 6 · 판매 뒤 자동 집계 3 · 비어 있음 1(안내 사항, 선택)</span>
          </div>
        </StepCard>

        <StepCard n={2} done={isDone(2)} badge={review === 'wait' ? <span className="badge badge-warning">바뀐 항목</span> : undefined}>
          <div className="col" style={{ gap: 8 }}>
            <span className="eyebrow">회차 {summary.rounds.length}개</span>
            <ul className="col" style={{ gap: 8 }}>
              {summary.rounds.map((r) => (
                <li key={r.when} className="card-flat col" style={{ gap: 2, padding: '10px 12px' }}>
                  <span className="t-sm fw-b">{r.when}</span>
                  <span className="t-xs muted">{r.meta}</span>
                </li>
              ))}
            </ul>
          </div>
          <Kv
            rows={[
              [
                '오픈 시각',
                <>
                  {summary.openAt}
                  {review === 'wait' ? (
                    <span className="badge badge-warning" style={{ marginLeft: 6 }}>
                      예약 멈춤
                    </span>
                  ) : null}
                </>,
              ],
              ['로비 개방', summary.lobby],
              ['가상계좌', '허용 안 함'],
            ]}
          />
          <div className="col" style={{ gap: 4 }}>
            <span className="eyebrow">가격 등급 · 공연 상세에 보이는 순서</span>
            <ol className="col">
              {tiers.map((t, i) => (
                <li key={t.id} className="row between" style={{ padding: '8px 0', borderBottom: i < tiers.length - 1 ? '1px solid var(--border)' : undefined }}>
                  <span className="t-sm fw-b">{t.name}</span>
                  <span className="t-sm num">{formatWon(Number(t.price.replace(/,/g, '')))}</span>
                </li>
              ))}
            </ol>
          </div>
        </StepCard>

        <StepCard n={3} done={isDone(3)}>
          <Kv rows={summary.seatmap} />
          <div className="row between wrap" style={{ gap: 8 }}>
            <span className="badge badge-success">
              <i className="ic ic-check" aria-hidden="true" />
              휠체어석 수량 기준 충족(기준 20석 이상)
            </span>
            <Link className="link-more" href={routes.eventTab(eventId, 'seatmap')}>
              좌석맵 보기
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </Link>
          </div>
        </StepCard>

        <StepCard n={4} done={isDone(4)}>
          <Kv
            rows={[
              ['대기열 정렬', '하이브리드'],
              ['좌석 배정', '좌석 직접 선택'],
              ['1인 한도', '4매'],
              ['판매 정책 규칙', summary.policyRules],
              ['공연 규모', rejected || review === 'draft' ? '판매 승인 때 확정' : summary.scale],
            ]}
          />
          <Link className="link-more" href={routes.eventTab(eventId, 'policy')} style={{ alignSelf: 'flex-start' }}>
            판매 정책 규칙 보기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </StepCard>

        <StepCard n={5} done={isDone(5)} badge={rejected ? <span className="badge badge-danger">고칠 항목 1</span> : undefined}>
          <span className="eyebrow">판매자 정보 7항목 · 공연 상세 판매자 고지에 보입니다</span>
          <Kv
            rows={[
              ['상호', stellaOrg.seller.companyName],
              ['대표자', stellaOrg.seller.representative],
              ['주소', stellaOrg.seller.address],
              ['전화', stellaOrg.seller.phone],
              ['전자우편', stellaOrg.seller.email],
              ['사업자등록번호', stellaOrg.seller.businessNo],
              [
                '통신판매업 신고번호',
                rejected ? (
                  <span className="row tx-danger" style={{ gap: 4, justifyContent: 'flex-end' }}>
                    <i className="ic ic-alert-circle ic-16" aria-hidden="true" />
                    입력 안 됨
                  </span>
                ) : (
                  stellaOrg.seller.mailOrderNo
                ),
              ],
            ]}
          />
          <div className="divider" />
          <Kv
            rows={[
              ['정산 계좌', `${stellaOrg.payout.bank} ${stellaOrg.payout.accountMasked}`],
              ['중개수수료율', stellaOrg.commissionRate],
              ['토스페이먼츠 셀러', <span key="t" className="badge badge-success">부분 승인</span>],
            ]}
          />
          <p className="hint">PEAKET에는 은행과 끝 4자리만 남깁니다. 주 1천만 원 이상 첫 지급에서 결제사 KYC 때문에 지급이 늦어질 수 있습니다</p>
          <div className="divider" />
          <span className="eyebrow">휠체어석 확인</span>
          <p className="t-sm num">휠체어석 20석 · 기준 20석 이상 · 위치 확인 0석</p>
          <p className="row t-sm" style={{ gap: 6, alignItems: 'flex-start' }}>
            <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
            휠체어석의 수와 위치를 공연장 좌석 배치도와 대조했습니다
          </p>
          <p className="hint">판매 승인에서 운영자가 이 확인과 이유를 봅니다.</p>
        </StepCard>
      </section>
    </div>
  );
}
