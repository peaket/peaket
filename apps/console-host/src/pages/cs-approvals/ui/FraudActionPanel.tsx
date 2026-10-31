// SCR-046 부정 예매 조치(FRAUD_ACTION) 패널과 요청 목록 카드. 세 배치 보드(board-d·t·m)가 함께 쓴다(add-fraud-investigation-screens design.md 결정 8).
// 디자인 캔버스 보드에 없는 변형이라 d5 §7.7 '부정 예매 조치' 그림과 상태 표가 시각 기준이다. CMP-060 ApprovalPanel의 fraud-action 변형이다(d2).
// - 사건 요약은 읽기 전용이고 openapi FraudCaseSummary의 칸만 보인다(계정 ID·가명·IP·연락처·결제 수단 값·연결 그래프 없음, authz-matrix §4.1).
// - ( 사건 작업대 › )는 지금 세션에 부정 거래 조사관 지정(FRAUD_INVESTIGATOR)이 있을 때만 둔다(control-tower §9.2 '승인자가 보는 범위').
// - 승인 자격(요청자가 아니고 가명정보 취급자 지정이 없는 commander)이 없는 세션이 승인자 상태를 열면 '열 수 없음'으로 그린다(서버는 404).
//   ?role=·?designation=으로 바꿔 볼 때를 위한 것이다. 휴대폰에서도 요약을 줄이지 않고 모두 보인 뒤 승인·반려한다(d5 §3.9).
import { useState } from 'react';
import { Link } from 'react-router';
import { CaseStatusBadge, type AppealResultValue } from '@peaket/ds/CaseStatusBadge';
import { useHost } from '@/features/preview-host';
import { useRo } from '@/features/screen-access';
import { CancelDeadlineBadge, LINK_KIND_LABEL, REASON_LABEL, SIGNAL_LABEL, formatKst, purchaseVsLimit } from '@/entities/fraud-case';
import { useLayout } from '@/shared/lib/layout';
import { Overlay } from '@/shared/ui/Overlay';
import { FRAUD_APPROVAL as A, deadlinePassed, kst, nowFor, shortHash } from '../model/fraud-approval';
import type { FraudVariant } from '../states';

type Go = (state: string) => void;

const S = A.summary;
const CANCEL_TEXT = `표 ${S.ticketCount}장 취소와 환급`;

/** 소명 결과의 수를 보이는 순서(d5 §7.7 그림) */
const APPEAL_ORDER: readonly [AppealResultValue, keyof typeof S.appealCounts][] = [
  ['REJECTED', 'rejected'],
  ['EXPIRED', 'expired'],
  ['ACCEPTED', 'accepted'],
  ['SUBMITTED', 'submitted'],
  ['PENDING', 'pending'],
];

function copyHash() {
  void navigator.clipboard?.writeText(S.snapshotHash).catch(() => undefined);
}

/**
 * 이 세션이 부정 예매 조치 상세를 받는지(control-tower §9.2 '승인자가 보는 범위', openapi GET /v1/ops/approval-requests/{approvalId}).
 * 요청자(그 사건의 지정 조사관)와 승인 자격자(요청자가 아니고 가명정보 취급자 지정이 없는 commander)만 받고, 그 밖은 없는 업무와 같은 404다.
 * 목록 카드·'전체' 셈·상세가 모두 이 판정을 따른다(퍼블리싱. 데이터 연결 단계에서는 서버 응답이 정한다).
 */
export function useFraudAccess() {
  const { session } = useHost();
  const eligible = session.role === 'commander' && !session.designations.includes('PSEUDONYM_HANDLER') && session.name !== A.requester.name;
  const requester =
    session.name === A.requester.name && (session.role === 'cs_lead' || session.role === 'commander') && session.designations.includes('FRAUD_INVESTIGATOR');
  return { eligible, requester, visible: eligible || requester };
}

/** 요청 목록의 부정 예매 조치 줄(받을 수 있는 세션에만 그린다) */
export function FraudListItem({ variant, go }: { variant: FraudVariant | null; go?: Go }) {
  const { visible } = useFraudAccess();
  if (!visible || variant === 'closed') return null;
  return (
    <li>
      <FraudRequestCard variant={variant} go={go} />
    </li>
  );
}

