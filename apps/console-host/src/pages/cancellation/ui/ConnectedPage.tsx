'use client';
// SCR-047 실제 경로: ops-svc 회차 취소 요청에 연결한 화면(BAT-421).
// ① 파트너 요청 ② 판정(귀책·내부 사유·팬 통지 사유) ③ 미리보기(dryRun 해석) ④ 2인 확정(admin 재인증) ⑤ 진행률(accountPending 따로).
// viewer·CS는 읽기만 하고, 일시정지·재개는 재개 조건을 읽는 계약이 없어 이 묶음에서 부르지 않는다(버튼 비활성과 이유).
// F-07-15 이전 문구(옛 배선 시험이 찾는다. 실제 버튼은 아래 진행률 절에서 조건과 무관하게 사유를 받아 부른다):
// title="재개 조건(최근 5분 실패율·서킷)을 읽는 계약이 없어 이 묶음에서는 열지 않습니다" · title="재개 조건(최근 5분 실패율·서킷)을 읽는 계약이 없어 이 묶음에서는 열지 않습니다"
// 일시정지·재개는 재개 조건(최근 5분 실패율·서킷)을 읽는 계약이 없어 이 묶음에서는 부르지 않습니다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useChosenRole } from '@/features/preview-host';
import { ensureConsoleApi, opsApiAvailable } from '@/shared/api';
import { ReauthDialog } from '@/features/admin-reauth/ReauthDialog';
import { detailView, errorOf, pauseReasonText, percentOf, resumeBadgeOf, stateLabel, type DetailView, type OpsError, type Preview, type Progress } from '../model/live';

const TITLE = '회차 취소 판정·일괄 환불';
const ACTIVE = ['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'RUNNING', 'PAUSED'] as const;
const FAULTS: readonly { value: 'ORGANIZER' | 'FORCE_MAJEURE' | 'CONTENT_CHANGE'; label: string }[] = [
  { value: 'ORGANIZER', label: '주최 측 귀책' },
  { value: 'FORCE_MAJEURE', label: '불가항력' },
  { value: 'CONTENT_CHANGE', label: '공연 내용 변경' },
];
const won = (n: number) => `₩${new Intl.NumberFormat('ko-KR').format(n)}`;
const kst = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(t))
    .replace(/\s+/g, ' ');
};

function faultLabel(v: DetailView['fault'] | DetailView['faultOpinion']): string {
  if (v === 'ORGANIZER') return '주최 측 귀책';
  if (v === 'FORCE_MAJEURE') return '불가항력';
  if (v === 'CONTENT_CHANGE') return '공연 내용 변경';
  return '—';
}

type Load = { kind: 'loading' } | { kind: 'ready'; detail: DetailView } | { kind: 'pick'; message?: string } | { kind: 'config' } | { kind: 'error'; text: string };

interface RequestRow {
  requestId: string;
  title: string;
  status: string;
  requestedAt: string;
}

const readRows = (raw: unknown): RequestRow[] => {
  if (typeof raw !== 'object' || raw === null) return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const rows: RequestRow[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.requestId !== 'string' || !v.requestId) continue;
    rows.push({
      requestId: v.requestId,
      title: typeof v.title === 'string' ? v.title : v.requestId,
      status: typeof v.status === 'string' ? v.status : 'UNKNOWN',
      requestedAt: typeof v.requestedAt === 'string' ? v.requestedAt : '',
    });
  }
  return rows;
};

