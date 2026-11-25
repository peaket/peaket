// SCR-032 법정 조치 연결 화면(/compliance?tab=, d5 §7.5, F-03-7).
// - 통보·자료 요청·보안 사고·접속기록 점검을 계약(openapi /v1/ops/compliance/**)대로 읽고 쓴다.
//   서버 `compliance` 모듈은 아직 없어(계획 '감독에게' 1) 실제 응답은 대역으로만 확인했다.
// - 칸 가림은 응답 `view`를 따르고(ASVS 8.1.2), viewer는 통보·자료 요청을 부르지 않는다. 역할은 서버 세션에서 읽는다.
// - 추출 요청·승인만 act AUTHORITY_DATA 재인증을 거치고, 토큰은 그 요청 하나의 머리에만 쓴다(ASVS 3.3.4).
// - 주소에는 tab만 싣는다(ASVS 14.2.1). 사유·대상자·해시는 본문으로만 보낸다.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { ReauthDialog } from '@/features/admin-reauth/ReauthDialog';
import { ensureConsoleApi } from '@/shared/api';
import { useLayout } from '@/shared/lib/layout';
import {
  actionAvailability,
  complianceProblemMessage,
  tabFromParam,
  tabHref,
  TABS,
  validateDataRequestDraft,
  validateDeterminationDraft,
  validateExtractionDraft,
  validateFilingDraft,
  validateFindingResolution,
  validateNoticeDraft,
  validateSubmissionDraft,
  type ComplianceTab,
} from '../model/compliance';
import { AccessReviewPanel } from './connected/AccessReviewPanel';
import { DataRequestPanel } from './connected/DataRequestPanel';
import { IncidentPanel } from './connected/IncidentPanel';
import { NoticePanel } from './connected/NoticePanel';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const statusOf = (v: Record<string, unknown>): string => text(v.status);
const titleOf = (v: Record<string, unknown>): string => text(v.agencyName) || text(v.kind) || text(v.noticeId) || text(v.requestId) || text(v.incidentId);
const idOf = (v: Record<string, unknown>): string => text(v.noticeId) || text(v.requestId) || text(v.incidentId) || text(v.findingId);
const iso = (v: string | undefined): string => {
  if (!v) return '';
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
};

type Load = { kind: 'loading' } | { kind: 'ready' } | { kind: 'config' } | { kind: 'error'; message: string };
type PendingReauth = { kind: 'extract'; request: Record<string, unknown>; scope: { dataItems: string[]; periodFrom?: string; periodTo?: string; reason: string } } | { kind: 'approve'; request: Record<string, unknown> } | null;

