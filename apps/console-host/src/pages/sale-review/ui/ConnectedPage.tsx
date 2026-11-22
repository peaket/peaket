// SCR-048 판매 승인 연결 화면(/sale-reviews/:productionId, BAT-617, LCH-080, d5 §7.9, ADR-0327).
// 목록은 GET /v1/ops/sale-reviews(기본 SUBMITTED, 상태 필터), 확인 패널은 GET /v1/ops/sale-reviews/{productionId}다.
// operator·commander만 승인·반려하고 viewer·CS는 읽기만 한다. 승인 본문은 회차별 scales와 (있으면) placeId만 낸다.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError } from '@peaket/api-client';
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { BOARD_PEOPLE, NoAccess, ReadOnlyScope } from '@/features/screen-access';
import { useChosenRole, usePreviewHost } from '@/features/preview-host';
import { ensureConsoleApi } from '@/shared/api';
import { Overlay } from '@/shared/ui/Overlay';
import {
  approvalBody,
  canAct,
  canRead,
  formatKst,
  initialScales,
  mapSaleReviewDetail,
  mapSaleReviewList,
  saleReviewProblem,
  statusLabel,
  validateApproval,
  validateRejection,
  type SaleReviewDetail,
  type SaleReviewPage,
  type SaleReviewStatus,
  type ShowScale,
} from '../model/sale-review';

const TITLE = '판매 승인';
/** 기본 목록 조건: 승인 대기만. 상태 탭을 고르면 그 상태 하나를 본다 */
type ListStatus = Exclude<SaleReviewStatus, 'DRAFT'>;
const DEFAULT_QUERY = { status: ['SUBMITTED'] as ListStatus[] };
const FILTERS: readonly { status: ListStatus; label: string }[] = [
  { status: 'SUBMITTED', label: '승인 대기' },
  { status: 'APPROVED', label: '승인됨' },
  { status: 'REJECTED', label: '반려' },
  { status: 'SUSPENDED', label: '판매 중지' },
];
const SCALES: readonly { value: ShowScale; label: string }[] = [
  { value: 'LARGE', label: '대형' },
  { value: 'MEDIUM', label: '중형' },
  { value: 'SMALL', label: '소형' },
];

type Load = { kind: 'loading' } | { kind: 'ready' } | { kind: 'config' } | { kind: 'forbidden' } | { kind: 'error'; message: string };

