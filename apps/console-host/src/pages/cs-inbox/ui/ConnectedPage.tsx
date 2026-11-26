// SCR-045 실제 경로: ops-svc CS 처리함에 연결한 화면(F-06-2 GAT-280, d5 §7.6, R-T51).
// 목록(종류·상태·기한 걸러 보기, 커서) · 상세 · 배정(나에게 배정·배정 풀기, cs_lead는 다른 담당자) · 진행 중 · 결과 메모로 해결.
// 갱신은 생성 호출(updateOpsCase)에 If-Match(판)를 싣고, 412면 다른 곳에서 먼저 고쳤다는 안내와 [다시 불러오기]를 보인다.
// 쓰던 메모는 화면 상태에만 두고 브라우저 저장소에 두지 않는다. 서버 글은 글자 노드로만 그린다. 데스크톱 배치이고 태블릿·휴대폰 배치는 GAT-340(F-05-8)이다.
// 추가 검증 이의(F-06-7 GAT-280, B-T28 ⑦, d5 §7.6): 이의 건은 '이의 심사' 패널(appealPanelOf 값)과 [이의 인정]·[이의 기각] → 확인 대화상자 →
// 이의 결정 생성 호출(If-Match·Idempotency-Key를 싣는다)이고 [해결로 닫기]가 없다. 요청 키는 대화상자를 열 때 하나 만들고,
// 네트워크 실패·503·처리 중 뒤 다시 누르면 같은 키, 성공·그 밖 4xx 뒤에는 버린다(decisionKeyAfter). 202 뒤 상세를 다시 읽는다.
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ensureConsoleApi, opsApiAvailable } from '@/shared/api';
import {
  FILTER_KINDS,
  RESULT_NOTE_MAX,
  appealPanelOf,
  canActOn,
  canActOnCategory,
  caseViewOf,
  casePageOf,
  decisionKeyAfter,
  dueBadge,
  dueText,
  errorOf,
  hasUrgent,
  ifMatchOf,
  kindLabel,
  kstText,
  noteLength,
  reviewDetailOf,
  reviewIdOf,
  reviewModerationPlan,
  reviewPanelFor,
  statusLabel,
  verificationAppealOf,
  versionOfEtag,
  type AppealPanel,
  type CaseView,
  type ProblemLike,
  type ReviewAction,
  type ReviewDetail,
  type VerificationAppealView,
} from '../model/live';
import { ViewerNotice } from './ViewerNotice';

const TITLE = 'CS 처리함';
const ops = () => import('@peaket/api-client/endpoints/ops');

