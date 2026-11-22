// SCR-045 실제 경로: ops-svc CS 처리함에 연결한 화면(F-06-2 GAT-280, d5 §7.6, R-T51).
// 목록(종류·상태·기한 걸러 보기, 커서) · 상세 · 배정(나에게 배정·배정 풀기, cs_lead는 다른 담당자) · 진행 중 · 결과 메모로 해결.
// 갱신은 생성 호출(updateOpsCase)에 If-Match(판)를 싣고, 412면 다른 곳에서 먼저 고쳤다는 안내와 [다시 불러오기]를 보인다.
// 쓰던 메모는 화면 상태에만 두고 브라우저 저장소에 두지 않는다. 서버 글은 글자 노드로만 그린다. 데스크톱 배치이고 태블릿·휴대폰 배치는 GAT-340(F-05-8)이다.
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ensureConsoleApi, opsApiAvailable } from '@/shared/api';
import {
  FILTER_KINDS,
  RESULT_NOTE_MAX,
  canActOn,
  caseViewOf,
  casePageOf,
  dueBadge,
  dueText,
  errorOf,
  hasUrgent,
  ifMatchOf,
  kindLabel,
  kstText,
  noteLength,
  statusLabel,
  versionOfEtag,
  type CaseView,
} from '../model/live';
import { ViewerNotice } from './ViewerNotice';

const TITLE = 'CS 처리함';
const ops = () => import('@peaket/api-client/endpoints/ops');

interface Me {
  accountId: string;
  role: string;
}
type ListLoad = { kind: 'loading' } | { kind: 'ready'; items: CaseView[]; nextCursor: string | null } | { kind: 'error'; text: string };
type DetailLoad = { kind: 'none' } | { kind: 'loading' } | { kind: 'ready'; c: CaseView; version: number } | { kind: 'missing' } | { kind: 'error'; text: string };
interface Filter {
  kind: string;
  status: string;
  due: string;
}

const meOf = (raw: unknown): Me | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  return typeof v.adminAccountId === 'string' && typeof v.role === 'string' ? { accountId: v.adminAccountId, role: v.role } : null;
};