export function ConnectedPage() {
  const chosen = useChosenRole();
  const { productionId = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const [filter, setFilter] = useState<ListStatus>('SUBMITTED');
  const [page, setPage] = useState<SaleReviewPage>({ items: [], nextCursor: null });
  const [detail, setDetail] = useState<SaleReviewDetail | null>(null);
  const [screen, setScreen] = useState<Load>({ kind: 'loading' });
  const [scales, setScales] = useState<Record<string, ShowScale | ''>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'approve' | 'reject' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const write = canAct(chosen);
  const read = canRead(chosen);
  const approvalIssues = useMemo(() => (detail ? validateApproval(detail, scales) : ['공연을 고르세요']), [detail, scales]);
  const rejectionIssue = validateRejection(reason);

  usePreviewHost(
    {
      scope: { stage: 'T=0' },
      control: { kind: 'paused', remaining: '13:12' },
      clock: '20:04:12 KST',
      ...(chosen ? {} : { session: BOARD_PEOPLE.operator }),
    },
    [chosen, filter, productionId],
  );

  const load = useCallback(async () => {
    if (!ensureConsoleApi()) {
      setScreen({ kind: 'config' });
      return;
    }
    setScreen((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
    try {
      const [{ listOpsSaleReviews, getOpsSaleReview }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const [listResponse, detailResponse] = await Promise.all([
        listOpsSaleReviews({ status: filter === 'SUBMITTED' ? DEFAULT_QUERY.status : [filter], limit: 100 }),
        productionId !== '' ? getOpsSaleReview(productionId) : Promise.resolve(null),
      ]);
      setPage(mapSaleReviewList(listResponse.data));
      if (detailResponse) {
        const mapped = mapSaleReviewDetail(detailResponse.data as unknown as Record<string, unknown>);
        setDetail(mapped);
        setScales(initialScales(mapped.events));
      } else {
        setDetail(null);
      }
      setScreen({ kind: 'ready' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setScreen({ kind: 'forbidden' });
      else if (e instanceof ApiError && e.status === 404) {
        setDetail(null);
        setScreen({ kind: 'error', message: '이 공연의 판매 승인을 찾을 수 없습니다. 목록에서 다시 골라 주세요.' });
      } else {
        const p = saleReviewProblem(e);
        setScreen({ kind: 'error', message: p.message });
      }
    }
  }, [filter, productionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeFilter = (next: ListStatus) => {
    setFilter(next);
    setNotice(null);
    const q = new URLSearchParams(sp);
    q.set('status', next);
    setSp(q, { replace: true });
  };

  const run = async (kind: 'approve' | 'reject') => {
    if (!detail || busy || !write) return;
    const issue = kind === 'approve' ? approvalIssues[0] : rejectionIssue;
    if (issue) {
      setNotice({ tone: 'bad', text: issue });
      setConfirm(null);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const [{ createOpsSaleReviewApproval, createOpsSaleReviewRejection }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      if (kind === 'approve') await createOpsSaleReviewApproval(detail.productionId, approvalBody(detail, scales));
      else await createOpsSaleReviewRejection(detail.productionId, { reason: reason.trim() });
      setConfirm(null);
      setNotice({ tone: 'ok', text: kind === 'approve' ? '판매를 승인했습니다. 판매 열기와 대기열 사본은 서버가 잇습니다.' : '판매 승인을 반려했습니다. 사유가 파트너 화면에 보입니다.' });
      setReason('');
      await load();
    } catch (e) {
      const problem = saleReviewProblem(e);
      setConfirm(null);
      setNotice({ tone: 'bad', text: problem.message });
      if (problem.kind === 'forbidden') setScreen({ kind: 'forbidden' });
      if (problem.reload) await load();
    } finally {
      setBusy(false);
    }
  };

  if (chosen && !read) return <NoAccess title={TITLE} role={chosen} who="viewer·operator·commander·CS 담당자" />;
  if (screen.kind === 'config') {
    return <section className="widget" role="alert"><div className="widget-body t-sm">관제 API 주소가 설정되지 않아 판매 승인을 부를 수 없습니다. 빌드의 <code>PEAKET_OPS_API_ORIGIN</code>을 확인해 주세요.</div></section>;
  }
  if (screen.kind === 'forbidden') return <NoAccess title={TITLE} role={chosen ?? 'viewer'} who="viewer·operator·commander·CS 담당자" />;

  return (
    <ReadOnlyScope on={!!chosen && !write} role={chosen ?? 'viewer'} who="operator·commander">
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>{TITLE}</h1>
          <p className="t-sm muted">판매 조건은 파트너가 정합니다. 운영자는 확인과 승인·반려만 합니다. 지급대행 등록은 연동 전이라 승인을 막지 않습니다.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-outline" type="button" onClick={() => void load()} disabled={busy}>
            <i className="ic ic-refresh" aria-hidden="true" /> 새로 고침
          </button>
        </div>
      </div>

      {notice ? (
        <div className={`banner ${notice.tone === 'ok' ? 'banner-info' : 'banner-danger'}`} role={notice.tone === 'ok' ? 'status' : 'alert'} style={{ marginBottom: 12 }}>
          <div className="banner-body">{notice.text}</div>
        </div>
      ) : null}

      <div className="grid-12" style={{ rowGap: 16, alignItems: 'start' }}>
        <section className="widget span-4" aria-labelledby="sr-list">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="sr-list">승인 목록</h2>
            <span className="badge">{page.items.length}건</span>
          </div>
          <div className="widget-body col" style={{ padding: 12, gap: 10 }}>
            <div className="row wrap" role="tablist" aria-label="판매 승인 상태">
              {FILTERS.map((f) => (
                <button key={f.status} type="button" role="tab" aria-selected={filter === f.status} className={filter === f.status ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'} onClick={() => changeFilter(f.status)}>
                  {f.label}
                </button>
              ))}
            </div>
            {screen.kind === 'loading' ? <p className="t-sm muted" role="status">목록을 불러오는 중…</p> : null}
            {screen.kind === 'error' ? <p className="t-sm" role="alert">{screen.message}</p> : null}
            {page.items.length === 0 && screen.kind === 'ready' ? (
              <div className="state" role="status"><h3 className="t-md">{filter === 'SUBMITTED' ? '승인 대기 공연이 없습니다' : '해당 상태의 공연이 없습니다'}</h3></div>
            ) : null}
            <ul className="col" style={{ gap: 8 }}>
              {page.items.map((item) => (
                <li key={item.productionId}>
                  <Link
                    to={`/sale-reviews/${item.productionId}`}
                    className="card-flat pad col"
                    style={{ gap: 4, borderColor: item.productionId === detail?.productionId ? 'var(--color-primary, #2563eb)' : undefined }}
                    aria-current={item.productionId === detail?.productionId ? 'page' : undefined}
                  >
                    <span className="row between wrap" style={{ gap: 6 }}>
                      <strong className="t-sm">{item.title || item.productionId}</strong>
                      <span className="badge">{statusLabel(item.status, item.reapproval)}</span>
                    </span>
                    <span className="t-xs muted">{item.promoterName} · 회차 {item.eventCount}개 · 제출 {formatKst(item.submittedAt)}</span>
                    {item.reapproval ? <span className="badge badge-warning" style={{ alignSelf: 'flex-start' }}>재승인</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
            {page.nextCursor !== null ? <p className="t-xs muted">다음 장이 있습니다. 상태를 좁혀 주세요.</p> : null}
          </div>
        </section>

        <section className="widget span-8" aria-labelledby="sr-panel">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="sr-panel">확인 패널</h2>
            {chosen && !write ? <span className="badge">읽기 전용</span> : null}
          </div>
          <div className="widget-body col" style={{ padding: 16, gap: 14 }}>
            {screen.kind === 'loading' && !detail ? <p className="t-sm muted" role="status">확인 패널을 불러오는 중…</p> : null}
            {!detail && screen.kind !== 'loading' ? <p className="t-sm muted">왼쪽 목록에서 공연을 고르세요.</p> : null}
            {detail ? (
              <>
                <div className="row between wrap" style={{ gap: 8 }}>
                  <div className="col" style={{ gap: 2 }}>
                    <h3 className="t-md fw-b">{detail.title}</h3>
                    <span className="t-xs muted">{detail.promoterName} · 제출 {formatKst(detail.submittedAt)}</span>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {detail.reapproval ? <span className="badge badge-warning">재승인</span> : null}
                    <span className={`badge${detail.status === 'APPROVED' ? ' badge-success' : detail.status === 'REJECTED' || detail.status === 'SUSPENDED' ? ' badge-danger' : ' badge-primary'}`}>{statusLabel(detail.status, detail.reapproval)}</span>
                  </div>
                </div>

                {detail.rejectionReason ? (
                  <div className="banner banner-danger" role="alert">
                    <div className="banner-body">
                      <span className="banner-title">반려 사유</span>
                      {detail.rejectionReason}
                    </div>
                  </div>
                ) : null}

                <div className="divider" />
                <div className="col" style={{ gap: 8 }}>
                  <h4 className="eyebrow">판매자 정보</h4>
                  {detail.seller ? (
                    <dl className="t-sm grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2">
                      <dt className="muted">상호</dt><dd>{detail.seller.legalName || '—'}</dd>
                      <dt className="muted">대표자</dt><dd>{detail.seller.representative ?? '—'}</dd>
                      <dt className="muted">주소</dt><dd>{detail.seller.address ?? '—'}</dd>
                      <dt className="muted">전화</dt><dd>{detail.seller.phone ?? '—'}</dd>
                      <dt className="muted">전자우편</dt><dd>{detail.seller.email ?? '—'}</dd>
                      <dt className="muted">사업자등록번호</dt><dd>{detail.seller.businessRegNo ?? '—'}</dd>
                      <dt className="muted">통신판매업</dt><dd>{detail.seller.mailOrderReportNo ?? detail.seller.exemptionBasis ?? '—'}</dd>
                    </dl>
                  ) : <p className="t-sm muted">판매자 정보가 아직 없습니다.</p>}
                </div>

                <div className="divider" />
                <div className="col" style={{ gap: 8 }}>
                  <h4 className="eyebrow">공연장·휠체어석</h4>
                  <p className="t-sm">
                    {detail.placeName ?? '공연장 미정'} <span className="badge">{detail.requestedPlace ? '새 공연장 요청' : '등록된 공연장'}</span>
                  </p>
                  {detail.requestedPlace ? <p className="t-xs muted">새 공연장 연결과 아티스트·다른 이름 연결은 다음 단계입니다. 지금 승인하면 등록된 공연장 값은 그대로 둡니다.</p> : null}
                  <p className="t-sm">휠체어석 확인: {detail.accessibleSeatingCheck === true ? '파트너 확인함' : detail.accessibleSeatingCheck === false ? '확인하지 않음' : '아직 없음'}</p>
                  <p className="t-xs muted">지급대행 등록·예금주 일치: 지급대행 연동 전입니다(LCH-110).</p>
                </div>

                <div className="divider" />
                <div className="col" style={{ gap: 10 }}>
                  <h4 className="eyebrow">회차와 규모</h4>
                  <p className="t-xs muted">수요 예측과 규모는 회차마다 따로 정합니다.</p>
                  {detail.events.length === 0 ? <p className="t-sm muted">회차가 없습니다.</p> : null}
                  {detail.events.map((e) => (
                    <div key={e.eventId} className="card-flat pad col" style={{ gap: 8 }}>
                      <div className="row between wrap" style={{ gap: 8 }}>
                        <span className="t-sm">오픈 {formatKst(e.openAt)} · 시작 {formatKst(e.startsAt)}</span>
                        <span className="row" style={{ gap: 6 }}>
                          {e.status === 'CANCELLED' ? <span className="badge badge-danger">취소</span> : null}
                          <a className="link" href={`${__OPS_API_ORIGIN__}${e.demandForecastPath}`} target="_blank" rel="noreferrer">
                            수요 예측
                          </a>
                        </span>
                      </div>
                      <fieldset className="row wrap" style={{ gap: 12, border: 0, padding: 0, margin: 0 }} disabled={!write || busy} aria-label={`회차 ${e.eventId} 규모`}>
                        <legend className="sr-only">회차 규모</legend>
                        {SCALES.map((s) => (
                          <label className="check-row" key={s.value} htmlFor={`scale-${e.eventId}-${s.value}`}>
                            <input
                              className="rd"
                              type="radio"
                              id={`scale-${e.eventId}-${s.value}`}
                              name={`scale-${e.eventId}`}
                              checked={scales[e.eventId] === s.value}
                              onChange={() => setScales((prev) => ({ ...prev, [e.eventId]: s.value }))}
                            />
                            {s.label}
                          </label>
                        ))}
                      </fieldset>
                    </div>
                  ))}
                </div>

                <div className="divider" />
                <div className="col" style={{ gap: 6 }}>
                  <h4 className="eyebrow">판매 정책 미리보기(읽기 전용)</h4>
                  <pre className="t-xs" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(detail.salePolicy, null, 2)}</pre>
                </div>

                {write ? (
                  <>
                    <div className="divider" />
                    <div className="col" style={{ gap: 10 }}>
                      <div className="row wrap" style={{ gap: 8 }}>
                        <button className="btn btn-primary" type="button" disabled={busy || approvalIssues.length > 0} onClick={() => { setNotice(null); setConfirm('approve'); }} aria-describedby="sr-approve-why">
                          <i className="ic ic-check" aria-hidden="true" /> 판매 승인
                        </button>
                        <button className="btn btn-outline" type="button" disabled={busy} onClick={() => { setNotice(null); setConfirm('reject'); }}>
                          반려
                        </button>
                      </div>
                      <p className="hint" id="sr-approve-why">{approvalIssues[0] ?? '승인하면 비취소 회차의 판매를 열고 대기열 사본을 씁니다.'}</p>
                    </div>
                  </>
                ) : (
                  <p className="t-sm muted">읽기 전용입니다. 승인·반려는 operator·commander만 할 수 있습니다.</p>
                )}
              </>
            ) : null}
          </div>
        </section>
      </div>

      {confirm === 'approve' && detail ? (
        <Overlay onClose={() => setConfirm(null)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="sr-approve-t" aria-describedby="sr-approve-d" style={{ maxWidth: 480 }}>
            <h2 className="dialog-title" id="sr-approve-t">판매를 승인합니다</h2>
            <p className="t-sm" id="sr-approve-d">공연 단위로 승인하고 비취소 회차의 판매를 엽니다. 승인 뒤에는 판매 조건을 고칠 수 없습니다.</p>
            <dl className="kv card-flat pad">
              <dt>공연</dt><dd>{detail.title}</dd>
              <dt>회차</dt><dd>{detail.events.length}개</dd>
              <dt>공연장</dt><dd>{detail.placeName ?? '등록된 값 유지'}</dd>
            </dl>
            <div className="dialog-actions">
              <button className="btn btn-ghost" type="button" onClick={() => setConfirm(null)}>돌아가기</button>
              <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void run('approve')}>{busy ? '승인하는 중…' : '판매 승인'}</button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {confirm === 'reject' && detail ? (
        <Overlay onClose={() => setConfirm(null)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="sr-reject-t" aria-describedby="sr-reject-d" style={{ maxWidth: 480 }}>
            <h2 className="dialog-title" id="sr-reject-t">판매 승인을 반려합니다</h2>
            <p className="t-sm" id="sr-reject-d">사유는 파트너 화면과 감사 기록에 남습니다. 1~1,000자로 적어 주세요.</p>
            <div className="field">
              <label className="label" htmlFor="sr-reject-reason">반려 사유 <span className="opt">(필수)</span></label>
              <textarea className={`input${rejectionIssue ? ' is-error' : ''}`} id="sr-reject-reason" maxLength={1000} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
              {rejectionIssue ? <span className="error-msg" role="alert">{rejectionIssue}</span> : null}
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" type="button" onClick={() => setConfirm(null)}>닫기</button>
              <button className="btn btn-danger" type="button" disabled={busy || rejectionIssue !== null} onClick={() => void run('reject')}>{busy ? '반려하는 중…' : '반려'}</button>
            </div>
          </div>
        </Overlay>
      ) : null}
    </ReadOnlyScope>
  );
}
