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

  const registerPost = async () => {
    const input: ExternalPostFormInput = {
      eventId,
      url,
      capturedAt: capturedAt || new Date().toISOString(),
      source,
      ...(reportCaseId ? { reportCaseId } : {}),
      ...(claimedSeats ? { claimedSeats } : {}),
      capture: { name: 'capture.png', type: 'image/png', sizeBytes: 1024, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
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
          <div className="widget-body row wrap" style={{ gap: 12 }}>
            <span>기록 고정 {overview.snapshot ? `판 ${overview.snapshot.version}` : '전'}</span>
            <span>후보 {overview.summary.clusterCount} · 사건 {overview.summary.caseCount}</span>
            {overview.latestRun?.autoRetriesLeft ? <span>{candidateRetryText(overview.latestRun.autoRetriesLeft)}</span> : null}
            {canRerun(overview) ? <button className="btn btn-secondary btn-sm" type="button" onClick={() => void rerun()}>다시 돌리기</button> : null}
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
          <button className="btn btn-outline btn-sm" type="button" onClick={() => setRegions((r) => [...r, maskRegionOfDrag({ x: 0, y: 0 }, { x: 10, y: 10 }, { width: 100, height: 100 })!].filter(Boolean).slice(0, 20))}>가릴 자리 고르기</button>
          {['확인 1', '확인 2', '확인 3'].map((t, i) => (
            <label key={t} className="check-row"><input className="cb" type="checkbox" checked={checks[i] ?? false} onChange={(e) => setChecks((xs) => xs.map((x, j) => (j === i ? e.target.checked : x)))} />{t}</label>
          ))}
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void registerPost()}>게시물 등록</button>
        </div>
        <ul className="col" style={{ gap: 8 }}>
          {posts.map((p) => {
            const s = externalPostSummary(p);
            return <li key={String(p.postId)} className="card-flat pad">{postUrlDisplay(String(p.url))} · {s.scanLabel} · 맞은 티켓 {s.matchedTicketCount}</li>;
          })}
        </ul>
      </section>
    </div>
  );
}

export { isInvestigator };
