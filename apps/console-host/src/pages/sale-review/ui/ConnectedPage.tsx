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
  accessibleSeatingLabel,
  canAct,
  canRead,
  demandForecastLabel,
  formatKst,
  initialScales,
  linkageBody,
  mapDemandForecast,
  mapSaleReviewDetail,
  mapSaleReviewList,
  saleReviewProblem,
  scaleChangeBody,
  scaleProblem,
  scaleRaiseIssues,
  statusLabel,
  validateApproval,
  validateLinkage,
  validateRejection,
  type DemandForecastSummary,
  type ResolvedLinkage,
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
  /** 운영자가 고른 연결 값(요청 아티스트 이름 → ID, 공연장 ID) */
  const [resolved, setResolved] = useState<ResolvedLinkage>({ artists: {}, placeId: null });
  const [artistQuery, setArtistQuery] = useState<Record<string, string>>({});
  const [artistItems, setArtistItems] = useState<Record<string, { artistId: string; name: string }[]>>({});
  const [createArtistFor, setCreateArtistFor] = useState<string | null>(null);
  const [createArtistReason, setCreateArtistReason] = useState('');
  const [placeQuery, setPlaceQuery] = useState('');
  const [placeItems, setPlaceItems] = useState<{ placeId: string; name: string; address: string }[]>([]);
  const [createPlaceOpen, setCreatePlaceOpen] = useState(false);
  const [newPlace, setNewPlace] = useState({ name: '', address: '', region: '', reason: '' });
  /** 회차별 수요 예측(SCR-048, ADR-0078). 읽지 못한 회차는 null이다 */
  const [forecasts, setForecasts] = useState<Record<string, DemandForecastSummary | null>>({});
  const [raiseFor, setRaiseFor] = useState<{ eventId: string; current: ShowScale } | null>(null);
  const [raiseScale, setRaiseScale] = useState<ShowScale | ''>('');
  const [raiseReason, setRaiseReason] = useState('');

  const write = canAct(chosen);
  const read = canRead(chosen);
  const approvalIssues = useMemo(() => (detail ? [...validateApproval(detail, scales), ...validateLinkage(detail, resolved)] : ['공연을 고르세요']), [detail, scales, resolved]);
  const selectedPlaceName = placeItems.find((p) => p.placeId === resolved.placeId)?.name ?? null;
  const isCs = chosen === 'cs_agent' || chosen === 'cs_lead';
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

  const loadForecasts = useCallback(async (eventIds: readonly string[]) => {
    if (eventIds.length === 0) {
      setForecasts({});
      return;
    }
    try {
      const [{ getOpsEventDemandForecast }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const rows = await Promise.all(
        eventIds.map(async (eventId) => {
          try {
            const r = await getOpsEventDemandForecast(eventId);
            return [eventId, mapDemandForecast(r.data)] as const;
          } catch {
            return [eventId, null] as const;
          }
        }),
      );
      setForecasts(Object.fromEntries(rows));
    } catch {
      setForecasts(Object.fromEntries(eventIds.map((id) => [id, null])));
    }
  }, []);

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
        setResolved({ artists: {}, placeId: mapped.placeId });
        void loadForecasts(mapped.events.map((e) => e.eventId));
      } else {
        setDetail(null);
        setForecasts({});
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
  }, [filter, productionId, loadForecasts]);

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

  const searchArtists = async (name: string) => {
    const q = (artistQuery[name] ?? name).trim();
    if (q === '') return;
    try {
      const [{ listOpsArtists }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await listOpsArtists({ q, limit: 20 });
      setArtistItems((prev) => ({
        ...prev,
        [name]: (r.data.items ?? []).flatMap((a) =>
          typeof a.artistId === 'string' && typeof a.name === 'string' ? [{ artistId: a.artistId, name: a.name }] : [],
        ),
      }));
    } catch (e) {
      setNotice({ tone: 'bad', text: saleReviewProblem(e).message });
    }
  };

  const chooseArtist = (name: string, artistId: string) => {
    setResolved((prev) => ({ ...prev, artists: { ...prev.artists, [name]: artistId } }));
  };

  const createArtist = async () => {
    if (createArtistFor === null) return;
    const reason = createArtistReason.trim();
    if (reason === '') {
      setNotice({ tone: 'bad', text: '새로 만들 사유를 적어 주세요.' });
      return;
    }
    try {
      const [{ createOpsArtist }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await createOpsArtist({ name: createArtistFor, reason });
      const created = { artistId: r.data.artistId, name: createArtistFor };
      setArtistItems((prev) => ({ ...prev, [createArtistFor]: [created, ...(prev[createArtistFor] ?? [])] }));
      chooseArtist(createArtistFor, created.artistId);
      setCreateArtistFor(null);
      setCreateArtistReason('');
      setNotice({ tone: 'ok', text: `아티스트 '${created.name}'를 만들고 연결했습니다.` });
    } catch (e) {
      setNotice({ tone: 'bad', text: saleReviewProblem(e).message });
    }
  };

  const searchPlaces = async () => {
    const q = placeQuery.trim() || (detail?.placeName ?? '');
    if (q === '') return;
    try {
      const [{ listOpsPlaces }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await listOpsPlaces({ q, limit: 20 });
      setPlaceItems((r.data.items ?? []).flatMap((p) =>
        typeof p.placeId === 'string' && typeof p.name === 'string' && typeof p.address === 'string'
          ? [{ placeId: p.placeId, name: p.name, address: p.address }]
          : [],
      ));
    } catch (e) {
      setNotice({ tone: 'bad', text: saleReviewProblem(e).message });
    }
  };

  const createPlace = async () => {
    const name = newPlace.name.trim();
    const address = newPlace.address.trim();
    const region = newPlace.region.trim();
    const reason = newPlace.reason.trim();
    if (name === '' || address === '' || region === '' || reason === '') {
      setNotice({ tone: 'bad', text: '공연장 이름·주소·지역·사유를 모두 적어 주세요.' });
      return;
    }
    try {
      const [{ createOpsPlace }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await createOpsPlace({ name, address, region, reason });
      const created = { placeId: r.data.placeId, name, address };
      setPlaceItems((prev) => [created, ...prev]);
      setResolved((prev) => ({ ...prev, placeId: created.placeId }));
      setCreatePlaceOpen(false);
      setNewPlace({ name: '', address: '', region: '', reason: '' });
      setNotice({ tone: 'ok', text: `공연장 '${name}'을(를) 만들고 연결했습니다.` });
    } catch (e) {
      setNotice({ tone: 'bad', text: saleReviewProblem(e).message });
    }
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
      if (kind === 'approve') await createOpsSaleReviewApproval(detail.productionId, linkageBody(detail, resolved, scales));
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

  const submitRaise = async () => {
    if (!raiseFor || busy || !write) return;
    const issues = scaleRaiseIssues(raiseFor.current, raiseScale === '' ? null : raiseScale, raiseReason);
    if (issues.length > 0 || raiseScale === '') {
      setNotice({ tone: 'bad', text: issues[0] ?? '올릴 규모를 골라 주세요' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const [{ createOpsEventScaleChange }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      await createOpsEventScaleChange(raiseFor.eventId, scaleChangeBody(raiseFor.eventId, raiseScale === 'LARGE' ? 'LARGE' : 'MEDIUM', raiseReason));
      setRaiseFor(null);
      setRaiseScale('');
      setRaiseReason('');
      setNotice({ tone: 'ok', text: '규모를 올렸습니다. 동결 달력과 CDN 한도는 서버가 다시 계산합니다.' });
      await load();
    } catch (e) {
      const problem = scaleProblem(e);
      setNotice({ tone: 'bad', text: problem.message });
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
                  <h4 className="eyebrow">아티스트 연결</h4>
                  {detail.artists.length === 0 ? <p className="t-sm muted">등록되거나 요청된 아티스트가 없습니다.</p> : null}
                  <ul className="col" style={{ gap: 8, listStyle: 'none', padding: 0, margin: 0 }}>
                    {detail.artists.map((a) => (
                      <li key={`${a.artistId ?? 'new'}:${a.name}`} className="card-flat pad col" style={{ gap: 6 }}>
                        <span className="row between wrap" style={{ gap: 6 }}>
                          <strong className="t-sm">{a.name}</strong>
                          <span className={`badge${a.artistId === null ? ' badge-warning' : ''}`}>{a.artistId === null ? '새 이름 요청' : '연결됨'}</span>
                        </span>
                        {a.artistId === null ? (
                          <>
                            <div className="row wrap" style={{ gap: 6 }}>
                              <input
                                className="input"
                                aria-label={`${a.name} 아티스트 찾기`}
                                value={artistQuery[a.name] ?? a.name}
                                disabled={!write || busy}
                                onChange={(e) => setArtistQuery((prev) => ({ ...prev, [a.name]: e.target.value }))}
                              />
                              <button className="btn btn-outline btn-sm" type="button" disabled={!write || busy} onClick={() => void searchArtists(a.name)}>찾기</button>
                            </div>
                            {(artistItems[a.name] ?? []).length > 0 ? (
                              <select
                                className="input"
                                aria-label={`${a.name} 연결할 아티스트`}
                                value={resolved.artists[a.name] ?? ''}
                                disabled={!write || busy}
                                onChange={(e) => chooseArtist(a.name, e.target.value)}
                              >
                                <option value="">기존 아티스트 고르기</option>
                                {(artistItems[a.name] ?? []).map((x) => <option key={x.artistId} value={x.artistId}>{x.name}</option>)}
                              </select>
                            ) : null}
                            <button className="btn btn-outline btn-sm" type="button" disabled={!write || busy} onClick={() => { setCreateArtistFor(a.name); setCreateArtistReason(''); setNotice(null); }}>새로 만들기</button>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="divider" />
                <div className="col" style={{ gap: 8 }}>
                  <h4 className="eyebrow">공연장·휠체어석</h4>
                  <p className="t-sm">
                    {selectedPlaceName ?? detail.placeName ?? '공연장 미정'} <span className="badge">{detail.requestedPlace ? (selectedPlaceName !== null ? '연결함' : '새 공연장 요청') : '등록된 공연장'}</span>
                  </p>
                  {detail.requestedPlace ? (
                    <>
                      <p className="t-xs muted">파트너가 요청한 새 공연장입니다. 기존 공연장을 고르거나 새로 만들어 승인과 함께 잇습니다.</p>
                      <div className="row wrap" style={{ gap: 6 }}>
                        <input
                          className="input"
                          aria-label="공연장 찾기"
                          value={placeQuery === '' ? (detail.placeName ?? '') : placeQuery}
                          disabled={!write || busy}
                          onChange={(e) => setPlaceQuery(e.target.value)}
                        />
                        <button className="btn btn-outline btn-sm" type="button" disabled={!write || busy} onClick={() => void searchPlaces()}>찾기</button>
                      </div>
                      {placeItems.length > 0 ? (
                        <select
                          className="input"
                          aria-label="연결할 공연장"
                          value={resolved.placeId ?? ''}
                          disabled={!write || busy}
                          onChange={(e) => setResolved((prev) => ({ ...prev, placeId: e.target.value === '' ? null : e.target.value }))}
                        >
                          <option value="">기존 공연장 고르기</option>
                          {placeItems.map((p) => <option key={p.placeId} value={p.placeId}>{p.name} · {p.address}</option>)}
                        </select>
                      ) : null}
                      <button
                        className="btn btn-outline btn-sm"
                        type="button"
                        disabled={!write || busy}
                        onClick={() => { setNewPlace({ name: detail.placeName ?? '', address: '', region: '', reason: '' }); setCreatePlaceOpen(true); setNotice(null); }}
                      >
                        새로 만들기
                      </button>
                    </>
                  ) : null}
                  <p className="t-sm" data-accessible-check={String(detail.accessibleSeatingCheck)}>{accessibleSeatingLabel(detail.accessibleSeating)}</p>
                  {detail.accessibleSeating?.shortfallReason ? <p className="t-xs muted">부족 이유: {detail.accessibleSeating.shortfallReason}{detail.accessibleSeating.note ? ` · ${detail.accessibleSeating.note}` : ''}</p> : null}
                </div>

                <div className="divider" />
                <div className="col" style={{ gap: 8 }}>
                  <h4 className="eyebrow">지급대행 등록</h4>
                  {detail.payoutAccount ? (
                    <dl className="t-sm grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2">
                      <dt className="muted">은행</dt><dd>{detail.payoutAccount.bankCode}</dd>
                      <dt className="muted">계좌 끝 4자리</dt><dd>{detail.payoutAccount.last4}</dd>
                      <dt className="muted">예금주 확인</dt><dd>{detail.payoutAccount.holderVerified ? '확인함' : '확인하지 못함'}</dd>
                      <dt className="muted">보류 끝</dt><dd>{formatKst(detail.payoutAccount.holdUntil)}</dd>
                    </dl>
                  ) : (
                    <p className="t-sm muted">{isCs ? 'CS 역할은 정산 계좌를 보지 않습니다.' : '정산 계좌를 읽지 못했습니다. 승인 판정은 서버가 다시 읽습니다.'}</p>
                  )}
                  {detail.pgRegistration ? (
                    <p className="t-sm">
                      토스페이먼츠 {detail.pgRegistration.tossEnabled ? '켜짐' : '꺼짐'}
                      {detail.pgRegistration.tossSellers.length > 0 ? ` (${detail.pgRegistration.tossSellers.map((s) => `${s.pgStore === 'STANDARD' ? '일반' : '에스크로'} ${s.status}`).join(', ')})` : ''}
                      {' · '}포트원 {detail.pgRegistration.portoneEnabled ? (detail.pgRegistration.portonePartnerRegistered ? '파트너 등록됨' : '파트너 미등록') : '꺼짐'}
                    </p>
                  ) : (
                    <p className="t-sm muted">지급대행 등록을 읽지 못했습니다. 승인 판정은 서버가 다시 읽습니다.</p>
                  )}
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
                          {forecasts[e.eventId]?.raiseSuggested ? <span className="badge badge-warning">규모 올리기 검토</span> : null}
                        </span>
                      </div>
                      <p className="t-xs muted">
                        수요 예측: {forecasts[e.eventId] ? demandForecastLabel(forecasts[e.eventId]!) : '읽지 못했습니다'}
                      </p>
                      <p className="t-xs muted">
                        결제사: {e.pgPrimary === 'TOSS' ? '토스페이먼츠' : e.pgPrimary === 'PORTONE' ? '포트원' : '승인 때 고정'}
                        {e.pgFallback ? ` · 대체 ${e.pgFallback === 'TOSS' ? '토스페이먼츠' : '포트원'}` : ''}
                      </p>
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
                      {detail.status === 'APPROVED' && e.status !== 'CANCELLED' && e.scale !== null && e.scale !== 'LARGE' ? (
                        <button
                          className="btn btn-outline btn-sm"
                          type="button"
                          disabled={!write || busy}
                          onClick={() => {
                            setRaiseFor({ eventId: e.eventId, current: e.scale! });
                            setRaiseScale('');
                            setRaiseReason('');
                            setNotice(null);
                          }}
                        >
                          규모 올리기
                        </button>
                      ) : null}
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
              <dt>공연장</dt><dd>{selectedPlaceName ?? detail.placeName ?? '등록된 값 유지'}</dd>
              <dt>아티스트</dt><dd>{detail.artists.map((a) => a.name).join(', ') || '—'}</dd>
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
      {createArtistFor !== null ? (
        <Overlay onClose={() => setCreateArtistFor(null)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="sr-artist-t">
            <h2 className="dialog-title" id="sr-artist-t">아티스트 새로 만들기</h2>
            <p className="t-sm">'{createArtistFor}' 이름으로 아티스트를 만들고 이 공연에 연결합니다. 사유는 감사 기록에 남습니다.</p>
            <div className="field">
              <label className="label" htmlFor="sr-artist-reason">사유 <span className="opt">(필수)</span></label>
              <textarea className="input" id="sr-artist-reason" maxLength={500} value={createArtistReason} disabled={busy} onChange={(e) => setCreateArtistReason(e.target.value)} />
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" type="button" onClick={() => setCreateArtistFor(null)}>닫기</button>
              <button className="btn btn-primary" type="button" disabled={busy || createArtistReason.trim() === ''} onClick={() => void createArtist()}>만들고 연결</button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {createPlaceOpen ? (
        <Overlay onClose={() => setCreatePlaceOpen(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="sr-place-t">
            <h2 className="dialog-title" id="sr-place-t">공연장 새로 만들기</h2>
            <p className="t-sm">파트너가 요청한 새 공연장을 만들고 이 공연에 연결합니다. 사유는 감사 기록에 남습니다.</p>
            <div className="col" style={{ gap: 10 }}>
              <div className="field">
                <label className="label" htmlFor="sr-place-name">이름</label>
                <input className="input" id="sr-place-name" maxLength={100} value={newPlace.name} disabled={busy} onChange={(e) => setNewPlace((p) => ({ ...p, name: e.target.value }))} />
              </div>
              <div className="field">
                <label className="label" htmlFor="sr-place-address">주소</label>
                <input className="input" id="sr-place-address" maxLength={200} value={newPlace.address} disabled={busy} onChange={(e) => setNewPlace((p) => ({ ...p, address: e.target.value }))} />
              </div>
              <div className="field">
                <label className="label" htmlFor="sr-place-region">지역</label>
                <input className="input" id="sr-place-region" maxLength={100} value={newPlace.region} disabled={busy} onChange={(e) => setNewPlace((p) => ({ ...p, region: e.target.value }))} />
              </div>
              <div className="field">
                <label className="label" htmlFor="sr-place-reason">사유</label>
                <textarea className="input" id="sr-place-reason" maxLength={500} value={newPlace.reason} disabled={busy} onChange={(e) => setNewPlace((p) => ({ ...p, reason: e.target.value }))} />
              </div>
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" type="button" onClick={() => setCreatePlaceOpen(false)}>닫기</button>
              <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void createPlace()}>만들고 연결</button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {raiseFor !== null ? (
        <Overlay onClose={() => setRaiseFor(null)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="sr-raise-t">
            <h2 className="dialog-title" id="sr-raise-t">회차 규모 올리기</h2>
            <p className="t-sm">승인 뒤에는 T-30분 점검 전까지 올리기만 할 수 있습니다. 대형으로 올릴 때 다른 대형 공연과 30분 안이면 서버가 거절합니다.</p>
            <div className="field">
              <label className="label" htmlFor="sr-raise-scale">올릴 규모</label>
              <select className="input" id="sr-raise-scale" value={raiseScale} disabled={busy} onChange={(e) => setRaiseScale(e.target.value as ShowScale | '')}>
                <option value="">고르기</option>
                {raiseFor.current === 'SMALL' ? <option value="MEDIUM">중형</option> : null}
                <option value="LARGE">대형</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="sr-raise-reason">사유 <span className="opt">(필수)</span></label>
              <textarea className="input" id="sr-raise-reason" maxLength={500} value={raiseReason} disabled={busy} onChange={(e) => setRaiseReason(e.target.value)} />
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" type="button" onClick={() => setRaiseFor(null)}>닫기</button>
              <button className="btn btn-primary" type="button" disabled={busy || scaleRaiseIssues(raiseFor.current, raiseScale === '' ? null : raiseScale, raiseReason).length > 0} onClick={() => void submitRaise()}>
                {busy ? '올리는 중…' : '규모 올리기'}
              </button>
            </div>
          </div>
        </Overlay>
      ) : null}
    </ReadOnlyScope>
  );
}