interface Me {
  accountId: string;
  role: string;
}
type ListLoad = { kind: 'loading' } | { kind: 'ready'; items: CaseView[]; nextCursor: string | null } | { kind: 'error'; text: string };
type DetailLoad = { kind: 'none' } | { kind: 'loading' } | { kind: 'ready'; c: CaseView; version: number; appeal: VerificationAppealView | null } | { kind: 'missing' } | { kind: 'error'; text: string };
type AppealOutcome = 'ACCEPTED' | 'REJECTED';
/** 이의 결정 확인 대화상자(처리 중 안내가 있으면 그 글) */
type DecisionDialog = { outcome: AppealOutcome; pending: string | null };
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
  const [dialog, setDialog] = useState<DecisionDialog | null>(null);
  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState<ReviewAction | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [reviewViolation, setReviewViolation] = useState('ABUSE');
  const [reviewEndsAt, setReviewEndsAt] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  /** 이의 결정 요청 키(대화상자를 열 때 만든다. 다시 보낼 실패 뒤에는 그대로 둔다) */
  const decisionKey = useRef<string | null>(null);

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

  const loadReview = useCallback(async (c: CaseView) => {
    const reviewId = reviewIdOf(c);
    if (!reviewId) {
      setReview(null);
      setReviewError(null);
      return;
    }
    if (!ensureConsoleApi() || !opsApiAvailable()) {
      setConfig(false);
      return;
    }
    try {
      const { getOpsReview } = await ops();
      const r = await getOpsReview(reviewId);
      setReview(reviewDetailOf(r.data));
      setReviewError(null);
    } catch {
      setReview(null);
      setReviewError('신고된 후기를 불러오지 못했습니다');
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
      else {
        setDetail({ kind: 'ready', c, version, appeal: c.kind === 'VERIFICATION_APPEAL' ? verificationAppealOf(r.data) : null });
        void loadReview(c);
      }
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
    setDialog(null);
    decisionKey.current = null;
  }, [caseId, loadDetail]);

  /** 갱신 하나. 성공하면 상세·목록을 서버 값으로 다시 그린다 */
  const patch = async (c: CaseView, version: number, body: { assignee?: string | null; status?: 'IN_PROGRESS' | 'RESOLVED'; resultNote?: string }, done: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const { updateOpsCase } = await ops();
      const r = await updateOpsCase(c.caseId, body, { headers: { 'If-Match': ifMatchOf(version) } });
      const next = caseViewOf(r.data);
      const nextVersion = versionOfEtag(r.headers.get('etag')) ?? next?.version ?? null;
      if (next && nextVersion !== null) setDetail((prev) => ({ kind: 'ready', c: next, version: nextVersion, appeal: prev.kind === 'ready' ? prev.appeal : null }));
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

  /** [이의 인정]·[이의 기각]: 메모가 없으면 대화상자를 열지 않고 오류 요약으로 간다(d5 §7.6 '이의 결정 확인') */
  const openDecision = (outcome: AppealOutcome) => {
    if (note.trim() === '') {
      showNoteError('결과 메모를 적어 주세요');
      return;
    }
    if (noteLength(note) > RESULT_NOTE_MAX) {
      showNoteError('결과 메모는 2,000자까지입니다');
      return;
    }
    setNoteError(null);
    if (decisionKey.current === null) decisionKey.current = crypto.randomUUID();
    setDialog({ outcome, pending: null });
  };

  /** 이의 결정 하나. 202 뒤 상세·목록을 다시 읽어 패널을 결과로 바꾼다 */
  const decide = async (c: CaseView, version: number, outcome: AppealOutcome) => {
    if (note.trim() === '') {
      setDialog(null);
      showNoteError('결과 메모를 적어 주세요');
      return;
    }
    const key = decisionKey.current ?? crypto.randomUUID();
    decisionKey.current = key;
    setBusy(true);
    setNotice(null);
    try {
      const { createOpsCaseVerificationAppealDecision } = await ops();
      await createOpsCaseVerificationAppealDecision(c.caseId, { outcome, resultNote: note }, { headers: { 'If-Match': ifMatchOf(version), 'Idempotency-Key': key } });
      decisionKey.current = decisionKeyAfter(key, { status: 202 });
      setDialog(null);
      setNotice({ tone: 'ok', text: outcome === 'ACCEPTED' ? '이의를 인정했습니다. 반영 상태는 아래에서 봅니다' : '이의를 기각했습니다. 반영 상태는 아래에서 봅니다' });
      await loadDetail(c.caseId);
      await loadList(filter);
    } catch (e) {
      const problemOf = e as ProblemLike | null | undefined;
      const status = typeof problemOf?.status === 'number' ? problemOf.status : 0;
      decisionKey.current = decisionKeyAfter(key, { status, ...(typeof problemOf?.type === 'string' ? { type: problemOf.type } : {}) });
      const mapped = errorOf(e as never);
      // 처리 중: 대화상자 안 안내와 [다시 불러오기]이고 같은 키를 지킨다(d5 §7.6 '이의 결정 처리 중')
      if (mapped.kind === 'in-progress') setDialog({ outcome, pending: mapped.text });
      else {
        setDialog(null);
        if (mapped.kind === 'stale' || mapped.kind === 'precondition-required') setStale(true);
        else if (mapped.kind === 'note-required') showNoteError(mapped.text);
        else setNotice({ tone: 'bad', text: mapped.text });
      }
    } finally {
      setBusy(false);
    }
  };

  const submitReviewModeration = async () => {
    if (!review || !reviewAction) return;
    const endsAt = reviewEndsAt ? new Date(`${reviewEndsAt}T23:59:59+09:00`).toISOString() : undefined;
    const plan = reviewModerationPlan({ action: reviewAction, reason: reviewReason, ...(reviewViolation ? { violation: reviewViolation } : {}), ...(endsAt ? { endsAt } : {}) }, Date.now());
    if (!plan.ok) {
      setReviewNotice(plan.message);
      return;
    }
    setReviewBusy(true);
    setReviewNotice(null);
    try {
      const { createOpsReviewModeration } = await ops();
      await createOpsReviewModeration(review.review.reviewId, plan.body as never);
      setReviewAction(null);
      setReviewReason('');
      setReviewNotice('후기를 조치했습니다');
      await loadDetail(caseId);
      await loadList(filter);
    } catch (e) {
      const status = typeof (e as ProblemLike)?.status === 'number' ? (e as ProblemLike).status : 0;
      if (status === 409) setReviewNotice('지금 상태에서는 이 조치를 할 수 없습니다');
      else if (status === 422) setReviewNotice('사유·위반 유형·기간을 확인해 주세요');
      else if (status === 403) setReviewNotice('이 조치를 할 권한이 없습니다');
      else setReviewNotice('조치하지 못했습니다. 잠시 뒤 다시 시도해 주세요');
    } finally {
      setReviewBusy(false);
    }
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
                appeal={selected.appeal}
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
                onOpenDecision={openDecision}
              />
            ) : null}
            {selected && reviewIdOf(selected.c) ? (
              <ReportedReviewPanel
                review={review}
                error={reviewError}
                role={role}
                busy={reviewBusy}
                action={reviewAction}
                reason={reviewReason}
                violation={reviewViolation}
                endsAt={reviewEndsAt}
                notice={reviewNotice}
                onAction={setReviewAction}
                onReason={setReviewReason}
                onViolation={setReviewViolation}
                onEndsAt={setReviewEndsAt}
                onSubmit={() => void submitReviewModeration()}
              />
            ) : null}
            {selected && dialog ? (
              <DecisionConfirm
                dialog={dialog}
                busy={busy}
                onConfirm={() => void decide(selected.c, selected.version, dialog.outcome)}
                onCancel={() => setDialog(null)}
                onReload={() => {
                  setDialog(null);
                  void loadDetail(selected.c.caseId);
                }}
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
  appeal: VerificationAppealView | null;
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
  onPatch(body: { assignee?: string | null; status?: 'IN_PROGRESS' | 'RESOLVED' }, done: string): void;
  onResolve(): void;
  onOpenDecision(outcome: AppealOutcome): void;
}

function CaseDetail(p: CaseDetailProps) {
  const { c } = p;
  const badge = dueBadge(c.dueState);
  // 추가 검증 이의 건은 이의 심사 패널이고 [해결로 닫기] 대신 [이의 인정]·[이의 기각]이다(CS 담당자만)
  const panel = c.kind === 'VERIFICATION_APPEAL' && p.appeal ? appealPanelOf(p.appeal, p.role, c.status) : null;
  const act = canActOn(p.role, c.kind) && c.status !== 'RESOLVED' && canActOnCategory(p.role, c.kind, c.category);
  // 맡은 사람이 있는 건을 바꾸는 것은 cs_lead다(cs_agent는 아무도 맡지 않은 건만 자기에게 맡고 자기 배정만 푼다, ADR-0364 결정 5)
  const lead = p.role === 'cs_lead';
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

      {panel ? <AppealReview panel={panel} /> : null}

      {!act && c.status !== 'RESOLVED' ? (
        <p className="t-sm muted" role="note">
          {p.role === 'operator' && canActOnCategory('commander', c.kind, c.category) && c.kind === 'APPROVAL_EXECUTION_FAILED'
            ? '이 건은 그 승인 업무를 다시 실행하는 commander가 처리합니다.'
            : p.role === 'operator' || p.role === 'commander'
              ? '이 건은 CS 담당자가 처리합니다. operator·commander는 지급·대사·KYC 건과 운영 쪽 승인 업무 실행 실패 건만 처리합니다.'
              : '이 건을 처리할 수 있는 역할이 아닙니다.'}
        </p>
      ) : null}

      {act ? (
        <>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {!mine && (c.assignee === null || lead) ? (
              <button className="btn btn-outline" type="button" disabled={p.busy || !p.myId} onClick={() => p.onPatch({ assignee: p.myId }, '나에게 배정했습니다')}>
                나에게 배정
              </button>
            ) : null}
            {mine || (lead && c.assignee !== null) ? (
              <button className="btn btn-outline" type="button" disabled={p.busy} onClick={() => p.onPatch({ assignee: null }, '배정을 풀었습니다')}>
                배정 풀기
              </button>
            ) : null}
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
            {c.kind === 'VERIFICATION_APPEAL' ? (
              panel?.canDecide ? (
                <>
                  <button className="btn btn-primary" type="button" disabled={p.busy} onClick={() => p.onOpenDecision('ACCEPTED')}>
                    이의 인정
                  </button>
                  <button className="btn btn-outline" type="button" disabled={p.busy} onClick={() => p.onOpenDecision('REJECTED')}>
                    이의 기각
                  </button>
                </>
              ) : null
            ) : (
              <button className="btn btn-primary" type="button" disabled={p.busy} onClick={p.onResolve}>
                해결로 닫기
              </button>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}

/** 이의 심사 패널(d5 §7.6 '추가 검증 이의 상세'·'이의 반영 중·반영됨'·'이의 반영 실패'). 값과 글은 appealPanelOf가 만들고 여기서는 글자 노드로만 그린다 */
function AppealReview({ panel }: { panel: AppealPanel }) {
  return (
    <section aria-labelledby="h-appeal" className="col" style={{ gap: 8 }}>
      <h3 className="t-sm fw-b" id="h-appeal">
        이의 심사
      </h3>
      {panel.banner ? (
        <div className="banner banner-danger" role="alert">
          <div className="banner-body">{panel.banner.text}</div>
        </div>
      ) : null}
      {panel.contentNotice ? (
        <p className="t-sm muted" role="status">
          {panel.contentNotice}
        </p>
      ) : null}
      {panel.text ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{panel.text}</p> : null}
      {panel.evidenceNotice ? (
        <p className="t-sm muted" role="status">
          {panel.evidenceNotice}
        </p>
      ) : null}
      <dl className="kv">
        {panel.fields.map((f) => (
          <div key={f.label} style={{ display: 'contents' }}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      {panel.decision ? (
        <dl className="kv">
          <dt>결과</dt>
          <dd>{panel.decision.outcome}</dd>
          <dt>처리자</dt>
          <dd className="mono t-xs">{panel.decision.decidedBy}</dd>
          <dt>처리 시각</dt>
          <dd>{panel.decision.decidedAt}</dd>
          {panel.decision.blockList ? (
            <>
              <dt>차단 목록 변화</dt>
              <dd>{panel.decision.blockList}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {panel.rows.length > 0 ? (
        <ul className="col" style={{ gap: 4, listStyle: 'none', padding: 0, margin: 0 }} aria-label="결과 반영 호출">
          {panel.rows.map((r) => (
            <li key={r.call} className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
              <span className="t-sm">{r.label}</span>
              <span className={`badge badge-${r.badge.tone}`}>{r.badge.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ReportedReviewPanel(p: {
  review: ReviewDetail | null;
  error: string | null;
  role: string;
  busy: boolean;
  action: ReviewAction | null;
  reason: string;
  violation: string;
  endsAt: string;
  notice: string | null;
  onAction(a: ReviewAction | null): void;
  onReason(v: string): void;
  onViolation(v: string): void;
  onEndsAt(v: string): void;
  onSubmit(): void;
}) {
  if (p.error) return <p className="t-sm" role="alert">{p.error}</p>;
  if (!p.review) return <p className="t-sm muted">후기 상세를 불러오는 중…</p>;
  const panel = reviewPanelFor(p.review, p.role);
  return (
    <section className="col" style={{ gap: 10 }} aria-labelledby="h-reviewed">
      <h3 className="t-sm fw-b" id="h-reviewed">신고된 후기</h3>
      <div className="row wrap" style={{ gap: 8 }}>
        <strong className="t-sm">{panel.authorDisplay}</strong>
        <span className="badge badge-outline">{panel.statusLabel}</span>
        {panel.rating !== null ? <span className="t-xs muted">별점 {panel.rating}점</span> : null}
      </div>
      {panel.noticeText ? <p className="t-sm muted">{panel.noticeText}</p> : null}
      <p className="t-sm" style={{ whiteSpace: 'pre-wrap' }}>{panel.body}</p>
      {panel.images.length > 0 ? (
        <ul className="row wrap" style={{ gap: 8 }} aria-label="후기 사진">
          {panel.images.map((img, i) => (
            <li key={i}>
              <img src={img.url} alt={img.alt} width={72} height={72} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8 }} />
            </li>
          ))}
        </ul>
      ) : <p className="t-xs muted">사진 없음</p>}
      <h4 className="t-xs fw-b">신고 사유</h4>
      {panel.reports.length > 0 ? (
        <ul className="col" style={{ gap: 4, paddingLeft: 16 }}>
          {panel.reports.map((r, i) => <li key={i} className="t-sm">{r.category} · {r.detail}</li>)}
        </ul>
      ) : <p className="t-xs muted">신고 내용 없음</p>}
      {panel.actions.length > 0 ? (
        <div className="row wrap" style={{ gap: 6 }} aria-label="후기 조치">
          {panel.actions.map((a) => <button key={a} className={a === 'RELEASE' ? 'btn btn-outline btn-sm' : 'btn btn-primary btn-sm'} type="button" onClick={() => p.onAction(a)}>{a === 'NO_ACTION' ? '조치 없음' : a === 'TEMP_BLOCK' ? '임시조치' : a === 'BLOCK' ? '노출 차단' : '해제'}</button>)}
        </div>
      ) : null}
      {p.action ? (
        <div className="col" style={{ gap: 6 }} role="group" aria-label="후기 조치 입력">
          {p.action === 'TEMP_BLOCK' || p.action === 'BLOCK' ? (
            <label className="field"><span className="field-label">위반 유형</span><select className="input" value={p.violation} onChange={(e) => p.onViolation(e.target.value)}><option value="ABUSE">욕설·비방</option><option value="SPAM">광고·도배</option><option value="RIGHTS">권리 침해</option><option value="ILLEGAL_FILMING">불법 촬영물</option></select></label>
          ) : null}
          {p.action === 'TEMP_BLOCK' ? <label className="field"><span className="field-label">끝나는 날</span><input className="input" type="date" value={p.endsAt} onChange={(e) => p.onEndsAt(e.target.value)} /></label> : null}
          <label className="field"><span className="field-label">사유(필수, 2,000자까지)</span><textarea className="input" rows={3} value={p.reason} onChange={(e) => p.onReason(e.target.value)} /></label>
          {p.notice ? <p className="t-sm" role="alert">{p.notice}</p> : null}
          <div className="row" style={{ gap: 6 }}><button className="btn btn-primary btn-sm" type="button" disabled={p.busy} onClick={p.onSubmit}>{p.busy ? '조치 중…' : '조치하기'}</button><button className="btn btn-ghost btn-sm" type="button" onClick={() => p.onAction(null)}>닫기</button></div>
        </div>
      ) : p.notice ? <p className="t-sm" role="alert">{p.notice}</p> : null}
    </section>
  );
}

interface DecisionConfirmProps {
  dialog: DecisionDialog;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
  onReload(): void;
}

/** 이의 결정 확인 대화상자(d5 §7.6 '이의 결정 확인'). 처음 초점은 [취소], Esc는 취소다 */
function DecisionConfirm(p: DecisionConfirmProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const accept = p.dialog.outcome === 'ACCEPTED';
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      p.onCancel();
    }
  };
  return (
    <div className="widget" role="dialog" aria-modal="true" aria-labelledby="h-decision" aria-describedby="d-decision" onKeyDown={onKeyDown}>
      <div className="widget-body col" style={{ gap: 10 }}>
        <h3 className="t-sm fw-b" id="h-decision">
          {accept ? '이의 인정' : '이의 기각'}
        </h3>
        <p className="t-sm" id="d-decision">
          {accept ? '이의를 인정할까요? 대기 순번이 돌아가고 사람 라벨이 남습니다. 판정 근거가 차단 기기 목록이면 그 기기를 목록에서 지웁니다' : '이의를 기각할까요? 이 대기 참여가 끝납니다. 계정 제재는 아닙니다'}
        </p>
        {p.dialog.pending ? (
          <div className="banner banner-warning" role="alert">
            <div className="banner-body">
              {p.dialog.pending}{' '}
              <button className="btn btn-outline btn-sm" type="button" onClick={p.onReload}>
                다시 불러오기
              </button>
            </div>
          </div>
        ) : null}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-primary" type="button" disabled={p.busy} onClick={p.onConfirm}>
            {accept ? '인정' : '기각'}
          </button>
          <button className="btn btn-outline" type="button" ref={cancelRef} onClick={p.onCancel}>
            취소
          </button>
        </div>
      </div>
    </div>
  );
}