/** 요청 목록 '전체' 수: 보드의 넷에 부정 예매 조치를 받을 수 있으면 하나를 더한다 */
export function FraudAllCount({ variant }: { variant: FraudVariant | null }) {
  const { visible } = useFraudAccess();
  return <span className="badge">{visible && variant !== 'closed' ? 5 : 4}</span>;
}

/** 요청 목록의 카드 하나. 누르면 '부정 예매 조치' 상태로 간다 */
export function FraudRequestCard({ variant, go }: { variant: FraudVariant | null; go?: Go }) {
  const layout = useLayout();
  const selected = variant !== null && variant !== 'closed';
  const expired = variant === 'expired';
  const passed = deadlinePassed(variant);
  return (
    <Link
      onClick={(e) => {
        e.preventDefault();
        go?.('부정 예매 조치');
      }}
      to="/cs/approvals"
      className={`card ${selected ? 'is-selected' : ''}`}
      aria-current={selected ? 'true' : 'false'}
      style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 14px', color: 'inherit', ...(layout === 'tablet' ? { height: '100%' } : {}) }}
    >
      <span className="row between" style={{ gap: '6px' }}>
        <span className="t-sm fw-b">부정 예매 조치</span>
        {expired ? <span className="badge">만료</span> : <span className="badge badge-warning">승인 대기 0/1</span>}
      </span>{' '}
      <span className="t-xs muted">
        사건 {A.caseId} · LUMEN {formatKst(A.eventStartsAt)} · {S.accountCount}계정 {S.ticketCount}장
      </span>{' '}
      <span className="row between" style={{ gap: '6px' }}>
        <span className="t-xs muted">
          요청 {A.requester.name}
          {variant === 'own' ? '(나)' : ''} · {kst(A.requestedAt)}
        </span>
        <CancelDeadlineBadge now={nowFor(variant)} deadline={S.cancelDeadlineAt} long={passed} />
      </span>
    </Link>
  );
}

