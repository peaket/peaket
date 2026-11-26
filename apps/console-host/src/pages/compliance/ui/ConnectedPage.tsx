// SCR-032 법정 조치 통보 탭의 실제 서버 연결 화면(F-07-11, d5 §7.5, openapi /v1/ops/compliance/notices*).
// 기관 이름·요약·사유·후기 ID만 글자 노드로 그린다(신고자·작성자 계정·주문·팬 이름은 모델에서 버린다).
// 쓰기 세 가지(등록·차단·철회)는 Idempotency-Key를 UUID v4로 만들고, 같은 입력을 다시 보내면 같은 키를 쓴다.
// 409·503은 까닭을 보이고 상세·목록을 다시 읽는다. 자료 요청·보안 사고·접속기록 점검은 이번 범위 밖이다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@peaket/api-client';
import { useChosenRole } from '@/features/preview-host';
import { ensureConsoleApi } from '@/shared/api';
import {
  NOTICE_REASON_MAX,
  noticeActionLabel,
  noticeActionPlan,
  noticeActionsFor,
  noticeCreatePlan,
  noticeDetailOf,
  noticeFilterOf,
  noticeRequesterLabel,
  noticeStatusLabel,
  noticeViewOf,
  type NoticeAction,
  type NoticeCreateForm,
  type NoticeFilter,
  type NoticeStatus,
  type NoticeView,
} from '../model/notice';

const REASON_MAX = 2_000;
const EMPTY_FORM: NoticeCreateForm = { requester: 'AGENCY', agencyName: '', receivedAt: '', deadline: 'H24', reviewIds: '', summary: '' };

type ListLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; items: NoticeView[]; nextCursor: string | null }
  | { kind: 'error'; message: string };

interface ActionDraft {
  readonly notice: NoticeView;
  readonly action: NoticeAction;
  readonly reason: string;
}

const errorText = (e: unknown): string => {
  if (e instanceof ApiError) return e.status === 403 ? '이 역할은 통보를 볼 수 없습니다.' : (e.title ?? `요청을 처리하지 못했습니다(${e.status}).`);
  return e instanceof Error ? e.message : '요청을 처리하지 못했습니다.';
};