export function ConnectedPage() {
  const layout = useLayout();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const tab = tabFromParam(sp.get('tab'));
  const [role, setRole] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [findings, setFindings] = useState<Record<string, unknown>[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [sort, setSort] = useState<'DUE_ASC' | 'LATEST'>('DUE_ASC');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [reauth, setReauth] = useState<PendingReauth>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const nowMs = Date.now();
  const phone = layout === 'phone';
  const demo = false;

  const writeRole = role === 'operator' || role === 'commander';
  const availability = useMemo(
    () => actionAvailability({ role: role ?? 'viewer', tab, layout, view: detail ? (detail.view === 'SUMMARY' ? 'SUMMARY' : 'FULL') : 'UNKNOWN', detail, demo }),
    [role, tab, layout, detail, demo],
  );

  useEffect(() => {
    if (!ensureConsoleApi()) return;
    let alive = true;
    void (async () => {
      try {
        const ops = await import('@peaket/api-client/endpoints/ops');
        const r = await ops.getMyOpsAuthSession();
        const got = text(obj(r.data).role);
        if (alive) setRole(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'].includes(got) ? got : 'viewer');
      } catch {
        if (alive) setRole('viewer');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const loadList = useCallback(async () => {
    if (!ensureConsoleApi()) {
      setLoad({ kind: 'config' });
      return;
    }
    if ((tab === 'requests' && role === 'viewer') || (tab === 'access-reviews' && role !== null && role !== 'commander')) {
      setLoad({ kind: 'ready' });
      setItems([]);
      return;
    }
    setLoad((p) => (p.kind === 'ready' ? p : { kind: 'loading' }));
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      if (tab === 'requests') {
        const [n, d] = await Promise.all([
          ops.listOpsComplianceNotices({ ...(statusFilter ? { status: [statusFilter] as never } : {}), sort, limit: 100 }),
          ops.listOpsComplianceDataRequests({ ...(statusFilter ? { status: [statusFilter] as never } : {}), sort, limit: 100 }),
        ]);
        setItems([...arr(obj(n.data).items), ...arr(obj(d.data).items)]);
        setNextCursor(text(obj(n.data).nextCursor) || text(obj(d.data).nextCursor) || null);
      } else if (tab === 'incidents') {
        const r = await ops.listOpsComplianceIncidents({ ...(statusFilter ? { status: [statusFilter] as never } : {}), sort, limit: 100 });
        setItems(arr(obj(r.data).items));
        setNextCursor(text(obj(r.data).nextCursor) || null);
      } else {
        const r = await ops.listOpsComplianceAccessReviews({ limit: 100 });
        setItems(arr(obj(r.data).items));
        setNextCursor(text(obj(r.data).nextCursor) || null);
        setFindings([]);
      }
      setLoad({ kind: 'ready' });
    } catch (e) {
      setLoad({ kind: 'error', message: complianceProblemMessage(obj(e)) });
    }
  }, [tab, role, statusFilter, sort]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const select = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setDetail(null);
      if (!id || !ensureConsoleApi()) return;
      try {
        const ops = await import('@peaket/api-client/endpoints/ops');
        if (tab === 'requests') {
          if (id.startsWith('N:')) {
            const r = await ops.getOpsComplianceNotice(id.slice(2));
            setDetail(obj(r.data));
          } else {
            const r = await ops.getOpsComplianceDataRequest(id.slice(2));
            setDetail(obj(r.data));
          }
        } else if (tab === 'incidents') {
          const r = await ops.getOpsComplianceIncident(id);
          setDetail(obj(r.data));
        } else {
          const review = items.find((x) => text(x.reviewId) === id);
          setDetail(review ?? null);
          const rs = arr((review ?? {}).items);
          setFindings(rs.length > 0 ? rs : arr((review ?? {}).findings));
        }
      } catch (e) {
        setNotice({ tone: 'bad', text: complianceProblemMessage(obj(e)) });
      }
    },
    [tab, items],
  );

  const run = async (fn: () => Promise<unknown>, okText: string) => {
    if (busy || !writeRole || phone) return;
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      setNotice({ tone: 'ok', text: okText });
      await loadList();
      if (selectedId) await select(selectedId);
    } catch (e) {
      setNotice({ tone: 'bad', text: complianceProblemMessage(obj(e)) });
    } finally {
      setBusy(false);
    }
  };

  const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });

  const submitExtract = (scope: { dataItems: string[]; periodFrom?: string; periodTo?: string; reason: string }) => {
    if (!detail) return;
    const issue = validateExtractionDraft(scope, detail);
    if (issue) {
      setNotice({ tone: 'bad', text: issue });
      return;
    }
    setReauth({ kind: 'extract', request: detail, scope });
  };

  const doExtract = (token: string, request: Record<string, unknown>, scope: { dataItems: string[]; periodFrom?: string; periodTo?: string; reason: string }) => {
    void run(async () => {
      const ops = await import('@peaket/api-client/endpoints/ops');
      await ops.createOpsComplianceDataRequestExtractionRequest(text(request.requestId), { dataItems: scope.dataItems as never, reason: scope.reason, ...(scope.periodFrom ? { periodFrom: scope.periodFrom } : {}), ...(scope.periodTo ? { periodTo: scope.periodTo } : {}) }, { headers: { 'X-Reauth-Token': token } });
      setReauth(null);
    }, '추출을 요청했습니다. 요청자가 아닌 commander가 승인해야 자료를 뽑습니다.');
  };

  const submitRegister = () => {
    if (tab === 'requests') {
      // 통보와 자료 요청 중 어느 쪽인지는 form.kind가 정한다(빈 값이면 통보)
      if (form.formKind === 'data') {
        const draft = {
          requester: form.requester ?? 'POLICE',
          agencyName: form.agencyName ?? '',
          kind: form.kind ?? 'CDR',
          receivedAt: iso(form.receivedAt),
          dueAt: iso(form.dueAt),
          legalBasis: form.legalBasis ?? '',
          purpose: form.purpose ?? '',
          subjects: (form.subjects ?? '').split(/\n+/).filter(Boolean).map((v) => ({ kind: 'ACCOUNT_ID', value: v.trim() })),
          dataItems: Object.entries(checks).filter(([k, v]) => v && k.startsWith('item:')).map(([k]) => k.slice(5)),
          checklist: {
            legalBasisChecked: checks.legalBasisChecked === true,
            purposeChecked: checks.purposeChecked === true,
            scopeChecked: checks.scopeChecked === true,
            dueChecked: checks.dueChecked === true,
            courtWarrantAttached: checks.courtWarrantAttached === true,
          },
        };
        const issue = validateDataRequestDraft(draft);
        if (issue) {
          setNotice({ tone: 'bad', text: issue });
          return;
        }
        void run(async () => {
          const ops = await import('@peaket/api-client/endpoints/ops');
          await ops.createOpsComplianceDataRequest(draft as never, { headers: idem() });
          setRegisterOpen(false);
        }, '자료 요청을 접수했습니다. 아직 자료를 뽑지 않습니다.');
      } else {
        const draft = {
          requester: form.requester ?? 'AGENCY',
          agencyName: form.agencyName ?? '',
          receivedAt: iso(form.receivedAt),
          deadline: form.deadline ?? 'H24',
          reviewIds: (form.reviewIds ?? '').split(/[\s,]+/).filter(Boolean),
          summary: form.summary ?? '',
        };
        const issue = validateNoticeDraft(draft);
        if (issue) {
          setNotice({ tone: 'bad', text: issue });
          return;
        }
        void run(async () => {
          const ops = await import('@peaket/api-client/endpoints/ops');
          await ops.createOpsComplianceNotice(draft as never, { headers: idem() });
          setRegisterOpen(false);
        }, '통보를 등록했습니다. 법정 처리 기한 타이머가 시작됐습니다.');
      }
    } else if (tab === 'incidents') {
      const draft = {
        kind: form.kind ?? 'INTRUSION',
        awareAt: iso(form.awareAt),
        ...(form.affectedCount ? { affectedCount: Number(form.affectedCount) } : {}),
        sensitiveOrUnique: checks.sensitiveOrUnique === true,
        externalAccess: checks.externalAccess === true,
        summary: form.summary ?? '',
      };
      if (!draft.awareAt) {
        setNotice({ tone: 'bad', text: '인지 시각을 골라 주세요' });
        return;
      }
      void run(async () => {
        const ops = await import('@peaket/api-client/endpoints/ops');
        await ops.createOpsComplianceIncident(draft as never, { headers: idem() });
        setRegisterOpen(false);
      }, '보안 사고를 등록했습니다. 의무별 기한과 SEV1이 생겼습니다.');
    }
  };

  const currentDetailId = selectedId;
  const noticeDetail = tab === 'requests' && currentDetailId?.startsWith('N:') ? detail : null;
  const dataDetail = tab === 'requests' && currentDetailId?.startsWith('D:') ? detail : null;

  if (load.kind === 'config') {
    return (
      <section className="widget" role="alert">
        <div className="widget-body t-sm">관제 API 주소가 설정되지 않아 법정 조치를 부를 수 없습니다.</div>
      </section>
    );
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>법정 조치</h1>
          <p className="t-sm muted">통보·자료 요청·보안 사고·접속기록 점검을 처리합니다. 조회만 하는 역할은 건 요약만 봅니다.</p>
        </div>
        <button className="btn btn-outline" type="button" onClick={() => void loadList()}>
          <i className="ic ic-refresh" aria-hidden="true" /> 새로 고침
        </button>
      </div>

      <div className="row wrap" role="tablist" aria-label="법정 조치 탭">
        {TABS.map((t) => (
          <a key={t.key} href={tabHref(t.key)} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'} onClick={(e) => { e.preventDefault(); navigate(tabHref(t.key)); }}>
            {t.label}
          </a>
        ))}
      </div>

      {notice ? (
        <div className={`banner ${notice.tone === 'ok' ? 'banner-info' : 'banner-danger'}`} role={notice.tone === 'bad' ? 'alert' : 'status'}>
          <div className="banner-body">{notice.text}</div>
        </div>
      ) : null}
      {load.kind === 'error' ? <div className="banner banner-danger" role="alert"><div className="banner-body">{load.message}</div></div> : null}
      {tab === 'requests' && role === 'viewer' ? <div className="banner banner-warning" role="note"><div className="banner-body">viewer는 통보·자료 요청을 볼 수 없습니다(보안 사고만 요약으로 봅니다).</div></div> : null}
      {tab === 'access-reviews' && role !== null && role !== 'commander' ? <div className="banner banner-warning" role="note"><div className="banner-body">접속기록 점검은 commander만 볼 수 있습니다.</div></div> : null}

      <div className="grid-12" style={{ rowGap: 16, alignItems: 'start' }}>
        <section className="widget span-4" aria-labelledby="comp-list-h">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="comp-list-h">목록</h2>
            <span className="badge">{items.length}건</span>
          </div>
          <div className="widget-body col" style={{ padding: 12, gap: 8 }}>
            <div className="row wrap" style={{ gap: 6 }}>
              <label className="field" style={{ flex: 1 }}>
                <span className="label">상태</span>
                <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">전체</option>
                  {tab === 'incidents' ? [['OPEN', '진행 중'], ['CLOSED', '종결']].map(([v, l]) => <option key={v} value={v}>{l}</option>) : [['OPEN', '처리 중'], ['PENDING_APPROVAL', '승인 대기'], ['SUBMITTED', '제출됨'], ['REFUSED', '거부']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label className="field" style={{ minWidth: 130 }}>
                <span className="label">정렬</span>
                <select className="input" value={sort} onChange={(e) => setSort(e.target.value as 'DUE_ASC' | 'LATEST')}>
                  <option value="DUE_ASC">기한 순</option>
                  <option value="LATEST">최근 등록 순</option>
                </select>
              </label>
            </div>
            {writeRole && tab !== 'access-reviews' && !phone ? (
              <button className="btn btn-primary btn-sm" type="button" onClick={() => { setForm({}); setChecks({}); setRegisterOpen(true); }}>
                {tab === 'requests' ? '통보·자료 요청 등록' : '보안 사고 등록'}
              </button>
            ) : null}
            {load.kind === 'loading' ? <p className="t-sm muted" role="status">목록을 불러오는 중…</p> : null}
            {items.length === 0 && load.kind === 'ready' ? <p className="t-sm muted" role="status">조건에 맞는 건이 없습니다.</p> : null}
            <ul className="col" style={{ gap: 6 }}>
              {items.map((it) => {
                const id = tab === 'requests' ? `${it.noticeId ? 'N:' : 'D:'}${idOf(it)}` : idOf(it);
                return (
                  <li key={id}>
                    <button type="button" className="card-flat pad col" style={{ gap: 2, textAlign: 'left', width: '100%', borderColor: selectedId === id ? 'var(--color-primary, #2563eb)' : undefined }} aria-current={selectedId === id ? 'true' : undefined} onClick={() => void select(id)}>
                      <span className="row between wrap" style={{ gap: 6 }}>
                        <strong className="t-sm">{titleOf(it)}</strong>
                        <span className={`badge${statusOf(it) === 'REFUSED' || statusOf(it) === 'CLOSED' ? '' : ' badge-warning'}`}>{statusOf(it) || '—'}</span>
                      </span>
                      <span className="t-xs muted">{text(it.dueAt) || text(it.period) || text(it.kind) || '—'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {nextCursor ? <p className="t-xs muted">다음 장이 있습니다. 조건을 좁혀 주세요.</p> : null}
          </div>
        </section>

        <section className="widget span-8" aria-labelledby="comp-detail-h">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="comp-detail-h">상세</h2>
            {detail && detail.view === 'SUMMARY' ? <span className="badge">요약</span> : null}
          </div>
          <div className="widget-body col" style={{ padding: 16, gap: 12 }}>
            {!detail ? <p className="t-sm muted">왼쪽 목록에서 건을 고르세요.</p> : null}
            {noticeDetail ? (
              <NoticePanel
                role={role ?? 'viewer'}
                layout={layout}
                notice={noticeDetail}
                nowMs={nowMs}
                busy={busy}
                onTakedown={(reason) => {
                  if (reason.trim() === '') {
                    setNotice({ tone: 'bad', text: '노출 차단 사유를 적어 주세요' });
                    return;
                  }
                  const id = text(noticeDetail.noticeId);
                  void run(async () => {
                    const ops = await import('@peaket/api-client/endpoints/ops');
                    await ops.createOpsComplianceNoticeTakedown(id, { reason }, { headers: idem() });
                  }, '노출을 차단했습니다. 결과 회신 기록에 남깁니다.');
                }}
                onWithdraw={(reason) => {
                  if (reason.trim() === '') {
                    setNotice({ tone: 'bad', text: '철회 사유를 적어 주세요' });
                    return;
                  }
                  const id = text(noticeDetail.noticeId);
                  void run(async () => {
                    const ops = await import('@peaket/api-client/endpoints/ops');
                    await ops.createOpsComplianceNoticeWithdrawal(id, { reason }, { headers: idem() });
                  }, '통보 철회로 노출을 되살렸습니다.');
                }}
                onUpload={(file) => {
                  const id = text(noticeDetail.noticeId);
                  void run(async () => {
                    const ops = await import('@peaket/api-client/endpoints/ops');
                    await ops.createOpsComplianceNoticeDocument(id, { kind: 'OFFICIAL_LETTER', file });
                  }, '공문 원본을 올렸습니다. 악성 코드 검사가 끝나면 내려받을 수 있습니다.');
                }}
              />
            ) : null}
            {dataDetail ? (
              <DataRequestPanel
                role={role ?? 'viewer'}
                layout={layout}
                request={dataDetail}
                nowMs={nowMs}
                busy={busy}
                onExtract={submitExtract}
                onApprove={() => setReauth({ kind: 'approve', request: dataDetail })}
                onReject={(outcome, reason) => {
                  if (reason.trim() === '') {
                    setNotice({ tone: 'bad', text: '거부 사유를 적어 주세요' });
                    return;
                  }
                  const id = text(dataDetail.requestId);
                  void run(async () => {
                    const ops = await import('@peaket/api-client/endpoints/ops');
                    await ops.createOpsComplianceDataRequestRejection(id, { outcome, reason });
                  }, outcome === 'REVISE' ? '범위를 고쳐 다시 요청하도록 접수로 돌렸습니다.' : '제공하지 않음으로 닫았습니다. 사유가 요청 기록에 남습니다.');
                }}
                onSubmit={(d) => {
                  const issue = validateSubmissionDraft(d, text(obj(arr(dataDetail.documents).find((x) => text(x.kind) === 'SUBMISSION_FILE')).sha256));
                  if (issue) {
                    setNotice({ tone: 'bad', text: issue });
                    return;
                  }
                  const id = text(dataDetail.requestId);
                  void run(async () => {
                    const ops = await import('@peaket/api-client/endpoints/ops');
                    await ops.createOpsComplianceDataRequestSubmission(id, d);
                  }, '제출을 기록했습니다. 제공 대장에 남고 보존 기간을 다시 셉니다.');
                }}
              />
            ) : null}
            {tab === 'incidents' && detail ? (
              <IncidentPanel
                role={role ?? 'viewer'}
                layout={layout}
                incident={detail}
                nowMs={nowMs}
                demo={demo}
                busy={busy}
                onDetermine={(outcome, reason) => {
                  const issue = validateDeterminationDraft({ outcome, reason });
                  if (issue) {
                    setNotice({ tone: 'bad', text: issue });
                    return;
                  }
                  const id = text(detail.incidentId);
                  void run(async () => {
                    const ops = await import('@peaket/api-client/endpoints/ops');
                    await ops.createOpsComplianceIncidentDetermination(id, { outcome: outcome as never, reason }, { headers: idem() });
                  }, '해당 판단을 기록했습니다. 이제 신고·통지를 기록할 수 있습니다.');
                }}
                onFile={(d) => {
                  const issue = validateFilingDraft(d);
                  if (issue) {
                    setNotice({ tone: 'bad', text: issue });
                    return;
                  }
                  const id = text(detail.incidentId);
                  void run(async () => {
                    const ops = await import('@peaket/api-client/endpoints/ops');
                    await ops.createOpsComplianceIncidentFiling(id, { duty: d.duty as never, channel: d.channel, doneAt: d.doneAt, summary: d.summary });
                  }, '신고·통지를 기록했습니다.');
                }}
                onClose={() => {
                  const id = text(detail.incidentId);
                  void run(async () => {
                    const ops = await import('@peaket/api-client/endpoints/ops');
                    await ops.createOpsComplianceIncidentClosure(id, { headers: idem() });
                  }, '보안 사고를 종결했습니다.');
                }}
              />
            ) : null}
            {tab === 'access-reviews' && detail ? (
              <AccessReviewPanel
                role={role ?? 'viewer'}
                layout={layout}
                demo={demo}
                review={detail}
                findings={findings}
                busy={busy}
                onComplete={() => {
                  const reviewId = text(detail.reviewId);
                  void run(async () => {
                    const ops = await import('@peaket/api-client/endpoints/ops');
                    await ops.createOpsComplianceAccessReviewCompletion(reviewId);
                  }, '월 정기 점검을 완료로 기록했습니다.');
                }}
                onResolve={(findingId, d) => {
                  const issue = validateFindingResolution(d);
                  if (issue) {
                    setNotice({ tone: 'bad', text: issue });
                    return;
                  }
                  void run(async () => {
                    const ops = await import('@peaket/api-client/endpoints/ops');
                    await ops.createOpsComplianceAccessFindingResolution(findingId, { reason: d.reason, action: d.action as never });
                  }, '이상 건을 종결했습니다.');
                }}
              />
            ) : null}
            {!availability.register.enabled && tab === 'access-reviews' && role === 'operator' ? <p className="hint">{availability.register.reason}</p> : null}
          </div>
        </section>
      </div>

      {registerOpen ? (
        <div className="dialog-backdrop" role="presentation" onClick={() => setRegisterOpen(false)}>
          <div className="dialog col" role="dialog" aria-modal="true" aria-labelledby="comp-register-h" style={{ maxWidth: 560, gap: 8 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="dialog-title" id="comp-register-h">{tab === 'incidents' ? '보안 사고 등록' : '통보·자료 요청 등록'}</h2>
            {tab === 'requests' ? (
              <>
                <label className="field"><span className="label">등록 종류</span><select className="input" value={form.formKind ?? 'notice'} onChange={(e) => setForm((f) => ({ ...f, formKind: e.target.value }))}><option value="notice">통보(노출 차단)</option><option value="data">자료 요청(수사기관)</option></select></label>
                <label className="field"><span className="label">기관 종류</span><select className="input" value={form.requester ?? 'AGENCY'} onChange={(e) => setForm((f) => ({ ...f, requester: e.target.value }))}><option value="AGENCY">신고기관</option><option value="POLICE">수사기관</option></select></label>
                <label className="field"><span className="label">기관 이름</span><input className="input" value={form.agencyName ?? ''} onChange={(e) => setForm((f) => ({ ...f, agencyName: e.target.value }))} /></label>
                {form.formKind === 'data' ? (
                  <>
                    <label className="field"><span className="label">자료 종류</span><select className="input" value={form.kind ?? 'CDR'} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}><option value="REPORT">신고기관 자료</option><option value="CDR">통신사실확인자료</option><option value="SUBSCRIBER">통신이용자정보</option></select></label>
                    <label className="field"><span className="label">접수 시각</span><input className="input" type="datetime-local" value={form.receivedAt ?? ''} onChange={(e) => setForm((f) => ({ ...f, receivedAt: e.target.value }))} /></label>
                    <label className="field"><span className="label">제출 기한</span><input className="input" type="datetime-local" value={form.dueAt ?? ''} onChange={(e) => setForm((f) => ({ ...f, dueAt: e.target.value }))} /></label>
                    <label className="field"><span className="label">법적 근거</span><input className="input" value={form.legalBasis ?? ''} onChange={(e) => setForm((f) => ({ ...f, legalBasis: e.target.value }))} /></label>
                    <label className="field"><span className="label">요청 목적</span><textarea className="input" value={form.purpose ?? ''} onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))} /></label>
                    <label className="field"><span className="label">대상자(한 줄에 하나, 계정 ID)</span><textarea className="input" value={form.subjects ?? ''} onChange={(e) => setForm((f) => ({ ...f, subjects: e.target.value }))} /></label>
                    <fieldset className="row wrap" style={{ gap: 10, border: 0, padding: 0, margin: 0 }}>
                      <legend className="label">자료 항목</legend>
                      {['BOOKINGS', 'BUYER_INFO', 'ACCESS_LOGS', 'POSTS', 'SUBSCRIBER_INFO'].map((k) => <label key={k} className="check-row"><input className="ck" type="checkbox" checked={checks[`item:${k}`] === true} onChange={(e) => setChecks((c) => ({ ...c, [`item:${k}`]: e.target.checked }))} />{k}</label>)}
                    </fieldset>
                    <fieldset className="col" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
                      <legend className="label">법적 요건 점검표</legend>
                      {[['legalBasisChecked', '법적 근거가 정당하다'], ['purposeChecked', '요청 목적과 대상이 이어져 있다'], ['scopeChecked', '대상 범위가 목적 안이다'], ['dueChecked', '제출 기한이 적혀 있다'], ['courtWarrantAttached', '법원 허가서(영장)를 첨부했다']].map(([k, l]) => <label key={k} className="check-row"><input className="ck" type="checkbox" checked={checks[k] === true} onChange={(e) => setChecks((c) => ({ ...c, [k]: e.target.checked }))} />{l}</label>)}
                    </fieldset>
                  </>
                ) : (
                  <>
                    <label className="field"><span className="label">공문 접수 시각</span><input className="input" type="datetime-local" value={form.receivedAt ?? ''} onChange={(e) => setForm((f) => ({ ...f, receivedAt: e.target.value }))} /></label>
                    <label className="field"><span className="label">처리 기한</span><select className="input" value={form.deadline ?? 'H24'} onChange={(e) => setForm((f) => ({ ...f, deadline: e.target.value }))}><option value="H24">24시간</option><option value="H10">10시간(고시)</option></select></label>
                    <label className="field"><span className="label">게시물 ID(쉼표·줄바꿈)</span><textarea className="input" value={form.reviewIds ?? ''} onChange={(e) => setForm((f) => ({ ...f, reviewIds: e.target.value }))} /></label>
                    <label className="field"><span className="label">통보 요약</span><textarea className="input" maxLength={2000} value={form.summary ?? ''} onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))} /></label>
                  </>
                )}
              </>
            ) : (
              <>
                <label className="field"><span className="label">사고 종류</span><select className="input" value={form.kind ?? 'INTRUSION'} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}><option value="INTRUSION">침해사고</option><option value="PERSONAL_DATA">개인정보 유출</option><option value="PERSONAL_DATA_POSSIBLE">유출 가능성</option></select></label>
                <label className="field"><span className="label">인지 시각</span><input className="input" type="datetime-local" value={form.awareAt ?? ''} onChange={(e) => setForm((f) => ({ ...f, awareAt: e.target.value }))} /></label>
                <label className="field"><span className="label">대상 수(모르면 빈칸)</span><input className="input" type="number" value={form.affectedCount ?? ''} onChange={(e) => setForm((f) => ({ ...f, affectedCount: e.target.value }))} /></label>
                <label className="check-row"><input className="ck" type="checkbox" checked={checks.sensitiveOrUnique === true} onChange={(e) => setChecks((c) => ({ ...c, sensitiveOrUnique: e.target.checked }))} />민감정보·고유식별정보 포함</label>
                <label className="check-row"><input className="ck" type="checkbox" checked={checks.externalAccess === true} onChange={(e) => setChecks((c) => ({ ...c, externalAccess: e.target.checked }))} />외부 불법 접근</label>
                <label className="field"><span className="label">사고 요약(개인정보 원문 없이)</span><textarea className="input" maxLength={2000} value={form.summary ?? ''} onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))} /></label>
              </>
            )}
            <div className="dialog-actions">
              <button className="btn btn-ghost" type="button" onClick={() => setRegisterOpen(false)}>닫기</button>
              <button className="btn btn-primary" type="button" disabled={busy} onClick={submitRegister}>등록</button>
            </div>
          </div>
        </div>
      ) : null}

      <ReauthDialog
        open={reauth !== null}
        act="AUTHORITY_DATA"
        title="수사기관 자료 재인증"
        description="추출 요청과 승인은 비밀번호·인증 앱 코드에 더해 등록한 패스키로 다시 확인합니다. 토큰은 이 요청 하나에만 씁니다."
        onDone={(token) => {
          if (!reauth) return;
          if (reauth.kind === 'extract') doExtract(token, reauth.request, reauth.scope);
          else if (reauth.kind === 'approve') {
            const id = text(reauth.request.requestId);
            void run(async () => {
              const ops = await import('@peaket/api-client/endpoints/ops');
              await ops.createOpsComplianceDataRequestApproval(id, { headers: { 'X-Reauth-Token': token } });
            }, '추출을 승인했습니다. 승인된 범위만 뽑아 제출 파일을 만듭니다.');
            setReauth(null);
          }
        }}
        onClose={() => setReauth(null)}
      />
    </div>
  );
}