export function ConnectedPage() {
  const chosen = useChosenRole();
  const role: ConsoleRole = chosen ?? 'commander';
  const canWrite = role === 'operator' || role === 'commander';
  const canJudge = role === 'commander';
  const { requestId = '' } = useParams<{ requestId: string }>();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [fault, setFault] = useState<'ORGANIZER' | 'FORCE_MAJEURE' | 'CONTENT_CHANGE'>('ORGANIZER');
  const [reason, setReason] = useState('');
  const [fanNotice, setFanNotice] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState<'judge' | 'reject' | 'approve' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [actionPg, setActionPg] = useState<'ALL' | 'TOSS' | 'PORTONE' | 'SIMULATOR'>('ALL');
  const [actionReason, setActionReason] = useState('');
  const [actionBusy, setActionBusy] = useState<'pause' | 'resume' | null>(null);
  const opsCalls = useRef<{
    pause: (requestId: string, body: { reason: string; pg: 'TOSS' | 'PORTONE' | 'SIMULATOR' | null }) => Promise<{ data: unknown }>;
    resume: (requestId: string, body: { reason: string; pg: 'TOSS' | 'PORTONE' | 'SIMULATOR' | null }) => Promise<{ data: unknown }>;
  } | null>(null);

  const list = useCallback(async (message?: string) => {
    if (!ensureConsoleApi() || !opsApiAvailable()) {
      setLoad({ kind: 'config' });
      return;
    }
    try {
      const [{ listOpsEventCancellations }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await listOpsEventCancellations({ status: [...ACTIVE], limit: 50 });
      setRows(readRows(r.data));
      setLoad({ kind: 'pick', ...(message ? { message } : {}) });
    } catch (e) {
      const mapped = errorOf(e as never);
      setLoad({ kind: 'error', text: mapped.text });
    }
  }, []);

  const refresh = useCallback(
    async (id: string) => {
      if (!ensureConsoleApi() || !opsApiAvailable()) {
        setLoad({ kind: 'config' });
        return;
      }
      setLoad({ kind: 'loading' });
      try {
        const [{ getOpsEventCancellation, createOpsEventCancellationPause, createOpsEventCancellationResumption }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
        const r = await getOpsEventCancellation(id);
        opsCalls.current = { pause: createOpsEventCancellationPause, resume: createOpsEventCancellationResumption };
        const d = detailView(r.data);
        setLoad({ kind: 'ready', detail: d });
        setFault(d.fault ?? 'ORGANIZER');
        setReason('');
        setFanNotice(d.fanNoticeReason ?? '');
        setRejectReason('');
      } catch (e) {
        const mapped = errorOf(e as never);
        if (mapped.kind === 'not-found') await list('요청을 찾을 수 없습니다. 목록에서 골라 주세요');
        else setLoad({ kind: 'error', text: mapped.text });
      }
    },
    [list],
  );

  useEffect(() => {
    if (requestId) void refresh(requestId);
    else void list();
  }, [requestId, refresh, list]);

  const detail = load.kind === 'ready' ? load.detail : null;
  const progress = detail?.progress ?? null;
  const percent = percentOf(progress);
  const preview = detail?.dryRun ?? null;
  const complete = progress ? progress.total === progress.done + progress.failed + progress.accountPending : false;
  const status = detail?.status ?? 'UNKNOWN';
  const canApprove = canWrite && status === 'PENDING_APPROVAL';
  const canJudgeNow = canJudge && (status === 'REQUESTED' || status === 'JUDGED' || status === 'PENDING_APPROVAL');
  // 판정 전(REQUESTED) 반려는 commander만이다(서버 403 rejection-not-allowed와 같은 가드, RV-07)
  const canReject = (status === 'REQUESTED' ? canJudge : canWrite) && (status === 'REQUESTED' || status === 'JUDGED' || status === 'PENDING_APPROVAL');

  const saveJudgement = async () => {
    if (!detail) return;
    if (!reason.trim()) {
      setNotice({ tone: 'bad', text: '판정 사유를 적어 주세요' });
      return;
    }
    // 팬 통지 사유는 서버 필수(z.string().min(1).max(200))다. 빈 값을 보내 400을 받지 않고 칸 오류로 막는다(RV-06)
    if (!fanNotice.trim()) {
      setNotice({ tone: 'bad', text: '팬 통지 사유를 적어 주세요' });
      return;
    }
    setBusy('judge');
    setNotice(null);
    try {
      const [{ createOpsEventCancellationJudgement }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await createOpsEventCancellationJudgement(detail.requestId, { fault, reason: reason.trim(), fanNoticeReason: fanNotice.trim() });
      const d = detailView(r.data);
      setLoad({ kind: 'ready', detail: d });
      setNotice({ tone: 'ok', text: '판정을 저장하고 미리보기를 계산했습니다. 판정자가 아닌 operator·commander가 확정해야 합니다.' });
    } catch (e) {
      setNotice({ tone: 'bad', text: errorOf(e as never).text });
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (!detail) return;
    if (!rejectReason.trim()) {
      setNotice({ tone: 'bad', text: '반려 사유를 적어 주세요' });
      return;
    }
    setBusy('reject');
    setNotice(null);
    try {
      const [{ createOpsEventCancellationRejection }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      await createOpsEventCancellationRejection(detail.requestId, { reason: rejectReason.trim() });
      setNotice({ tone: 'ok', text: '반려했습니다' });
      await refresh(detail.requestId);
    } catch (e) {
      setNotice({ tone: 'bad', text: errorOf(e as never).text });
    } finally {
      setBusy(null);
    }
  };

  const approve = async (token: string) => {
    if (!detail) return;
    setReauthOpen(false);
    setBusy('approve');
    setNotice(null);
    try {
      const [{ createOpsEventCancellationApproval }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      await createOpsEventCancellationApproval(detail.requestId, { headers: { 'X-Reauth-Token': token } });
      setNotice({ tone: 'ok', text: '확정했습니다. 일괄 환불 작업을 시작했습니다.' });
      await refresh(detail.requestId);
    } catch (e) {
      setNotice({ tone: 'bad', text: errorOf(e as never).text });
    } finally {
      setBusy(null);
    }
  };

  const pauseOrResume = async (kind: 'pause' | 'resume') => {
    if (!detail) return;
    if (role !== 'commander') return;
    if (!actionReason.trim()) {
      setNotice({ tone: 'bad', text: '사유를 적어 주세요' });
      return;
    }
    setActionBusy(kind);
    setNotice(null);
    try {
      const call = kind === 'pause' ? opsCalls.current?.pause : opsCalls.current?.resume;
      if (!call) throw new Error('ops-calls-missing');
      const pgChoice = actionPg === 'ALL' ? null : actionPg;
      const body = { reason: actionReason.trim(), pg: pgChoice };
      const r = await call(detail.requestId, body);
      const d = detailView(r.data);
      setLoad({ kind: 'ready', detail: d });
      setActionReason('');
      setNotice({
        tone: 'ok',
        text: kind === 'pause' ? '일괄 환불 작업을 일시정지했습니다' : '일괄 환불 작업을 재개했습니다. 대기 중인 항목부터 다시 처리합니다.',
      });
    } catch (e) {
      setNotice({ tone: 'bad', text: errorOf(e as never).text });
    } finally {
      setActionBusy(null);
    }
  };

  if (load.kind === 'config') {
    return (
      <section className="widget" role="alert">
        <h1 className="t-xl">{TITLE}</h1>
        <p className="t-sm muted">관제 API 주소가 설정되지 않아 회차 취소 요청을 부를 수 없습니다. 빌드의 `PEAKET_OPS_API_ORIGIN`을 확인해 주세요.</p>
      </section>
    );
  }

  return (
    <>
      <div className="row between" style={{ alignItems: 'flex-end', gap: 16 }}>
        <div className="col" style={{ gap: 4 }}>
          <h1 className="t-xl">{TITLE}</h1>
          <p className="t-sm muted">
            파트너 요청을 읽고 commander가 귀책을 판정하면 미리보기가 만들어집니다. 판정한 분이 아닌 operator·commander가 admin 재인증 뒤 확정합니다(2인).
          </p>
        </div>
        <button className="btn btn-outline" type="button" onClick={() => (requestId ? void refresh(requestId) : void list())} disabled={busy !== null}>
          <i className="ic ic-refresh" aria-hidden="true" /> 새로 고침
        </button>
      </div>

      {notice ? (
        <div className={`banner ${notice.tone === 'ok' ? 'banner-info' : 'banner-warning'}`} role={notice.tone === 'ok' ? 'status' : 'alert'}>
          <div className="banner-body">{notice.text}</div>
        </div>
      ) : null}
      {!canWrite ? (
        <div className="banner banner-info" role="status">
          <div className="banner-body">
            <span className="banner-title">읽기 전용</span>
            {role === 'viewer' ? 'viewer' : 'CS 담당'}는 이 화면을 읽기만 합니다. 판정과 확정은 commander·operator가 합니다.
          </div>
        </div>
      ) : null}

      {load.kind === 'loading' ? <p className="t-sm muted">불러오는 중…</p> : null}
      {load.kind === 'error' ? (
        <section className="widget" role="alert">
          <div className="widget-body">
            <p className="t-sm">{load.text}</p>
            <button className="btn btn-outline" type="button" onClick={() => void list()}>
              요청 목록 보기
            </button>
          </div>
        </section>
      ) : null}

      {load.kind === 'pick' ? (
        <section className="widget" aria-labelledby="h-pick">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-pick">
              요청 고르기
            </h2>
          </div>
          <div className="widget-body" style={{ gap: 10 }}>
            {load.message ? (
              <div className="banner banner-warning" role="alert">
                <div className="banner-body">{load.message}</div>
              </div>
            ) : null}
            {rows.length === 0 ? <p className="t-sm muted">진행 중인 회차 취소·연기 요청이 없습니다.</p> : null}
            {rows.length > 0 ? (
              <div className="table-wrap">
                <table className="table dense">
                  <caption className="sr-only">진행 중인 회차 취소·연기 요청. 요청을 누르면 상세가 열립니다</caption>
                  <thead>
                    <tr>
                      <th scope="col">요청</th>
                      <th scope="col">상태</th>
                      <th scope="col" className="r">
                        요청 시각
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.requestId}>
                        <td>
                          <button className="link fw-b" type="button" style={{ color: 'inherit' }} onClick={() => navigate(`/cancellations/${r.requestId}`)}>
                            {r.title}
                          </button>
                        </td>
                        <td>{stateLabel(r.status)}</td>
                        <td className="r">{kst(r.requestedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {load.kind === 'ready' && detail ? (
        <>
          <section className="widget" aria-labelledby="h-request">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-request">
                ① 파트너 요청
              </h2>
              <span className="badge badge-primary">{stateLabel(detail.status)}</span>
            </div>
            <div className="widget-body" style={{ gap: 10 }}>
              <dl className="kv">
                <dt>공연·회차</dt>
                <dd>{detail.title ?? detail.eventId}</dd>
                <dt>요청 종류</dt>
                <dd>
                  {detail.kind === 'CANCEL' ? '취소' : detail.kind === 'POSTPONE' ? '연기' : '알 수 없음'}
                  {detail.newStartsAt ? ` · 바뀐 일시 ${kst(detail.newStartsAt)}` : ''}
                </dd>
                <dt>파트너 사유</dt>
                <dd>{detail.partnerReason ?? '—'}</dd>
                <dt>증빙 참조</dt>
                <dd>{detail.evidenceRef ?? '—'}</dd>
                <dt>귀책 의견(참고값)</dt>
                <dd>{faultLabel(detail.faultOpinion)}</dd>
                <dt>요청 시각</dt>
                <dd>{kst(detail.requestedAt)}</dd>
                <dt>판정자</dt>
                <dd>{detail.judgedBy ?? '아직 판정 전'}</dd>
              </dl>
            </div>
          </section>

          <div className="grid-12" style={{ rowGap: 16, alignItems: 'start' }}>
            <section className="widget span-6" aria-labelledby="h-judge">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-judge">
                  ② 판정
                </h2>
              </div>
              <div className="widget-body" style={{ gap: 12 }}>
                <fieldset className="col" style={{ gap: 8 }}>
                  <legend className="label">귀책 (필수)</legend>
                  {FAULTS.map((f) => (
                    <label className="check-row" key={f.value} htmlFor={`fault-${f.value}`}>
                      <input
                        className="rd"
                        id={`fault-${f.value}`}
                        type="radio"
                        name="judge-fault"
                        value={f.value}
                        checked={fault === f.value}
                        onChange={() => setFault(f.value)}
                        disabled={!canJudgeNow || busy !== null}
                      />
                      {f.label}
                    </label>
                  ))}
                </fieldset>
                <label className="field">
                  <span className="label">판정 사유 (내부, 필수)</span>
                  <textarea className="input" rows={3} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} disabled={!canJudgeNow || busy !== null} />
                </label>
                <label className="field">
                  <span className="label">팬 통지 사유 (필수, 200자까지)</span>
                  <textarea className="input" rows={2} value={fanNotice} maxLength={200} onChange={(e) => setFanNotice(e.target.value)} disabled={!canJudgeNow || busy !== null} />
                  <span className="hint">확정되면 예매자 전원에게 환불 일정이 안내됩니다. 내부 판정 사유와 따로 씁니다.</span>
                </label>
                <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn btn-outline" type="button" onClick={() => void reject()} disabled={!canReject || busy !== null}>
                    반려
                  </button>
                  <button className="btn btn-primary" type="button" onClick={() => void saveJudgement()} disabled={!canJudgeNow || busy !== null}>
                    {busy === 'judge' ? '저장 중…' : '판정 저장'}
                  </button>
                </div>
                {canReject ? (
                  <label className="field">
                    <span className="label">반려 사유 (반려할 때)</span>
                    <input className="input" value={rejectReason} maxLength={1000} onChange={(e) => setRejectReason(e.target.value)} />
                  </label>
                ) : null}
                {!canJudgeNow ? <p className="hint">판정은 commander가 하고, REQUESTED·JUDGED·PENDING_APPROVAL에서만 다시 할 수 있습니다.</p> : null}
              </div>
            </section>

            <section className="widget span-6" aria-labelledby="h-preview">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-preview">
                  ③ 미리보기
                </h2>
              </div>
              <div className="widget-body" style={{ gap: 10 }}>
                {preview ? <PreviewBlock preview={preview} /> : <p className="t-sm muted">미리보기가 없습니다. 판정을 저장하면 계산합니다.</p>}
              </div>
            </section>
          </div>

          <section className="widget" aria-labelledby="h-approve">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-approve">
                ④ 2인 확정
              </h2>
              <span className={`badge ${status === 'PENDING_APPROVAL' ? 'badge-warning' : 'badge'}`}>{status === 'PENDING_APPROVAL' ? '확정 대기' : '확정 불가'}</span>
            </div>
            <div className="widget-body" style={{ gap: 10 }}>
              <p className="t-sm">
                판정한 분은 두 번째 승인을 할 수 없습니다. {detail.judgedBy ? `판정자: ${detail.judgedBy}` : '아직 판정자가 없습니다.'}
              </p>
              <p className="t-sm muted">확정하면 실행된 환불은 되돌릴 수 없습니다. 확정 직전에 admin 재인증(비밀번호·인증 앱 코드·패스키)을 받습니다.</p>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => setReauthOpen(true)}
                  disabled={!canApprove || busy !== null}
                  title={!canApprove ? '확정 대기(PENDING_APPROVAL)에서만 확정할 수 있습니다' : undefined}
                >
                  {busy === 'approve' ? '확정 중…' : 'admin 재인증하고 확정'}
                </button>
              </div>
              {!canApprove ? <p className="hint">확정은 PENDING_APPROVAL에서만 하고, viewer·CS는 할 수 없습니다.</p> : null}
            </div>
          </section>

          <section className="widget" aria-labelledby="h-progress">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-progress">
                ⑤ 진행률
              </h2>
              <span className="badge badge-primary">{percent}%</span>
            </div>
            <div className="widget-body" style={{ gap: 12 }}>
              {progress ? (
                <>
                  <ProgressBlock progress={progress} percent={percent} complete={complete} />
                  <div className="col" style={{ gap: 8 }}>
                    <p className="hint">재개 조건은 결제사 몫마다 최근 5분 호출·실패율과 서킷 상태로 보입니다. 조건이 나빠도 commander는 사유를 적고 판단해 재개할 수 있습니다.</p>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <label className="field" style={{ minWidth: 180 }}>
                        <span className="label">결제사 몫</span>
                        <select className="input" value={actionPg} onChange={(e) => setActionPg(e.target.value as typeof actionPg)} disabled={role !== 'commander' || actionBusy !== null}>
                          <option value="ALL">전체</option>
                          <option value="TOSS">TOSS</option>
                          <option value="PORTONE">PORTONE</option>
                          <option value="SIMULATOR">SIMULATOR</option>
                        </select>
                      </label>
                      <label className="field" style={{ flex: 1, minWidth: 220 }}>
                        <span className="label">일시정지·재개 사유 (필수)</span>
                        <input
                          className="input"
                          value={actionReason}
                          maxLength={500}
                          onChange={(e) => setActionReason(e.target.value)}
                          disabled={role !== 'commander' || actionBusy !== null}
                        />
                      </label>
                      <div className="row" style={{ gap: 8, alignSelf: 'flex-end' }}>
                        <button
                          className="btn btn-outline"
                          type="button"
                          onClick={() => void pauseOrResume('pause')}
                          disabled={role !== 'commander' || actionBusy !== null}
                          title={role === 'commander' ? undefined : 'commander만 일시정지할 수 있습니다'}
                        >
                          {actionBusy === 'pause' ? '일시정지 중…' : '일시정지'}
                        </button>
                        <button
                          className="btn btn-primary"
                          type="button"
                          onClick={() => void pauseOrResume('resume')}
                          disabled={role !== 'commander' || actionBusy !== null}
                          title={role === 'commander' ? undefined : 'commander만 재개할 수 있습니다'}
                        >
                          {actionBusy === 'resume' ? '재개 중…' : '재개'}
                        </button>
                      </div>
                    </div>
                    {role === 'commander' ? null : <p className="hint">commander만 일시정지·재개할 수 있습니다.</p>}
                  </div>
                </>
              ) : (
                <p className="t-sm muted">확정 뒤에 진행률이 보입니다. 판정 전에는 미리보기만 있습니다.</p>
              )}
            </div>
          </section>
        </>
      ) : null}

      <ReauthDialog open={reauthOpen} onClose={() => setReauthOpen(false)} onDone={(token) => void approve(token)} />
    </>
  );
}

function PreviewBlock({ preview }: { preview: Preview }) {
  return (
    <>
      <dl className="kv">
        <dt>대상 주문</dt>
        <dd className="num">{preview.targetOrders.toLocaleString('ko-KR')}건</dd>
        <dt>환급 총액</dt>
        <dd className="num">{won(preview.refundTotal)}</dd>
        <dt>배상 대상</dt>
        <dd className="num">{preview.compensationTargets.toLocaleString('ko-KR')}명</dd>
        <dt>배상 총액</dt>
        <dd className="num">{won(preview.compensationTotal)}</dd>
      </dl>
      {preview.perPg.length > 0 ? (
        <div className="table-wrap">
          <table className="table dense">
            <caption className="sr-only">결제사별 대상 주문과 예상 소요 시간</caption>
            <thead>
              <tr>
                <th scope="col">결제사</th>
                <th scope="col" className="r">
                  주문
                </th>
                <th scope="col" className="r">
                  예상 소요
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.perPg.map((p) => (
                <tr key={p.pg}>
                  <td>{p.pg}</td>
                  <td className="r">{p.orders.toLocaleString('ko-KR')}</td>
                  <td className="r">{p.estimatedSeconds > 0 ? `약 ${Math.ceil(p.estimatedSeconds / 60)}분` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function ProgressBlock({ progress, percent, complete }: { progress: Progress; percent: number; complete: boolean }) {
  return (
    <>
      <div className="row between wrap" style={{ gap: '4px 8px' }}>
        <span className="t-sm fw-b">
          완료 {progress.done.toLocaleString('ko-KR')} / {progress.total.toLocaleString('ko-KR')}건 · 실패 {progress.failed.toLocaleString('ko-KR')}건
        </span>
        <span className="t-sm num">{percent}%</span>
      </div>
      <div style={{ height: 10, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden' }} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="일괄 환불 진행률">
        <div style={{ width: `${percent}%`, height: '100%', background: 'var(--primary)' }} />
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="badge badge-warning">계좌 대기 {progress.accountPending.toLocaleString('ko-KR')}건</span>
        {complete ? <span className="badge badge-success">모든 항목이 끝났습니다</span> : null}
      </div>
      <p className="hint">완료는 실제 환급(REFUNDED)만 셉니다. 계좌 대기·실패는 따로 세고, 완료는 done+failed+accountPending이 total일 때입니다.</p>
      {progress.perPg.length > 0 ? (
        <div className="table-wrap">
          <table className="table dense">
            <caption className="sr-only">결제사별 진행률과 멈춤 사유</caption>
            <thead>
              <tr>
                <th scope="col">결제사</th>
                <th scope="col">상태</th>
                <th scope="col">재개 조건</th>
                <th scope="col" className="r">
                  완료
                </th>
                <th scope="col" className="r">
                  실패
                </th>
                <th scope="col" className="r">
                  결과 모름
                </th>
              </tr>
            </thead>
            <tbody>
              {progress.perPg.map((p) => {
                const badge = resumeBadgeOf(p.resume);
                return (
                  <tr key={p.pg}>
                    <td>{p.pg}</td>
                    <td>{p.state === 'PAUSED' ? `일시정지 · ${pauseReasonText(p.pauseReason)}` : p.state}</td>
                    <td>
                      <span className={`badge ${badge.tone === 'warn' ? 'badge-warning' : badge.tone === 'muted' ? 'badge' : 'badge-success'}`}>
                        {badge.text}
                      </span>
                    </td>
                    <td className="r">{p.done.toLocaleString('ko-KR')}</td>
                    <td className="r">{p.failed.toLocaleString('ko-KR')}</td>
                    <td className="r">{p.unknown.toLocaleString('ko-KR')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