export function ConnectedPage() {
  const { caseId = '' } = useParams<{ caseId: string }>();
  const navigate = useNavigate();
  const [config, setConfig] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [viewer, setViewer] = useState(false);
  const [filter, setFilter] = useState<Filter>({ kind: '', status: '', due: '' });
  const [list, setList] = useState<ListLoad>({ kind: 'loading' });
  const [detail, setDetail] = useState<DetailLoad>({ kind: 'none' });
  const [note, setNote] = useState('');
  const [assignTo, setAssignTo] = useState('');
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const loadList = useCallback(async (f: Filter, cursor?: string) => {
    if (!ensureConsoleApi() || !opsApiAvailable()) {
      setConfig(false);
      return;
    }
    if (!cursor) setList({ kind: 'loading' });
    try {
      const { listOpsCases } = await ops();
      const r = await listOpsCases({
        ...(f.kind ? { kind: f.kind } : {}),
        ...(f.status === 'OPEN' || f.status === 'IN_PROGRESS' || f.status === 'RESOLVED' ? { status: f.status } : {}),
        ...(f.due !== '' ? { dueWithinDays: Number(f.due) } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 50,
      });
      const page = casePageOf(r.data);
      setList((prev) => (cursor && prev.kind === 'ready' ? { kind: 'ready', items: [...prev.items, ...page.items], nextCursor: page.nextCursor } : { kind: 'ready', ...page }));
    } catch (e) {
      const mapped = errorOf(e as never);
      if (mapped.kind === 'forbidden') setViewer(true);
      else setList({ kind: 'error', text: mapped.text });
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (!ensureConsoleApi() || !opsApiAvailable()) {
      setConfig(false);
      return;
    }
    setDetail({ kind: 'loading' });
    setStale(false);
    setNoteError(null);
    try {
      const { getOpsCase } = await ops();
      const r = await getOpsCase(id);
      const c = caseViewOf(r.data);
      const version = versionOfEtag(r.headers.get('etag')) ?? c?.version ?? null;
      if (!c || version === null) setDetail({ kind: 'error', text: '건을 읽지 못했습니다. 다시 불러와 주세요' });
      else setDetail({ kind: 'ready', c, version });
    } catch (e) {
      const mapped = errorOf(e as never);
      if (mapped.kind === 'not-found') setDetail({ kind: 'missing' });
      else if (mapped.kind === 'forbidden') setViewer(true);
      else setDetail({ kind: 'error', text: mapped.text });
    }
  }, []);

  useEffect(() => {
    if (!ensureConsoleApi() || !opsApiAvailable()) {
      setConfig(false);
      return;
    }
    void (async () => {
      try {
        const { getMyOpsAuthSession } = await ops();
        const s = meOf((await getMyOpsAuthSession()).data);
        setMe(s);
        if (s?.role === 'viewer') setViewer(true);
      } catch {
        setMe(null);
      }
    })();
  }, []);

  useEffect(() => {
    void loadList(filter);
  }, [filter, loadList]);

  useEffect(() => {
    if (caseId) void loadDetail(caseId);
    else setDetail({ kind: 'none' });
    setNote('');
    setAssignTo('');
    setNotice(null);
  }, [caseId, loadDetail]);

  /** 갱신 하나. 성공하면 상세·목록을 서버 값으로 다시 그린다 */
  const patch = async (c: CaseView, version: number, body: { assignee?: string; status?: 'IN_PROGRESS' | 'RESOLVED'; resultNote?: string }, done: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const { updateOpsCase } = await ops();
      const r = await updateOpsCase(c.caseId, body, { headers: { 'If-Match': ifMatchOf(version) } });
      const next = caseViewOf(r.data);
      const nextVersion = versionOfEtag(r.headers.get('etag')) ?? next?.version ?? null;
      if (next && nextVersion !== null) setDetail({ kind: 'ready', c: next, version: nextVersion });
      else await loadDetail(c.caseId);
      if (body.status === 'RESOLVED') setNote('');
      setNotice({ tone: 'ok', text: done });
      await loadList(filter);
    } catch (e) {
      const mapped = errorOf(e as never);
      // 먼저 고친 건: 쓰던 메모는 화면에만 남기고 다시 불러오기를 권한다(d5 §7.6 '먼저 고친 건')
      if (mapped.kind === 'stale' || mapped.kind === 'precondition-required') setStale(true);
      else if (mapped.kind === 'note-required') showNoteError(mapped.text);
      else setNotice({ tone: 'bad', text: mapped.text });
    } finally {
      setBusy(false);
    }
  };

  const showNoteError = (text: string) => {
    setNoteError(text);
    // 오류 요약으로 초점을 옮긴다(요약 안의 링크가 메모 칸으로 간다)
    requestAnimationFrame(() => summaryRef.current?.focus());
  };

  const resolve = (c: CaseView, version: number) => {
    if (note.trim() === '') {
      showNoteError('결과 메모를 적어 주세요');
      return;
    }
    if (noteLength(note) > RESULT_NOTE_MAX) {
      showNoteError('결과 메모는 2,000자까지입니다');
      return;
    }
    setNoteError(null);
    void patch(c, version, { status: 'RESOLVED', resultNote: note }, '해결로 닫았습니다');
  };

  if (!config) {
    return (
      <section className="widget" role="alert">
        <h1 className="t-xl">{TITLE}</h1>
        <p className="t-sm muted">관제 API 주소가 설정되지 않아 CS 처리함을 부를 수 없습니다. 빌드의 `PEAKET_OPS_API_ORIGIN`을 확인해 주세요.</p>
      </section>
    );
  }
  if (viewer) return <ViewerNotice />;

  const items = list.kind === 'ready' ? list.items : [];
  const selected = detail.kind === 'ready' ? detail : null;
  const role = me?.role ?? '';
  const myId = me?.accountId.toLowerCase() ?? '';

  return (
    <>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>{TITLE}</h1>
          <p className="t-sm muted">사람이 판단할 건을 기한과 함께 처리합니다. 기한은 영업일(공휴일 달력)로 세고 1영업일 전에 알립니다.</p>
        </div>
        <button className="btn btn-outline" type="button" onClick={() => void loadList(filter)} disabled={busy}>
          <i className="ic ic-refresh" aria-hidden="true" /> 새로 고침
        </button>
      </div>

      {hasUrgent(items) ? (
        <div className="banner banner-danger" role="alert">
          <div className="banner-body">
            <span className="banner-title">기한이 다가왔거나 지난 건이 있습니다</span>
            목록에서 '1영업일 안'·'기한 넘김' 배지가 붙은 건을 먼저 처리해 주세요.
          </div>
        </div>
      ) : null}

      <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
        <section className="widget" aria-labelledby="h-filter" style={{ flex: '0 0 220px' }}>
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-filter">
              걸러 보기
            </h2>
          </div>
          <div className="widget-body col" style={{ gap: 10 }}>
            <label className="field">
              <span className="field-label">종류</span>
              <select className="input" value={filter.kind} onChange={(e) => setFilter({ ...filter, kind: e.target.value })}>
                <option value="">모든 종류</option>
                {FILTER_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kindLabel(k)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">상태</span>
              <select className="input" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
                <option value="">해결 안 된 건</option>
                <option value="OPEN">열림</option>
                <option value="IN_PROGRESS">진행 중</option>
                <option value="RESOLVED">해결</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">기한</span>
              <select className="input" value={filter.due} onChange={(e) => setFilter({ ...filter, due: e.target.value })}>
                <option value="">모든 기한</option>
                <option value="0">이미 넘긴 건</option>
                <option value="1">1영업일 안</option>
                <option value="3">3영업일 안</option>
                <option value="10">10영업일 안</option>
              </select>
            </label>
          </div>
        </section>

        <section className="widget" aria-labelledby="h-list" style={{ flex: '1 1 0' }}>
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-list">
              건 목록
            </h2>
          </div>
          <div className="widget-body" style={{ gap: 10 }}>
            {list.kind === 'loading' ? <p className="t-sm muted">불러오는 중…</p> : null}
            {list.kind === 'error' ? (
              <p className="t-sm" role="alert">
                {list.text}
              </p>
            ) : null}
            {list.kind === 'ready' && items.length === 0 ? (
              <div className="state" role="status">
                <h3 className="t-lg">처리할 건이 없습니다</h3>
              </div>
            ) : null}
            {items.length > 0 ? (
              <div className="table-wrap">
                <table className="table dense">
                  <caption className="sr-only">CS 처리함 건. 기한이 이른 차례이고 기한 없는 건이 끝에 온다. 건을 누르면 상세가 열립니다</caption>
                  <thead>
                    <tr>
                      <th scope="col">종류</th>
                      <th scope="col">대상</th>
                      <th scope="col">기한</th>
                      <th scope="col">상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((c) => {
                      const badge = dueBadge(c.dueState);
                      return (
                        <tr key={c.caseId} aria-current={c.caseId === caseId ? 'true' : undefined}>
                          <td>
                            <button className="link fw-b" type="button" style={{ color: 'inherit' }} onClick={() => navigate(`/cs/inbox/${c.caseId}`)}>
                              {kindLabel(c.kind)}
                            </button>
                          </td>
                          <td className="mono t-xs">{c.targetRef}</td>
                          <td>
                            <span className={`badge badge-${badge.tone}`}>{badge.label}</span> <span className="t-xs muted">{dueText(c)}</span>
                          </td>
                          <td>{statusLabel(c.status)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
            {list.kind === 'ready' && list.nextCursor ? (
              <button className="btn btn-outline" type="button" onClick={() => void loadList(filter, list.nextCursor ?? undefined)} disabled={busy}>
                더 보기
              </button>
            ) : null}
          </div>
        </section>

        <section className="widget" aria-labelledby="h-detail" style={{ flex: '0 0 360px' }}>
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-detail">
              건 상세
            </h2>
          </div>
          <div className="widget-body col" style={{ gap: 10 }}>
            {detail.kind === 'none' ? <p className="t-sm muted">목록에서 건을 골라 주세요.</p> : null}
            {detail.kind === 'loading' ? <p className="t-sm muted">불러오는 중…</p> : null}
            {detail.kind === 'error' ? (
              <p className="t-sm" role="alert">
                {detail.text}
              </p>
            ) : null}
            {detail.kind === 'missing' ? (
              <div className="state" role="status">
                <h3 className="t-lg">없는 건입니다</h3>
                <p className="t-sm muted">접수 번호를 확인해 주세요.</p>
                <Link to="/cs/inbox" className="btn btn-outline">
                  건 목록으로
                </Link>
              </div>
            ) : null}
            {selected ? (
              <CaseDetail
                c={selected.c}
                role={role}
                myId={myId}
                busy={busy}
                stale={stale}
                note={note}
                assignTo={assignTo}
                noteError={noteError}
                notice={notice}
                summaryRef={summaryRef}
                noteRef={noteRef}
                onNote={setNote}
                onAssignTo={setAssignTo}
                onReload={() => void loadDetail(selected.c.caseId)}
                onPatch={(body, done) => void patch(selected.c, selected.version, body, done)}
                onResolve={() => resolve(selected.c, selected.version)}
              />
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}

interface CaseDetailProps {
  c: CaseView;
  role: string;
  myId: string;
  busy: boolean;
  stale: boolean;
  note: string;
  assignTo: string;
  noteError: string | null;
  notice: { tone: 'ok' | 'bad'; text: string } | null;
  summaryRef: RefObject<HTMLDivElement | null>;
  noteRef: RefObject<HTMLTextAreaElement | null>;
  onNote(v: string): void;
  onAssignTo(v: string): void;
  onReload(): void;
  onPatch(body: { assignee?: string; status?: 'IN_PROGRESS' | 'RESOLVED' }, done: string): void;
  onResolve(): void;
}

function CaseDetail(p: CaseDetailProps) {
  const { c } = p;
  const badge = dueBadge(c.dueState);
  const act = canActOn(p.role, c.kind) && c.status !== 'RESOLVED';
  const mine = c.assignee !== null && c.assignee.toLowerCase() === p.myId;
  return (
    <>
      {p.stale ? (
        <div className="banner banner-warning" role="alert">
          <div className="banner-body">
            다른 곳에서 이 건을 먼저 고쳤습니다. 다시 불러온 뒤 고쳐 주세요.{' '}
            <button className="btn btn-outline btn-sm" type="button" onClick={p.onReload}>
              다시 불러오기
            </button>
          </div>
        </div>
      ) : null}
      {p.notice ? (
        <div className={`banner ${p.notice.tone === 'ok' ? 'banner-info' : 'banner-warning'}`} role={p.notice.tone === 'ok' ? 'status' : 'alert'}>
          <div className="banner-body">{p.notice.text}</div>
        </div>
      ) : null}
      <dl className="kv">
        <dt>종류</dt>
        <dd>{kindLabel(c.kind)}</dd>
        <dt>대상</dt>
        <dd className="mono t-xs">{c.targetRef}</dd>
        <dt>세부</dt>
        <dd>{c.category || '—'}</dd>
        <dt>기한</dt>
        <dd>
          <span className={`badge badge-${badge.tone}`}>{badge.label}</span> {dueText(c)}
        </dd>
        <dt>상태</dt>
        <dd>{statusLabel(c.status)}</dd>
        <dt>담당</dt>
        <dd className="mono t-xs">{c.assignee ? (mine ? `나(${c.assignee})` : c.assignee) : '맡은 사람 없음'}</dd>
        <dt>접수</dt>
        <dd>{kstText(c.createdAt)}</dd>
        {c.resolvedAt ? (
          <>
            <dt>해결</dt>
            <dd>{kstText(c.resolvedAt)}</dd>
          </>
        ) : null}
        {c.resultNote ? (
          <>
            <dt>결과 메모</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{c.resultNote}</dd>
          </>
        ) : null}
      </dl>

      {!canActOn(p.role, c.kind) && c.status !== 'RESOLVED' ? (
        <p className="t-sm muted" role="note">
          {p.role === 'operator' || p.role === 'commander' ? '이 건은 CS 담당자가 처리합니다. operator·commander는 지급·대사·KYC 건만 처리합니다.' : '이 건을 처리할 수 있는 역할이 아닙니다.'}
        </p>
      ) : null}

      {act ? (
        <>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {!mine ? (
              <button className="btn btn-outline" type="button" disabled={p.busy || !p.myId} onClick={() => p.onPatch({ assignee: p.myId }, '나에게 배정했습니다')}>
                나에게 배정
              </button>
            ) : (
              <button className="btn btn-outline" type="button" disabled={p.busy} onClick={() => p.onPatch({ assignee: '' }, '배정을 풀었습니다')}>
                배정 풀기
              </button>
            )}
            {c.status === 'OPEN' ? (
              <button className="btn btn-outline" type="button" disabled={p.busy} onClick={() => p.onPatch({ status: 'IN_PROGRESS' }, '진행 중으로 바꿨습니다')}>
                진행 중
              </button>
            ) : null}
          </div>
          {p.role === 'cs_lead' ? (
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: '1 1 0' }}>
                <span className="field-label">다른 담당자에게 맡기기(관리 계정 ID)</span>
                <input className="input mono" value={p.assignTo} onChange={(e) => p.onAssignTo(e.target.value)} autoComplete="off" spellCheck={false} />
              </label>
              <button className="btn btn-outline" type="button" disabled={p.busy || p.assignTo.trim() === ''} onClick={() => p.onPatch({ assignee: p.assignTo.trim() }, '담당자를 맡겼습니다')}>
                맡기기
              </button>
            </div>
          ) : null}
          {p.noteError ? (
            <div className="banner banner-danger" role="alert" tabIndex={-1} ref={p.summaryRef}>
              <div className="banner-body">
                <span className="banner-title">고칠 것이 있습니다</span>
                <button className="link" type="button" onClick={() => p.noteRef.current?.focus()}>
                  {p.noteError}
                </button>
              </div>
            </div>
          ) : null}
          <label className="field">
            <span className="field-label">결과 메모(해결할 때 필수, 2,000자까지)</span>
            <textarea
              className="input"
              id="cs-result-note"
              ref={p.noteRef}
              rows={4}
              value={p.note}
              onChange={(e) => p.onNote(e.target.value)}
              aria-invalid={p.noteError ? 'true' : undefined}
              autoComplete="off"
            />
          </label>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary" type="button" disabled={p.busy} onClick={p.onResolve}>
              해결로 닫기
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
