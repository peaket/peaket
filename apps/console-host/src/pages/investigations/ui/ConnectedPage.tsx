// F-04-15 SCR-070 부정 거래 조사 사건 목록 운영 연결(동결 로컬, LCH-310).
// 실제 조사 API만 부르고, 디자인 보드는 Page.tsx의 ?state= 미리보기에만 남긴다.
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError } from '@peaket/api-client';
import { ensureConsoleApi } from '@/shared/api';
import {
  canRerun,
  candidateRetryText,
  createCaseBody,
  externalPostFormData,
  externalPostIssues,
  externalPostSummary,
  filterCases,
  investigationsProblem,
  isInvestigator,
  mapCase,
  mapCluster,
  mapOverview,
  maskRegionOfDrag,
  postUrlDisplay,
  type CaseFilter,
  type CaseRow,
  type ClusterRow,
  type ExternalPostFormInput,
  type InvestigationsOverview,
  type MaskRegion,
} from '../model/investigations';

const TITLE = '부정 거래 조사';

export function ConnectedPage() {
  const [sp] = useSearchParams();
  const eventId = sp.get('eventId') ?? '';
  const [overview, setOverview] = useState<InvestigationsOverview | null>(null);
  const [clusters, setClusters] = useState<ClusterRow[]>([]);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [posts, setPosts] = useState<Record<string, unknown>[]>([]);
  const [filter, setFilter] = useState<CaseFilter>('ALL');
  const [screen, setScreen] = useState<'loading' | 'ready' | 'forbidden' | 'config' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('MACRO_BOT');
  const [url, setUrl] = useState('');
  const [capturedAt, setCapturedAt] = useState('');
  const [source, setSource] = useState<'REPORT' | 'MANUAL'>('MANUAL');
  const [reportCaseId, setReportCaseId] = useState('');
  const [claimedSeats, setClaimedSeats] = useState('');
  const [checks, setChecks] = useState([false, false, false]);
  const [regions, setRegions] = useState<MaskRegion[]>([]);
  const [capture, setCapture] = useState<ExternalPostFormInput['capture'] | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);
  const [maskInput, setMaskInput] = useState({ x: '', y: '', w: '', h: '' });
  const [captureUrl, setCaptureUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!ensureConsoleApi()) {
      setScreen('config');
      return;
    }
    if (!eventId) {
      setScreen('ready');
      return;
    }
    setScreen((s) => (s === 'ready' ? s : 'loading'));
    try {
      const [{ getOpsEventFraudOverview, listOpsFraudClusters, listOpsFraudCases, listOpsExternalPosts }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      const [o, cl, cs, ps] = await Promise.all([
        getOpsEventFraudOverview(eventId),
        listOpsFraudClusters({ eventId, limit: 100 }),
        listOpsFraudCases({ eventId, limit: 100 }),
        listOpsExternalPosts({ eventId, limit: 100 }),
      ]);
      setOverview(mapOverview(o.data as unknown as Record<string, unknown>, eventId));
      setClusters((cl.data.items as unknown as Record<string, unknown>[]).map(mapCluster));
      setCases((cs.data.items as unknown as Record<string, unknown>[]).map(mapCase));
      setPosts(ps.data.items as unknown as Record<string, unknown>[]);
      setScreen('ready');
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setScreen('forbidden');
      else {
        const p = investigationsProblem(e);
        setMessage(p.message);
        setScreen('error');
      }
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const createCase = async (clusterId: string) => {
    const [{ createOpsFraudCase }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
    try {
      await createOpsFraudCase(createCaseBody(clusterId, reason) as never);
      await load();
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    }
  };

  const rerun = async () => {
    const [{ createOpsEventFraudClusterRun }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
    try {
      await createOpsEventFraudClusterRun(eventId, { headers: { 'idempotency-key': crypto.randomUUID() } } as never);
      await load();
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    }
  };

  const pickCapture = async (file: File | undefined) => {
    if (!file) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const bytes = new Uint8Array(await file.arrayBuffer());
    setCapture({ name: file.name, type: file.type, sizeBytes: file.size, bytes });
    if (file.type.startsWith('image/')) {
      const u = URL.createObjectURL(file);
      setPreviewUrl(u);
      const img = new Image();
      img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight });
      img.src = u;
    } else {
      setPreviewUrl(null);
      setImageSize({ width: 0, height: 0 });
    }
  };

  const addKeyboardRegion = () => {
    const x = Number(maskInput.x);
    const y = Number(maskInput.y);
    const w = Number(maskInput.w);
    const h = Number(maskInput.h);
    if (![x, y, w, h].every(Number.isFinite) || imageSize.width <= 0 || imageSize.height <= 0) {
      setMessage('가림 좌표는 0~1 비율로 넣어 주세요');
      return;
    }
    const region = maskRegionOfDrag(
      { x: x * imageSize.width, y: y * imageSize.height },
      { x: (x + w) * imageSize.width, y: (y + h) * imageSize.height },
      imageSize,
    );
    if (!region) {
      setMessage('가로·세로가 0보다 큰 상자만 넣을 수 있습니다');
      return;
    }
    setRegions((xs) => [...xs, region].slice(0, 20));
  };

  const openCapture = async (postId: string) => {
    try {
      const [{ getOpsExternalPostCapture }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      const r = await getOpsExternalPostCapture(postId);
      if (captureUrl) URL.revokeObjectURL(captureUrl);
      setCaptureUrl(URL.createObjectURL(r.data as Blob));
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    }
  };

  const registerPost = async () => {
    if (!capture) {
      setMessage('캡처 파일을 골라 주세요');
      return;
    }
    const input: ExternalPostFormInput = {
      eventId,
      url,
      capturedAt: capturedAt || new Date().toISOString(),
      source,
      ...(reportCaseId ? { reportCaseId } : {}),
      ...(claimedSeats ? { claimedSeats } : {}),
      capture,
      maskRegions: regions,
      checks,
    };
    const issues = externalPostIssues(input);
    if (issues.length > 0) {
      setMessage(issues[0]!);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const [{ createOpsExternalPost }] = await Promise.all([import('@peaket/api-client/endpoints/investigations')]);
      const form: FormData = externalPostFormData(input);
      await createOpsExternalPost(form as never);
      setUrl('');
      setRegions([]);
      setChecks([false, false, false]);
      setCapture(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      await load();
    } catch (e) {
      setMessage(investigationsProblem(e).message);
    } finally {
      setBusy(false);
    }
  };

  if (screen === 'config') return <p className="state">관제 API 주소가 설정되지 않았습니다.</p>;
  if (screen === 'forbidden') return <p className="state">권한 없음(지정 없음)</p>;
  if (screen === 'loading') return <p className="state">불러오는 중입니다</p>;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="page-head">
        <h1>{TITLE}</h1>
        <label className="row" style={{ gap: 8 }}>
          <span className="t-xs muted">회차</span>
          <input className="input input-sm" value={eventId} readOnly aria-label="회차 ID" />
        </label>
      </div>
      {message ? <p className="banner banner-warning" role="alert">{message}</p> : null}
      {overview ? (
        <section className="widget">
          <div className="widget-body col" style={{ gap: 8 }}>
            <div className="row wrap" style={{ gap: 12 }}>
              <span>기록 고정 {overview.snapshot ? `판 ${overview.snapshot.version}` : '전'}{overview.snapshot?.late ? ' · 늦은 적재' : ''}</span>
              <span>실행 {overview.latestRun?.status ?? '없음'}{overview.latestRun?.autoRetriesLeft ? ` · ${candidateRetryText(overview.latestRun.autoRetriesLeft)}` : ''}</span>
              {canRerun(overview) ? <button className="btn btn-secondary btn-sm" type="button" onClick={() => void rerun()}>다시 돌리기</button> : null}
            </div>
            <div className="row wrap" style={{ gap: 12 }}>
              <span className="card-flat pad">후보 묶음 <strong>{overview.summary.clusterCount}</strong></span>
              <span className="card-flat pad">사건 <strong>{overview.summary.caseCount}</strong></span>
              <span className="card-flat pad">조치 표 <strong>{overview.summary.actionedTicketCount}</strong></span>
              <span className="card-flat pad">제한 계정 <strong>{overview.summary.restrictedAccountCount}</strong></span>
              <span className="card-flat pad">소명 인정 <strong>{overview.summary.appealAcceptedRatio === null ? '-' : `${Math.round(overview.summary.appealAcceptedRatio * 100)}%`}</strong></span>
            </div>
            <p className="t-sm muted">
              상태별 {Object.entries(overview.summary.byStatus).map(([k, v]) => `${k} ${v}`).join(' · ') || '없음'} · 취소 마감 {overview.cancelDeadlineAt ?? '-'} · 원천 보존 끝 {overview.sourceExpiresAt ?? '-'}
            </p>
          </div>
        </section>
      ) : null}
      <section className="widget">
        <h2 className="t-sm fw-b">후보 묶음</h2>
        <table className="table">
          <thead><tr><th>점수 범주</th><th>묶음</th><th>계정</th><th>공유 속성</th><th>사건</th></tr></thead>
          <tbody>
            {clusters.map((c) => (
              <tr key={c.clusterId}>
                <td>{c.scoreBand}</td>
                <td className="mono t-xs">{c.clusterId}</td>
                <td>{c.accountCount}</td>
                <td>{c.sharedAttributes.join('·') || '없음'}</td>
                <td>{c.caseId ? <Link to={`/investigations/${c.caseId}`}>{c.caseId}</Link> : <button className="btn btn-secondary btn-sm" type="button" onClick={() => void createCase(c.clusterId)}>사건 만들기</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="widget">
        <h2 className="t-sm fw-b">사건</h2>
        <select className="input input-sm" value={filter} onChange={(e) => setFilter(e.target.value as CaseFilter)} aria-label="사건 상태">
          {['ALL', 'INVESTIGATING', 'APPEAL_PENDING', 'DECISION_PENDING', 'OBJECTED', 'ACTIONED', 'CLEARED'].map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <table className="table">
          <tbody>
            {filterCases(cases, filter).map((c) => (
              <tr key={c.caseId}><td><Link to={`/investigations/${c.caseId}`}>{c.caseId}</Link></td><td>{c.status}</td><td>{c.accountCount}계정 · {c.ticketCount}장</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="widget">
        <h2 className="t-sm fw-b">외부 게시물</h2>
        <div className="col" style={{ gap: 8 }}>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" aria-label="게시물 주소" />
          <span className="hint">http·https 주소만 받습니다. 주소는 누르는 링크로 만들지 않습니다.</span>
          <input className="input" type="datetime-local" value={capturedAt} onChange={(e) => setCapturedAt(e.target.value)} aria-label="수집 시각" />
          <select className="input" value={source} onChange={(e) => setSource(e.target.value as 'REPORT' | 'MANUAL')} aria-label="출처">
            <option value="MANUAL">직접 찾음</option>
            <option value="REPORT">신고(CS 처리함 건)</option>
          </select>
          {source === 'REPORT' ? <input className="input" value={reportCaseId} onChange={(e) => setReportCaseId(e.target.value)} aria-label="신고 CS 처리함 건" /> : null}
          <textarea className="textarea" value={claimedSeats} onChange={(e) => setClaimedSeats(e.target.value)} aria-label="게시물이 말하는 좌석" />
          <input className="input" type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => void pickCapture(e.target.files?.[0])} aria-label="캡처 파일" />
          {previewUrl ? (
            <div
              className="capture-preview"
              style={{ position: 'relative', display: 'inline-block' }}
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setDragStart({ x: e.clientX - r.left, y: e.clientY - r.top });
                setDragCurrent({ x: e.clientX - r.left, y: e.clientY - r.top });
              }}
              onPointerMove={(e) => {
                if (!dragStart) return;
                const r = e.currentTarget.getBoundingClientRect();
                setDragCurrent({ x: e.clientX - r.left, y: e.clientY - r.top });
              }}
              onPointerUp={(e) => {
                if (!dragStart) return;
                const r = e.currentTarget.getBoundingClientRect();
                const region = maskRegionOfDrag(dragStart, { x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height });
                if (region) setRegions((xs) => [...xs, region].slice(0, 20));
                setDragStart(null);
                setDragCurrent(null);
              }}
            >
              <img src={previewUrl} alt="캡처 미리보기" style={{ maxWidth: 480 }} />
              {dragStart && dragCurrent ? (
                <span
                  style={{
                    position: 'absolute',
                    left: Math.min(dragStart.x, dragCurrent.x),
                    top: Math.min(dragStart.y, dragCurrent.y),
                    width: Math.abs(dragCurrent.x - dragStart.x),
                    height: Math.abs(dragCurrent.y - dragStart.y),
                    border: '2px solid #d33',
                    pointerEvents: 'none',
                  }}
                />
              ) : null}
            </div>
          ) : null}
          <div className="row wrap" style={{ gap: 6 }}>
            {(['x', 'y', 'w', 'h'] as const).map((k) => (
              <input key={k} className="input input-sm" value={maskInput[k]} onChange={(e) => setMaskInput((v) => ({ ...v, [k]: e.target.value }))} placeholder={k} aria-label={`가림 ${k}`} />
            ))}
            <button className="btn btn-outline btn-sm" type="button" onClick={addKeyboardRegion}>좌표로 가리기</button>
          </div>
          <span className="t-xs muted">가린 자리 {regions.length}개 · 캡처 위를 끌어 상자를 그리거나 0~1 좌표를 넣습니다.</span>
          {['확인 1', '확인 2', '확인 3'].map((t, i) => (
            <label key={t} className="check-row"><input className="cb" type="checkbox" checked={checks[i] ?? false} onChange={(e) => setChecks((xs) => xs.map((x, j) => (j === i ? e.target.checked : x)))} />{t}</label>
          ))}
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void registerPost()}>게시물 등록</button>
        </div>
        <ul className="col" style={{ gap: 8 }}>
          {posts.map((p) => {
            const s = externalPostSummary(p);
            return (
              <li key={String(p.postId)} className="card-flat pad col" style={{ gap: 4 }}>
                <span>{postUrlDisplay(String(p.url))} · {s.scanLabel} · 맞은 티켓 {s.matchedTicketCount}</span>
                {s.viewAvailable ? <button className="btn btn-ghost btn-sm" type="button" onClick={() => void openCapture(String(p.postId))}>보기</button> : null}
              </li>
            );
          })}
        </ul>
        {captureUrl ? <img src={captureUrl} alt="게시물 보기용 사본" style={{ maxWidth: 480 }} /> : null}
      </section>
    </div>
  );
}

export { isInvestigator };