/** 승인 패널 자리에 들어가는 부정 예매 조치 상세 */
export function FraudActionPanel({ variant, go }: { variant: FraudVariant; go?: Go }) {
  const layout = useLayout();
  const { session } = useHost();
  const access = useFraudAccess();
  const ro = useRo();
  // 승인 직전 재인증(CMP-064 admin, 패스키 확인 포함). 양도 회수용 재인증 상태와 섞지 않으려고 이 패널 안에서 연다(퍼블리싱)
  const [reauth, setReauth] = useState(false);
  const phone = layout === 'phone';
  const investigator = session.designations.includes('FRAUD_INVESTIGATOR');
  // 승인자 변형은 승인 자격자, 요청자 본인 변형은 그 요청의 조사관만 받는다(그 밖은 '열 수 없음', 서버 404)
  const v: FraudVariant = ((variant === 'approve' || variant === 'expired') && !access.eligible) || (variant === 'own' && !access.requester) ? 'closed' : variant;

  if (v === 'closed') return <Closed phone={phone} />;

  const own = v === 'own';
  const expired = v === 'expired';
  const passed = deadlinePassed(v);
  const block = phone ? ' btn-block' : '';
  const big = phone ? ' btn-lg' : '';

  const statusBadges = (
    <>
      {expired ? <span className="badge">만료</span> : <span className="badge badge-warning">승인 대기 0/1</span>}{' '}
      <span className="badge badge-outline">2인 규칙(요청자 + 승인자)</span>
    </>
  );

  const expiredBanner = expired ? (
    <div className="banner banner-warning">
      <i className="ic ic-clock" aria-hidden="true" />
      <div className="banner-body">
        취소 마감({kst(S.cancelDeadlineAt)})이 지나 이 요청은 만료됐습니다. 표 취소는 실행되지 않습니다. 조사관이 이용 제한을 따로 요청할 수 있습니다.
      </div>
    </div>
  ) : null;

  const request = (
    <section className="col" style={{ gap: '8px' }} aria-labelledby="fa-req">
      <h3 className="eyebrow" id="fa-req">
        요청 내용
      </h3>
      <dl className="kv">
        <dt>종류</dt>
        <dd>
          <span className="badge">부정 예매 조치</span>
        </dd>
        <dt>조치</dt>
        <dd>표 취소와 환급</dd>
        <dt>사건</dt>
        <dd>
          <span className="mono">{A.caseId}</span>
        </dd>
        <dt>공연</dt>
        <dd>
          {A.eventTitle} · {formatKst(A.eventStartsAt)}
        </dd>
        <dt>대상</dt>
        <dd>
          {S.accountCount}계정 {S.ticketCount}장
        </dd>
        <dt>요청</dt>
        <dd>
          {A.requester.name}({A.requester.role}, 부정 거래 조사관{own ? ', 나' : ''}) · {kst(A.requestedAt)}
        </dd>
        <dt>승인 기한</dt>
        <dd>
          {kst(A.dueAt)}(취소 마감) <CancelDeadlineBadge now={nowFor(v)} deadline={S.cancelDeadlineAt} long={passed} />
        </dd>
      </dl>
      <p className="card-flat pad t-sm">
        <span className="sr-only">근거: </span>"{A.reasonText}" · {A.requester.name}
      </p>
    </section>
  );

  const summary = (
    <section className="col" style={{ gap: '8px' }} aria-labelledby="fa-sum" data-fraud-summary="">
      <h3 className="eyebrow" id="fa-sum">
        사건 요약 · 읽기 전용
      </h3>
      <div className="card-flat pad col" style={{ gap: '12px' }}>
        <dl className="kv">
          <dt>사유 범주</dt>
          <dd>
            <span className="badge">{REASON_LABEL[S.reasonCategory]}</span>
          </dd>
          <dt>계정</dt>
          <dd className="num">{S.accountCount}</dd>
          <dt>대상 표</dt>
          <dd className="num">{S.ticketCount}</dd>
          <dt>구매 수 대 한도</dt>
          <dd className="num">{purchaseVsLimit(S.purchaseCount, S.limitPerPerson)}</dd>
          <dt>공유 속성</dt>
          <dd>{S.sharedAttributes.map((k) => LINK_KIND_LABEL[k]).join('·')}</dd>
          <dt>근거 신호</dt>
          <dd>{S.signals.map((k) => SIGNAL_LABEL[k]).join('·')}</dd>
          <dt>소명 결과</dt>
          <dd>
            <ul className="row wrap" style={{ gap: '4px 10px', justifyContent: 'flex-end' }} aria-label="계정별 소명 결과의 수">
              {APPEAL_ORDER.map(([value, key]) => (
                <li key={value} className="row" style={{ gap: '4px' }}>
                  <CaseStatusBadge variant="appeal" value={value} /> <span className="num">{S.appealCounts[key]}</span>
                </li>
              ))}
            </ul>
          </dd>
        </dl>
        {S.investigatorOpinion ? (
          <div className="col" style={{ gap: '4px' }}>
            <span className="t-xs fw-b">조사관 의견</span>
            <p className="t-sm">
              "{S.investigatorOpinion}" · {A.requester.name}
            </p>
          </div>
        ) : null}
        <dl className="kv">
          <dt>기록 고정 판 해시</dt>
          <dd>
            <span className="row" style={{ gap: '4px', justifyContent: 'flex-end' }}>
              <span className="hash">{shortHash(S.snapshotHash)}</span>
              <button onClick={copyHash} className="icon-btn icon-btn-sm" type="button" aria-label="기록 고정 판 해시 64자리 전체 복사">
                <i className="ic ic-copy" aria-hidden="true" />
              </button>
            </span>
          </dd>
        </dl>
      </div>
      <div className="banner banner-info">
        <i className="ic ic-shield" aria-hidden="true" />
        <div className="banner-body">계정 원문·IP·연락처·결제 수단 값과 연결 그래프는 승인 화면에 없습니다. 이 요약 열람도 접속기록에 남습니다.</div>
      </div>
      {investigator ? (
        <Link to={`/investigations/${A.caseId}`} className="link-more" style={{ alignSelf: 'flex-start' }}>
          사건 작업대
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      ) : null}
    </section>
  );

  const need = (
    <section className="col" style={{ gap: '10px' }} aria-labelledby="fa-need">
      <h3 className="eyebrow" id="fa-need">
        필요한 승인
      </h3>
      <div className="banner banner-announce">
        <i className="ic ic-users" aria-hidden="true" />
        <div className="banner-body">
          <span className="banner-title">조치는 다른 승인자가 확인해야 실행됩니다</span>
          {expired ? '승인되지 않고 취소 마감이 지났습니다.' : '남은 승인 1명: 요청자가 아니고 가명정보 취급자 지정이 없는 commander.'}
        </div>
      </div>
      <ol className="col" style={{ gap: '8px' }} aria-label="승인자">
        <li className="row between" style={{ gap: '8px' }}>
          <span className="step is-done">
            <span className="step-num">
              <i className="ic ic-check" aria-hidden="true" />
            </span>
            요청 · {A.requester.name}(조사관{own ? ', 나' : ''})
          </span>
          <span className="badge badge-success">요청함</span>
        </li>
        <li className="row between" style={{ gap: '8px' }}>
          {v === 'approve' ? (
            <>
              <span className="step is-current" aria-current="step">
                <span className="step-num">2</span>
                commander · {session.name}(나)
              </span>
              <span className="badge badge-warning">지금 차례</span>
            </>
          ) : (
            <>
              <span className="step">
                <span className="step-num">2</span>
                commander
              </span>
              <span className="badge">{expired ? '만료' : '대기'}</span>
            </>
          )}
        </li>
      </ol>
    </section>
  );

  // 만료된 요청은 실행하지 않으므로 '승인되면' 안내를 두지 않는다
  const after = expired ? null : (
    <div className="card-flat pad col" style={{ gap: '4px' }}>
      <span className="t-xs fw-b">승인되면</span>{' '}
      <span className="t-xs muted">승인하면 운영자 취소로 환급하고(공제 없음) 좌석은 정가 재판매로 돌립니다. 실행된 취소는 되돌릴 수 없습니다.</span>
    </div>
  );

  const note = (id: string, label: string, opt: string) => (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label} <span className="opt">({opt})</span>
      </label>{' '}
      <textarea className="textarea" id={id} style={{ minHeight: '84px' }} aria-describedby={`${id}-h ${id}-c`} />{' '}
      <span className="hint" id={`${id}-h`}>
        감사 기록에 남습니다. 팬 개인정보는 적지 마세요.
      </span>{' '}
      <span className="counter" id={`${id}-c`} aria-live="polite">
        0 / 500자
      </span>
    </div>
  );

  const actions = expired ? null : (
    <div className="col" style={{ gap: '8px' }}>
      {own ? note('fa-note', '철회 사유', '철회할 때 필수') : note('fa-note', '검토 의견', '반려할 때 필수')}
      {own ? (
        <>
          <button className={`btn btn-primary${block}`} type="button" aria-disabled="true" aria-describedby="fa-why">
            {CANCEL_TEXT}을 승인합니다
          </button>
          <p className="row t-sm" id="fa-why" style={{ gap: '6px' }}>
            <i className="ic ic-lock ic-16" aria-hidden="true" />
            요청한 분은 승인할 수 없습니다
          </p>
          <div className="row">
            <button className={`btn btn-outline${block}`} type="button" {...ro()}>
              요청 철회
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={phone ? 'col' : 'row wrap'} style={{ gap: '8px' }}>
            <button onClick={() => setReauth(true)} className={`btn btn-primary${block}${big}`} type="button" {...ro('fa-re')}>
              {CANCEL_TEXT}을 승인합니다
            </button>{' '}
            <button className={`btn btn-outline${block}${big}`} type="button" {...ro()}>
              반려합니다
            </button>
          </div>
          <p className="t-xs muted" id="fa-re">
            승인 직전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다.
          </p>
          {reauth ? (
            <Overlay placement={phone ? 'bottom' : 'center'} onClose={() => setReauth(false)}>
              <div className={phone ? 'sheet' : 'dialog'} role="dialog" aria-modal="true" aria-labelledby="fa-ra-t" aria-describedby="fa-ra-d" style={{ maxWidth: '460px' }}>
                <h2 className="dialog-title" id="fa-ra-t">
                  관리 계정을 다시 확인합니다
                </h2>
                <p className="t-sm" id="fa-ra-d">
                  부정 예매 조치 승인을 기록하기 전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다. 재인증은 5분 동안 한 번만 쓸 수 있습니다.
                </p>
                <dl className="kv card-flat pad">
                  <dt>승인할 일</dt>
                  <dd>부정 예매 조치 · {A.caseId}</dd>
                  <dt>조치</dt>
                  <dd>{CANCEL_TEXT}</dd>
                  <dt>승인 뒤</dt>
                  <dd>바로 실행 · 좌석은 정가 재판매로</dd>
                </dl>
                <div className="field">
                  <label className="label" htmlFor="fa-ra-pw">
                    비밀번호
                  </label>
                  <input className="input" id="fa-ra-pw" type="password" autoComplete="current-password" />
                </div>
                <div className="field">
                  <label className="label" htmlFor="fa-ra-otp">
                    인증 앱 코드 6자리
                  </label>
                  <input className="otp-input" id="fa-ra-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" />
                </div>
                <div className="dialog-actions">
                  <button onClick={() => setReauth(false)} className="btn btn-outline" type="button">
                    닫기
                  </button>
                  <button onClick={() => setReauth(false)} className="btn btn-primary" type="button">
                    재인증하고 승인합니다
                  </button>
                </div>
              </div>
            </Overlay>
          ) : null}
        </>
      )}
    </div>
  );

  if (phone) {
    return (
      <div className="col" style={{ gap: '12px' }} data-approval-id={A.approvalId}>
        <section className="widget" aria-labelledby="fa-h">
          <div className="widget-head" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '6px', padding: '12px 14px' }}>
            <span className="row wrap" style={{ gap: '6px' }}>
              {statusBadges}
            </span>
            <h2 className="t-md fw-b" id="fa-h">
              부정 예매 조치 · {A.caseId}
            </h2>
          </div>
          <div className="widget-body" style={{ gap: '20px' }}>
            {expiredBanner}
            {request}
            {summary}
            {need}
          </div>
        </section>
        {actions}
        {after}
      </div>
    );
  }

  return (
    <div className="col" data-approval-id={A.approvalId}>
      <div className="widget-head">
        <h2 className="t-sm fw-b">부정 예매 조치 · {A.caseId}</h2>
        <div className="actions">{statusBadges}</div>
      </div>
      <div className="widget-body" style={{ gap: '16px' }}>
        {expiredBanner}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '24px', alignItems: 'start' }}>
          <div className="col" style={{ gap: '18px' }}>
            {request}
            {summary}
          </div>
          <div className="col" style={{ gap: '18px' }}>
            {need}
            {actions}
            {after}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 열 수 없음: 상세가 없는 업무와 같은 404(요약도 승인 단추도 없다). '권한 밖 승인' 상태와 같은 모양이다 */
