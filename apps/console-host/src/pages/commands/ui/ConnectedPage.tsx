// SCR-030 연결 화면: ops-svc 운영 명령 API로 목록·상세·2인 승인/거부·재시도와 감사 체크포인트를 본다(BAT-465 GAT-300·GAT-310).
// 디자인 보드(ui/Page.tsx의 BoardPage)는 ?state= 미리보기에 남기고, 실제 경로는 이 화면을 쓴다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChosenRole, usePreviewHost } from '@/features/preview-host';
import { ensureConsoleApi, opsApiAvailable } from '@/shared/api';
import {
  canApprove,
  filterCommands,
  formatKstDateTime,
  isRetryable,
  mapCommandList,
  stateLabel,
  stateTone,
  typeLabel,
  type CommandRow,
  type CommandStateValue,
  type RawCommand,
} from '../model/commands';

type Load = { kind: 'loading' } | { kind: 'ready'; items: CommandRow[]; nextCursor: string | null } | { kind: 'error'; message: string } | { kind: 'config' };
type CheckpointRow = { checkpointId: string; fromSeq: number; toSeq: number; rootHash: string; prevCheckpointHash: string; reason: string; actorRef: string; createdAt: string };
type Verification = { valid: boolean; rootValid: boolean; prevValid: boolean };

const STATES: readonly CommandStateValue[] = ['PENDING_APPROVAL', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'APPROVED', 'REJECTED', 'REVERT_PENDING', 'REVERTED', 'AUTO_EXPIRED', 'DRAFTED', 'DRY_RUN', 'ACKED'];
const TYPES = ['EVENT_CANCEL', 'SCALE_CHANGE', 'KILL_SWITCH', 'ADMISSION_PAUSE', 'ADMISSION_TARGET', 'BOT_LEVEL', 'DEGRADED_MODE', 'BLOCK_ASN_IP', 'LOBBY_BANNER', 'LOG_LEVEL', 'FEATURE_OFF', 'TAKEDOWN', 'AUTOMATION_STOP', 'PG_ASSIGN'] as const;