export function ConnectedPage() {
  const role = useChosenRole();
  const [filter, setFilter] = useState<NoticeFilter>(() => noticeFilterOf(''));
  const [list, setList] = useState<ListLoad>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<NoticeView | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<NoticeCreateForm>(EMPTY_FORM);
  const [draft, setDraft] = useState<ActionDraft | null>(null);
  /** 같은 입력의 재시도는 같은 키를 쓴다. 입력이 바뀌면 새 키다 */
  const createKey = useRef<{ signature: string; key: string } | null>(null);
  const actionKey = useRef<{ signature: string; key: string } | null>(null);

  const loadList = useCallback(async (target: NoticeFilter = filter): Promise<void> => {
    setList({ kind: 'loading' });
    if (!ensureConsoleApi()) {
      setList({ kind: 'error', message: '운영 API 주소가 설정되지 않았습니다.' });
      return;
    }
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      const res = await ops.listOpsComplianceNotices({
        ...(target.status ? { status: target.status } : {}),
        sort: target.sort,
        limit: target.limit,
        ...(target.cursor ? { cursor: target.cursor } : {}),
      });
      const body = res.data as unknown as { items?: Record<string, unknown>[]; nextCursor?: string | null };
      setList({ kind: 'ready', items: (body.items ?? []).map(noticeViewOf), nextCursor: body.nextCursor ?? null });
    } catch (e) {
      setList({ kind: 'error', message: errorText(e) });
    }
  }, [filter]);

  const loadDetail = useCallback(async (noticeId: string): Promise<void> => {
    if (!ensureConsoleApi()) return;
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      const res = await ops.getOpsComplianceNotice(noticeId);
      setDetail(noticeDetailOf(res.data as unknown as Record<string, unknown>));
      setDetailError(null);
    } catch (e) {
      setDetail(null);
      setDetailError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void loadList(filter);
  }, [filter, loadList]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const reloadAfterConflict = useCallback(async (noticeId: string): Promise<void> => {
    await loadList();
    await loadDetail(noticeId);
  }, [loadList, loadDetail]);

  const submitCreate = async (): Promise<void> => {
    const plan = noticeCreatePlan(form);
    if (!plan.ok) {
      setMessage(plan.errors.join(' '));
      return;
    }
    const signature = JSON.stringify(plan.body);
    if (createKey.current?.signature !== signature) createKey.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      await ops.createOpsComplianceNotice(plan.body, { headers: { 'Idempotency-Key': createKey.current.key } });
      createKey.current = null;
      setForm(EMPTY_FORM);
      setCreateOpen(false);
      setMessage('통보를 접수했습니다. 차단은 상세에서 확인한 뒤 실행합니다.');
      await loadList();
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setMessage('통보를 저장하지 못했습니다(503). 같은 키로 다시 보낼 수 있습니다.');
      else if (e instanceof ApiError && e.status === 409) {
        setMessage('다른 곳에서 먼저 바뀌었습니다(409). 목록을 다시 읽었습니다.');
        await loadList();
      } else setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const openAction = (notice: NoticeView, action: NoticeAction): void => {
    actionKey.current = null;
    setDraft({ notice, action, reason: '' });
    setMessage(null);
  };

  const submitAction = async (): Promise<void> => {
    if (!draft) return;
    const signature = `${draft.notice.noticeId}:${draft.action}:${draft.reason.trim()}`;
    if (actionKey.current?.signature !== signature) actionKey.current = { signature, key: crypto.randomUUID() };
    const plan = noticeActionPlan(draft.reason, actionKey.current.key);
    if (!plan.ok) {
      setMessage(plan.errors.join(' '));
      return;
    }
    setBusy(true);
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      if (draft.action === 'TAKEDOWN') await ops.createOpsComplianceNoticeTakedown(draft.notice.noticeId, plan.body, { headers: plan.headers });
      else await ops.createOpsComplianceNoticeWithdrawal(draft.notice.noticeId, plan.body, { headers: plan.headers });
      actionKey.current = null;
      setDraft(null);
      setMessage(draft.action === 'TAKEDOWN' ? '후기를 차단했습니다.' : '통보를 철회하고 가림을 되살렸습니다.');
      await reloadAfterConflict(draft.notice.noticeId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setMessage('지금 상태에서는 할 수 없습니다(409). 최신 상태를 다시 읽었습니다.');
        actionKey.current = null;
        setDraft(null);
        await reloadAfterConflict(draft.notice.noticeId);
      } else if (e instanceof ApiError && e.status === 503) {
        setMessage('core-svc 통보 경로에 닿지 못했습니다(503). 같은 키로 다시 시도할 수 있습니다.');
        await reloadAfterConflict(draft.notice.noticeId);
      } else setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const actions = detail ? noticeActionsFor(detail, role) : [];
  const changeFilter = (status: NoticeStatus | undefined): void => setFilter({ ...noticeFilterOf(''), ...(status ? { status } : {}), sort: filter.sort, limit: 50 });

  return (
    <main className="cs-main" id="main">
      <div className="page-head">
        <div className="col" style={{ gap: 4, maxWidth: 760 }}>
          <h1 className="t-xl fw-b">법정 조치</h1>
          <p className="t-sm muted">신고기관·수사기관의 통보를 접수하고, 법정 기한 안에 노출을 차단하거나 철회합니다. CS는 요약만 보고, operator·commander가 원문과 조치를 봅니다.</p>
        </div>
        <div className="row gap-2">
          <button className="btn btn-outline btn-sm" type="button" disabled={busy} onClick={() => void loadList()}>
            새로 읽기
          </button>
          {role === 'operator' || role === 'commander' ? (
            <button className="btn btn-primary btn-sm" type="button" onClick={() => setCreateOpen(true)}>
              통보 접수
            </button>
          ) : null}
        </div>
      </div>

      {message ? <p className="notice" role="status">{message}</p> : null}

      <div className="row wrap gap-4" style={{ alignItems: 'flex-start' }}>
        <section className="widget" aria-labelledby="notice-list-title" style={{ flex: '1 1 420px' }}>
          <div className="widget-head row gap-2 wrap" id="notice-list-title">
            <h2 className="t-md fw-b">통보 목록</h2>
            <label className="row gap-1 t-xs">
              상태
              <select
                className="input"
                value={filter.status ?? ''}
                onChange={(e) => changeFilter((e.target.value || undefined) as NoticeStatus | undefined)}
              >
                <option value="">전체</option>
                <option value="OPEN">접수</option>
                <option value="TAKEN_DOWN">차단함</option>
                <option value="WITHDRAWN">철회함</option>
              </select>
            </label>
          </div>
          <div className="widget-body col" style={{ gap: 8 }}>
            {list.kind === 'loading' ? <p className="t-sm muted">불러오는 중입니다.</p> : null}
            {list.kind === 'error' ? <p className="t-sm" role="alert">{list.message}</p> : null}
            {list.kind === 'ready' && list.items.length === 0 ? <p className="t-sm muted">조건에 맞는 통보가 없습니다.</p> : null}
            {list.kind === 'ready'
              ? list.items.map((n) => (
                  <button
                    key={n.noticeId}
                    type="button"
                    className={`card-flat col gap-1${selectedId === n.noticeId ? ' is-selected' : ''}`}
                    onClick={() => setSelectedId(n.noticeId)}
                    style={{ textAlign: 'left' }}
                  >
                    <span className="row gap-2 wrap">
                      <span className="badge">{noticeRequesterLabel(n.requester)}</span>
                      <span className="badge badge-outline">{noticeStatusLabel(n.status)}</span>
                    </span>
                    <span className="t-sm fw-b">{n.agencyName}</span>
                    <span className="t-xs muted">처리 기한 {n.dueAt}</span>
                  </button>
                ))
              : null}
            {list.kind === 'ready' && list.nextCursor ? (
              <button className="btn btn-outline btn-sm" type="button" onClick={() => void loadList({ ...filter, cursor: list.nextCursor ?? undefined })}>
                더 보기
              </button>
            ) : null}
          </div>
        </section>

        <section className="widget" aria-labelledby="notice-detail-title" style={{ flex: '1 1 480px' }}>
          <div className="widget-head">
            <h2 className="t-md fw-b" id="notice-detail-title">통보 상세</h2>
          </div>
          <div className="widget-body col" style={{ gap: 10 }}>
            {detailError ? <p className="t-sm" role="alert">{detailError}</p> : null}
            {!selectedId ? <p className="t-sm muted">왼쪽에서 통보를 고르세요.</p> : null}
            {detail ? (
              <>
                <div className="row gap-2 wrap">
                  <span className="badge">{noticeRequesterLabel(detail.requester)}</span>
                  <span className="badge badge-outline">{noticeStatusLabel(detail.status)}</span>
                  {detail.deadline ? <span className="badge badge-outline">{detail.deadline === 'H10' ? '고시 10시간' : '24시간'}</span> : null}
                </div>
                <dl className="col gap-1">
                  <dt className="t-xs muted">기관</dt>
                  <dd className="t-sm">{detail.agencyName}</dd>
                  <dt className="t-xs muted">접수 시각</dt>
                  <dd className="t-sm">{detail.receivedAt ?? '요약 보기에서는 숨김'}</dd>
                  <dt className="t-xs muted">처리 기한</dt>
                  <dd className="t-sm">{detail.dueAt}</dd>
                  <dt className="t-xs muted">요약</dt>
                  <dd className="t-sm">{detail.summary ?? '요약 보기에서는 숨김'}</dd>
                  <dt className="t-xs muted">후기 ID</dt>
                  <dd className="t-sm">{(detail.reviewIds ?? []).join(', ') || '요약 보기에서는 숨김'}</dd>
                </dl>
                {actions.length > 0 ? (
                  <div className="row gap-2 wrap">
                    {actions.map((a) => (
                      <button key={a} className={a === 'TAKEDOWN' ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'} type="button" disabled={busy} onClick={() => openAction(detail, a)}>
                        {noticeActionLabel(a)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </section>
      </div>

      <aside className="widget" aria-labelledby="notice-out-scope">
        <div className="widget-head">
          <h2 className="t-md fw-b" id="notice-out-scope">이번 범위 밖</h2>
        </div>
        <div className="widget-body">
          <p className="t-sm muted">자료 요청, 보안 사고, 접속기록 점검은 이번 묶음 범위 밖입니다. 해당 탭은 다음 묶음에서 연결합니다.</p>
        </div>
      </aside>

      {createOpen ? (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="notice-create-title">
          <div className="modal col gap-3">
            <h2 className="t-md fw-b" id="notice-create-title">통보 접수</h2>
            <label className="col gap-1 t-sm">
              접수 기관
              <select className="input" value={form.requester} onChange={(e) => setForm({ ...form, requester: e.target.value })}>
                <option value="AGENCY">신고기관</option>
                <option value="POLICE">수사기관</option>
              </select>
            </label>
            <label className="col gap-1 t-sm">
              기관 이름
              <input className="input" maxLength={100} value={form.agencyName} onChange={(e) => setForm({ ...form, agencyName: e.target.value })} />
            </label>
            <label className="col gap-1 t-sm">
              접수 시각
              <input className="input" type="datetime-local" value={form.receivedAt} onChange={(e) => setForm({ ...form, receivedAt: e.target.value })} />
            </label>
            <label className="col gap-1 t-sm">
              처리 기한
              <select className="input" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })}>
                <option value="H24">24시간</option>
                <option value="H10">고시 10시간</option>
              </select>
            </label>
            <label className="col gap-1 t-sm">
              후기 ID(쉼표·줄바꿈으로 구분, 100개까지)
              <textarea className="input" rows={3} value={form.reviewIds} onChange={(e) => setForm({ ...form, reviewIds: e.target.value })} />
            </label>
            <label className="col gap-1 t-sm">
              요약({REASON_MAX.toLocaleString('ko-KR')}자까지)
              <textarea className="input" rows={4} maxLength={REASON_MAX} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
            </label>
            <div className="row gap-2">
              <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void submitCreate()}>
                접수하기
              </button>
              <button className="btn btn-outline btn-sm" type="button" disabled={busy} onClick={() => setCreateOpen(false)}>
                취소
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {draft ? (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="notice-action-title">
          <div className="modal col gap-3">
            <h2 className="t-md fw-b" id="notice-action-title">{noticeActionLabel(draft.action)} 확인</h2>
            <p className="t-sm">기관 {draft.notice.agencyName}의 통보입니다. 확인 대화상자에서 사유를 적고 실행하세요.</p>
            <label className="col gap-1 t-sm">
              사유({NOTICE_REASON_MAX.toLocaleString('ko-KR')}자까지)
              <textarea className="input" rows={3} maxLength={REASON_MAX} value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
            </label>
            <div className="row gap-2">
              <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void submitAction()}>
                {noticeActionLabel(draft.action)} 실행
              </button>
              <button className="btn btn-outline btn-sm" type="button" disabled={busy} onClick={() => setDraft(null)}>
                취소
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