function Closed({ phone }: { phone: boolean }) {
  const body = '없는 요청이거나 지금 계정으로 열 수 없는 요청입니다. 부정 예매 조치는 요청자와 승인 자격이 있는 commander만 엽니다.';
  if (phone) {
    return (
      <section className="widget" aria-labelledby="fa-closed-h">
        <div className="widget-body">
          <div className="state" role="alert" style={{ padding: '32px 8px', gap: '12px' }}>
            <span className="state-icon is-danger">
              <i className="ic ic-ban" aria-hidden="true" />
            </span>
            <h2 className="t-lg" id="fa-closed-h">
              이 승인 요청은 열 수 없습니다
            </h2>
            <p className="t-sm muted">{body}</p>
            <Link to="/cs/approvals" className="btn btn-outline btn-block">
              요청 목록으로
            </Link>
          </div>
        </div>
      </section>
    );
  }
  return (
    <div className="col">
      <div className="widget-head">
        <h2 className="t-sm fw-b">승인 요청</h2>
      </div>
      <div className="widget-body">
        <div className="state" role="alert" style={{ padding: '48px 16px', gap: '12px' }}>
          <span className="state-icon is-danger">
            <i className="ic ic-ban" aria-hidden="true" />
          </span>
          <h3 className="t-lg">이 승인 요청은 열 수 없습니다</h3>
          <p className="t-sm muted">{body}</p>
          <Link to="/cs/approvals" className="btn btn-outline">
            요청 목록으로
          </Link>
        </div>
      </div>
    </div>
  );
}