export function ConnectedPage() {
  const role = useChosenRole() ?? 'operator';
  const canAct = role === 'operator' || role === 'commander';
  const canCheckpoint = role === 'commander';
  usePreviewHost({ scope: { stage: 'T=0' }, control: { kind: 'ok' } }, []);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RawCommand | null>(null);
  const [stateFilter, setStateFilter] = useState<CommandStateValue | 'ALL'>('ALL');
  const [typeFilter, setTypeFilter] = useState<string | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'commands' | 'audit'>('commands');
  const [checkpoints, setCheckpoints] = useState<readonly CheckpointRow[]>([]);
  const [verifications, setVerifications] = useState<Record<string, Verification>>({});
  const [checkpointReason, setCheckpointReason] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const notify = useCallback((text: string) => {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const loadDetail = useCallback(async (commandId: string) => {
    const [{ getOpsCommand }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
    const r = await getOpsCommand(commandId);
    setDetail(r.data as RawCommand);
  }, []);

  const refresh = useCallback(async () => {
    if (!ensureConsoleApi()) {
      setLoad({ kind: 'config' });
      return;
    }
    try {
      const [{ listOpsCommands }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await listOpsCommands({ limit: 100 });
      const page = mapCommandList(r.data);
      setLoad({ kind: 'ready', ...page });
      setSelectedId((prev) => prev ?? page.items[0]?.commandId ?? null);
    } catch {
      setLoad({ kind: 'error', message: '명령 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    }
  }, []);

  const loadCheckpoints = useCallback(async () => {
    if (!ensureConsoleApi()) return;
    try {
      const [{ listOpsAuditCheckpoints }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await listOpsAuditCheckpoints({ limit: 50 });
      setCheckpoints((r.data.items ?? []) as CheckpointRow[]);
    } catch {
      notify('감사 체크포인트를 불러오지 못했습니다.');
    }
  }, [notify]);

  useEffect(() => {
    void refresh();
    const tick = setInterval(() => void refresh(), 5_000);
    return () => {
      clearInterval(tick);
      clearTimeout(toastTimer.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId).catch(() => notify('명령 상세를 불러오지 못했습니다.'));
  }, [selectedId, loadDetail, notify]);

  useEffect(() => {
    if (tab === 'audit') void loadCheckpoints();
  }, [tab, loadCheckpoints]);

  const items = load.kind === 'ready' ? load.items : [];
  const filtered = useMemo(() => filterCommands(items, { state: stateFilter, type: typeFilter, query }), [items, stateFilter, typeFilter, query]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      notify(ok);
      await refresh();
      if (selectedId) await loadDetail(selectedId);
    } catch {
      notify('처리하지 못했습니다. 권한과 명령 상태를 확인해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const approve = () =>
    act(async () => {
      const [{ createOpsCommandApproval }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      if (!detail?.commandId) throw new Error('no command');
      await createOpsCommandApproval(detail.commandId);
    }, '승인했습니다. 대상 실행 결과를 새로 고칩니다.');

  const reject = () =>
    act(async () => {
      const [{ createOpsCommandRejection }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      if (!detail?.commandId || rejectReason.trim() === '') throw new Error('no reason');
      await createOpsCommandRejection(detail.commandId, { reason: rejectReason.trim() });
      setRejectOpen(false);
      setRejectReason('');
    }, '반려했습니다.');

  const retry = () =>
    act(async () => {
      const [{ createOpsCommandRetry }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      if (!detail?.commandId) throw new Error('no command');
      await createOpsCommandRetry(detail.commandId);
    }, '다시 실행했습니다.');

  const createCheckpoint = () =>
    act(async () => {
      const [{ createOpsAuditCheckpoint }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      if (checkpointReason.trim() === '') throw new Error('no reason');
      await createOpsAuditCheckpoint({ reason: checkpointReason.trim() });
      setCheckpointReason('');
      await loadCheckpoints();
    }, '감사 체크포인트를 만들었습니다.');

  const verify = async (checkpointId: string) => {
    try {
      const [{ getOpsAuditCheckpointVerification }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await getOpsAuditCheckpointVerification(checkpointId);
      setVerifications((prev) => ({ ...prev, [checkpointId]: r.data as Verification }));
    } catch {
      notify('검증하지 못했습니다.');
    }
  };

  if (load.kind === 'config' || !opsApiAvailable()) {
    return (
      <section className="widget" role="alert">
        <h1 className="t-xl">운영 명령</h1>
        <p className="t-sm muted">관제 API 주소가 설정되지 않아 명령 목록을 부를 수 없습니다. 빌드의 `PEAKET_OPS_API_ORIGIN`을 확인해 주세요.</p>
      </section>
    );
  }

  return (
    <>
      <div className="row between" style={{ alignItems: 'flex-end', gap: 24 }}>
        <div className="col" style={{ gap: 4 }}>
          <h1 className="t-xl">운영 명령</h1>
          <p className="t-sm muted">승인된 명령의 실행 결과와 감사 체크포인트를 확인합니다. 요청자와 다른 운영자만 승인할 수 있습니다.</p>
        </div>
        <button className="btn btn-outline" type="button" onClick={() => void refresh()} disabled={busy}>
          <i className="ic ic-refresh" aria-hidden="true" /> 새로 고침
        </button>
      </div>

      <div className="tabs" style={{ marginTop: 16 }} role="tablist" aria-label="운영 명령 탭">
        <button className={tab === 'commands' ? 'tab active' : 'tab'} type="button" role="tab" aria-selected={tab === 'commands'} onClick={() => setTab('commands')}>
          명령
        </button>
        <button className={tab === 'audit' ? 'tab active' : 'tab'} type="button" role="tab" aria-selected={tab === 'audit'} onClick={() => setTab('audit')}>
          감사 체크포인트
        </button>
      </div>

      {tab === 'commands' ? (
        <div className="grid-12" style={{ rowGap: 16, alignItems: 'start', marginTop: 16 }}>
          <div className="span-5 col" style={{ gap: 16 }}>
            <section className="widget" aria-labelledby="h-cmd">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-cmd">명령 {filtered.length}건</h2>
                <div className="actions" style={{ gap: 8 }}>
                  <select aria-label="상태" value={stateFilter} onChange={(e) => setStateFilter(e.currentTarget.value as CommandStateValue | 'ALL')}>
                    <option value="ALL">전체 상태</option>
                    {STATES.map((s) => <option key={s} value={s}>{stateLabel(s)}</option>)}
                  </select>
                  <select aria-label="유형" value={typeFilter} onChange={(e) => setTypeFilter(e.currentTarget.value)}>
                    <option value="ALL">전체 유형</option>
                    {TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
                  </select>
                </div>
              </div>
              <div className="input-group input-group-sm" style={{ marginTop: 8 }}>
                <input aria-label="검색" placeholder="사유·명령 ID·유형" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
              </div>
              {load.kind === 'loading' ? <p className="t-sm muted" style={{ marginTop: 12 }}>불러오는 중…</p> : null}
              {load.kind === 'error' ? <p className="t-sm" role="alert" style={{ marginTop: 12 }}>{load.message}</p> : null}
              <ul className="col" style={{ gap: 8, marginTop: 12, listStyle: 'none', padding: 0 }}>
                {filtered.map((c) => (
                  <li key={c.commandId}>
                    <button
                      type="button"
                      className={selectedId === c.commandId ? 'btn btn-outline' : 'btn btn-ghost'}
                      style={{ width: '100%', textAlign: 'left', display: 'block', padding: 12 }}
                      onClick={() => setSelectedId(c.commandId)}
                    >
                      <span className="row between" style={{ gap: 8 }}>
                        <span className="t-sm fw-b">{typeLabel(c.type)}</span>
                        <span className={`badge badge-${stateTone(c.state)}`}>{stateLabel(c.state)}</span>
                      </span>
                      <span className="t-xs muted" style={{ display: 'block', marginTop: 4 }}>{c.reason}</span>
                      <span className="t-xs muted" style={{ display: 'block', marginTop: 4 }}>
                        {formatKstDateTime(c.createdAt)} · 시도 {c.attempts}회
                      </span>
                    </button>
                  </li>
                ))}
                {load.kind === 'ready' && filtered.length === 0 ? <li className="t-sm muted">조건에 맞는 명령이 없습니다.</li> : null}
              </ul>
            </section>
          </div>

          <div className="span-7 col" style={{ gap: 16 }}>
            <section className="widget" aria-labelledby="h-detail">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-detail">명령 상세</h2>
                {detail ? <span className={`badge badge-${stateTone(detail.state as CommandStateValue)}`}>{stateLabel(detail.state as CommandStateValue)}</span> : null}
              </div>
              {!detail ? (
                <p className="t-sm muted" style={{ marginTop: 12 }}>왼쪽에서 명령을 고르세요.</p>
              ) : (
                <div className="col" style={{ gap: 12, marginTop: 12 }}>
                  <dl className="t-sm" style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 6, margin: 0 }}>
                    <dt className="muted">명령 ID</dt><dd style={{ margin: 0 }}>{detail.commandId}</dd>
                    <dt className="muted">유형</dt><dd style={{ margin: 0 }}>{typeLabel(detail.type ?? '')}</dd>
                    <dt className="muted">사유</dt><dd style={{ margin: 0 }}>{detail.reason}</dd>
                    <dt className="muted">요청자</dt><dd style={{ margin: 0 }}>{detail.requestedBy?.displayName ?? detail.requestedBy?.adminAccountId} · {detail.requestedBy?.role}</dd>
                    <dt className="muted">시도</dt><dd style={{ margin: 0 }}>{detail.attempts ?? 0}회</dd>
                    {detail.lastError ? <><dt className="muted">마지막 실패</dt><dd style={{ margin: 0 }}>{detail.lastError}</dd></> : null}
                    {detail.executedAt ? <><dt className="muted">마지막 실행</dt><dd style={{ margin: 0 }}>{formatKstDateTime(detail.executedAt)}</dd></> : null}
                    <dt className="muted">승인자</dt><dd style={{ margin: 0 }}>{(detail.approvals ?? []).join(', ') || '—'}</dd>
                  </dl>
                  <details>
                    <summary className="t-sm fw-b">params</summary>
                    <pre className="t-xs" style={{ overflow: 'auto', maxHeight: 220, marginTop: 8 }}>{JSON.stringify(detail.params ?? {}, null, 2)}</pre>
                  </details>
                  {detail.result ? (
                    <details>
                      <summary className="t-sm fw-b">result</summary>
                      <pre className="t-xs" style={{ overflow: 'auto', maxHeight: 220, marginTop: 8 }}>{JSON.stringify(detail.result, null, 2)}</pre>
                    </details>
                  ) : null}
                  <div className="row" style={{ gap: 8 }}>
                    {detail.state === 'PENDING_APPROVAL' ? (
                      <>
                        <button className="btn btn-primary" type="button" disabled={busy || !canAct || !canApprove({ canApprove: detail.canApprove === true })} onClick={() => void approve()}>
                          승인
                        </button>
                        <button className="btn btn-outline" type="button" disabled={busy || !canAct} onClick={() => setRejectOpen(true)}>
                          반려
                        </button>
                        {detail.canApprove !== true ? <span className="t-xs muted">요청자 본인은 승인할 수 없습니다.</span> : null}
                      </>
                    ) : null}
                    {isRetryable({ state: detail.state as CommandStateValue }) ? (
                      <button className="btn btn-primary" type="button" disabled={busy || !canAct} onClick={() => void retry()}>
                        다시 시도
                      </button>
                    ) : null}
                  </div>
                  {rejectOpen ? (
                    <div className="widget" style={{ padding: 12 }}>
                      <label className="t-sm" htmlFor="reject-reason">반려 사유</label>
                      <textarea id="reject-reason" className="input" rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} />
                      <div className="row" style={{ gap: 8, marginTop: 8 }}>
                        <button className="btn btn-primary" type="button" disabled={busy || rejectReason.trim() === ''} onClick={() => void reject()}>반려 확정</button>
                        <button className="btn btn-ghost" type="button" onClick={() => setRejectOpen(false)}>취소</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </section>
          </div>
        </div>
      ) : (
        <div className="grid-12" style={{ rowGap: 16, alignItems: 'start', marginTop: 16 }}>
          <div className="span-7 col" style={{ gap: 16 }}>
            <section className="widget" aria-labelledby="h-cp">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-cp">감사 체크포인트 {checkpoints.length}건</h2>
                <button className="btn btn-outline" type="button" onClick={() => void loadCheckpoints()}>새로 고침</button>
              </div>
              <table className="table" style={{ marginTop: 12 }}>
                <thead>
                  <tr><th>만든 시각</th><th>구간</th><th>사유</th><th>검증</th></tr>
                </thead>
                <tbody>
                  {checkpoints.map((cp) => {
                    const v = verifications[cp.checkpointId];
                    return (
                      <tr key={cp.checkpointId}>
                        <td className="t-xs">{formatKstDateTime(cp.createdAt)}</td>
                        <td className="t-xs">{cp.fromSeq}–{cp.toSeq}</td>
                        <td className="t-xs">{cp.reason}</td>
                        <td>
                          <button className="btn btn-ghost" type="button" onClick={() => void verify(cp.checkpointId)}>검증</button>
                          {v ? <span className={`badge badge-${v.valid ? 'success' : 'danger'}`} style={{ marginLeft: 6 }}>{v.valid ? '통과' : '실패'}</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                  {checkpoints.length === 0 ? <tr><td colSpan={4} className="t-sm muted">체크포인트가 없습니다.</td></tr> : null}
                </tbody>
              </table>
            </section>
          </div>
          <div className="span-5 col" style={{ gap: 16 }}>
            <section className="widget" aria-labelledby="h-cp-new">
              <div className="widget-head"><h2 className="t-sm fw-b" id="h-cp-new">체크포인트 만들기</h2></div>
              <p className="t-xs muted" style={{ marginTop: 8 }}>마지막 체크포인트 뒤부터 지금 감사 체인 머리까지를 SHA-256 루트로 묶습니다. commander만 만들 수 있습니다.</p>
              <label className="t-sm" htmlFor="cp-reason">사유</label>
              <input id="cp-reason" className="input" value={checkpointReason} onChange={(e) => setCheckpointReason(e.currentTarget.value)} disabled={!canCheckpoint} />
              <button className="btn btn-primary" type="button" style={{ marginTop: 8 }} disabled={busy || !canCheckpoint || checkpointReason.trim() === ''} onClick={() => void createCheckpoint()}>
                체크포인트 만들기
              </button>
            </section>
          </div>
        </div>
      )}

      {toast ? <div className="toast" role="status" style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 20 }}>{toast}</div> : null}
    </>
  );
}
