'use client';
// SCR-044 회차 취소·연기 요청 실제 화면(d5 §6.12, transfer-refund §5, BAT-421).
// getPartnerProduction으로 공연·회차를 읽고, 요청은 POST /v1/partner/events/{eventId}/cancellation(멱등키)로 보낸다.
// 상태는 GET 같은 경로로 읽어 판정 대기 → 재판정 대기 → 확정 대기 → 확정·진행 → 일시정지 → 완료/반려를 그린다.
// 파트너 응답에 없는 미리보기·결제사별 몫·판정자·내부 판정 사유는 그리지 않는다.
// 실무자 역할을 미리 아는 계약이 없어 첫 방문에는 요청 버튼이 활성이고, 403 partner_member를 받으면 이 방문 동안 버튼을 끈다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@peaket/ds/Button';
import { ProgressBar } from '@peaket/ds/ProgressBar';
import { Select } from '@peaket/ds/Select';
import { TextArea } from '@peaket/ds/TextArea';
import { TextField } from '@peaket/ds/TextField';
import { getEventCancellation, getProductionDetail, newIdempotencyKey, requestEventCancellation, type PartnerEventCancellationStatus, type PartnerProductionDetail } from '@/shared/api/partner-live';
import { isProblem, problemType } from '@/shared/api/problem';
import { Modal } from '@/shared/ui/Modal';
import { errorOf, kstLocalToIso, kstText, statusView, validateRequest, type FaultChoice, type RequestField } from '../model/live';

const won = (n: number) => `₩${new Intl.NumberFormat('ko-KR').format(n)}`;
const REQUEST_ADMIN_REASON = '회차 취소·연기 요청은 파트너 관리자만 할 수 있습니다';

type Load = { kind: 'loading' } | { kind: 'ready'; detail: PartnerProductionDetail } | { kind: 'error'; text: string };
type FieldError = { field: RequestField; message: string } | null;
type Attempt = { body: string; key: string };

const FAULT_OPTIONS: readonly { value: FaultChoice; label: string }[] = [
  { value: 'NONE', label: '의견 없음' },
  { value: 'ORGANIZER', label: '주최 측 귀책' },
  { value: 'FORCE_MAJEURE', label: '불가항력' },
  { value: 'CONTENT_CHANGE', label: '공연 내용 변경' },
];

export function LiveCancellationRequest({ productionId }: { productionId: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [selectedEventId, setSelectedEventId] = useState('');
  const [status, setStatus] = useState<PartnerEventCancellationStatus | null>(null);
  const [statusState, setStatusState] = useState<'none' | 'loading' | 'ready' | 'error'>('none');
  const [kind, setKind] = useState<'CANCEL' | 'POSTPONE'>('POSTPONE');
  const [newStartsAtLocal, setNewStartsAtLocal] = useState('');
  const [reason, setReason] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [fault, setFault] = useState<FaultChoice>('NONE');
  const [fieldError, setFieldError] = useState<FieldError>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [memberDenied, setMemberDenied] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const detail = await getProductionDetail(productionId);
        setLoad({ kind: 'ready', detail });
        const rounds = [...detail.events].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
        setSelectedEventId((prev) => prev || (rounds[1] ?? rounds[0])?.eventId || '');
      } catch (e) {
        setLoad({ kind: 'error', text: errorOf(e as never).text });
      }
    })();
  }, [productionId]);

  const detail = load.kind === 'ready' ? load.detail : null;
  const rounds = useMemo(() => (detail ? [...detail.events].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)) : []), [detail]);
  const current = rounds.find((r) => r.eventId === selectedEventId) ?? null;

  const loadStatus = useCallback(async (eventId: string) => {
    if (!eventId) {
      setStatus(null);
      setStatusState('none');
      return;
    }
    setStatusState('loading');
    try {
      const s = await getEventCancellation(eventId);
      setStatus(s);
      setStatusState('ready');
    } catch (e) {
      if (isProblem(e) && problemType(e) === 'not-found') {
        setStatus(null);
        setStatusState('none');
        return;
      }
      setStatus(null);
      setStatusState('error');
    }
  }, []);

  useEffect(() => {
    void loadStatus(selectedEventId);
  }, [selectedEventId, loadStatus]);

  const openConfirm = () => {
    if (!current) {
      setFieldError({ field: 'round', message: '회차를 골라 주세요' });
      return;
    }
    const r = validateRequest({ kind, newStartsAtLocal, reason, evidenceRef, faultOpinion: fault }, Date.parse(current.startsAt));
    if (!r.ok) {
      setFieldError({ field: r.field, message: r.message });
      return;
    }
    setFieldError(null);
    setNotice(null);
    setConfirmOpen(true);
  };

  const send = async () => {
    if (!current) return;
    const r = validateRequest({ kind, newStartsAtLocal, reason, evidenceRef, faultOpinion: fault }, Date.parse(current.startsAt));
    if (!r.ok) {
      setConfirmOpen(false);
      setFieldError({ field: r.field, message: r.message });
      return;
    }
    const bodyText = JSON.stringify(r.body);
    const key = attemptRef.current?.body === bodyText ? attemptRef.current.key : newIdempotencyKey();
    attemptRef.current = { body: bodyText, key };
    setBusy(true);
    try {
      await requestEventCancellation(current.eventId, r.body, key);
      setConfirmOpen(false);
      setNotice({ tone: 'ok', text: '요청을 보냈습니다. PEAKET 운영자가 판정하면 상태가 바뀝니다.' });
      await loadStatus(current.eventId);
    } catch (e) {
      const mapped = errorOf(e as never);
      setConfirmOpen(false);
      if (mapped.kind === 'member') setMemberDenied(true);
      if (mapped.kind === 'date-invalid') setFieldError({ field: 'newStartsAt', message: mapped.text });
      setNotice({ tone: 'bad', text: mapped.text });
      if (mapped.kind === 'active') await loadStatus(current.eventId);
    } finally {
      setBusy(false);
    }
  };

  if (load.kind === 'loading') {
    return <p className="t-sm muted">공연과 회차를 불러오는 중…</p>;
  }
  if (load.kind === 'error' || !detail) {
    return (
      <section className="card col gap-3 p-4 md:p-6" role="alert">
        <h1 className="t-lg">회차 취소·연기 요청</h1>
        <p className="t-sm">{load.kind === 'error' ? load.text : '공연을 불러오지 못했습니다.'}</p>
        <Link className="btn btn-outline" href="/events">
          공연 관리로 가기
        </Link>
      </section>
    );
  }

  const sv = status ? statusView(status) : null;
  const toneClass = sv ? (sv.tone === 'danger' ? 'badge-danger' : sv.tone === 'warning' ? 'badge-warning' : sv.tone === 'success' ? 'badge-success' : 'badge-primary') : 'badge';

  return (
    <section className="col" style={{ gap: 16 }} aria-labelledby="cx-live-h">
      <div className="col" style={{ gap: 4 }}>
        <nav className="breadcrumb max-lg:hidden" aria-label="위치">
          <Link href="/events">공연 관리</Link>
          <i className="ic ic-chevron-right" aria-hidden="true" />
          <span>{detail.title}</span>
        </nav>
        <h1 className="t-xl" id="cx-live-h">
          {detail.title}
        </h1>
        <p className="t-sm muted">회차 취소·연기 요청</p>
      </div>

      {notice ? (
        <div className={`banner ${notice.tone === 'ok' ? 'banner-info' : 'banner-warning'}`} role={notice.tone === 'ok' ? 'status' : 'alert'}>
          <div className="banner-body">{notice.text}</div>
        </div>
      ) : null}
      {memberDenied ? (
        <div className="banner banner-danger" role="alert">
          <div className="banner-body">
            <span className="banner-title">요청 권한 없음</span>
            {REQUEST_ADMIN_REASON}
          </div>
        </div>
      ) : null}

      <section className="card col gap-3 p-4 md:gap-5 md:p-6" aria-labelledby="cx-form-h">
        <h2 className="t-md fw-b" id="cx-form-h">
          요청 내용
        </h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-12 lg:gap-x-6">
          <Select
            id="cx-round-live"
            label="회차 (필수)"
            fieldClassName="lg:col-span-4"
            value={selectedEventId}
            onChange={(e) => setSelectedEventId(e.target.value)}
            options={rounds.map((r) => ({ value: r.eventId, label: `${kstText(r.startsAt)}${r.status === 'CANCELED' ? ' · 취소됨' : ''}` }))}
            error={fieldError?.field === 'round' ? fieldError.message : undefined}
            hint="종료된 회차는 요청할 수 없습니다"
          />
          <fieldset className="col lg:col-span-4">
            <legend className="label" style={{ marginBottom: 6 }}>
              요청 종류 (필수)
            </legend>
            <div className="row" style={{ gap: 24, minHeight: 48 }}>
              <label className="check-row" htmlFor="cx-kind-cancel">
                <input className="rd" id="cx-kind-cancel" type="radio" name="cx-kind-live" value="CANCEL" checked={kind === 'CANCEL'} onChange={() => setKind('CANCEL')} />
                취소
              </label>
              <label className="check-row" htmlFor="cx-kind-postpone">
                <input className="rd" id="cx-kind-postpone" type="radio" name="cx-kind-live" value="POSTPONE" checked={kind === 'POSTPONE'} onChange={() => setKind('POSTPONE')} />
                연기
              </label>
            </div>
          </fieldset>
          {kind === 'POSTPONE' ? (
            <TextField
              id="cx-when-live"
              label="바뀐 일시 (연기면 필수)"
              type="datetime-local"
              fieldClassName="col-start-2 lg:col-span-4 lg:col-start-auto"
              value={newStartsAtLocal}
              onChange={(e) => setNewStartsAtLocal(e.target.value)}
              hint="공연장 시각(KST)으로 적습니다"
              error={fieldError?.field === 'newStartsAt' ? fieldError.message : undefined}
            />
          ) : null}
          <TextArea
            id="cx-reason-live"
            label="사유 (필수)"
            fieldClassName="col-span-full lg:col-span-12"
            style={{ minHeight: 96 }}
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
            error={fieldError?.field === 'reason' ? fieldError.message : undefined}
          />
          <TextField
            id="cx-ev-live"
            label="증빙 참조"
            optional
            fieldClassName="lg:col-span-6"
            value={evidenceRef}
            maxLength={200}
            onChange={(e) => setEvidenceRef(e.target.value)}
            hint="파일은 받지 않고 증빙을 찾을 수 있는 참조만 받습니다"
            error={fieldError?.field === 'evidenceRef' ? fieldError.message : undefined}
          />
          <Select
            id="cx-fault-live"
            label="귀책 의견"
            optional
            fieldClassName="lg:col-span-6"
            value={fault}
            onChange={(e) => setFault(e.target.value as FaultChoice)}
            options={FAULT_OPTIONS.map((f) => ({ value: f.value, label: f.label }))}
            hint="참고값입니다. 판정은 PEAKET 운영자가 합니다"
          />
        </div>
        <div className="divider" />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
          <p className="t-sm muted">
            연기가 확정되면 환급을 원하는 예매자에게 위약금 없이 전액 환급합니다. 확정과 귀책 판정은 PEAKET이 하고, 확정되면 예매자 전원에게 환불 일정이 안내됩니다.
          </p>
          <Button className="self-end" size="lg" onClick={openConfirm} disabled={busy || memberDenied || !current} disabledReason={memberDenied ? REQUEST_ADMIN_REASON : undefined}>
            <i className="ic ic-upload" aria-hidden="true" />
            요청 보내기
          </Button>
        </div>
      </section>

      {statusState === 'loading' ? <p className="t-sm muted">요청 상태를 불러오는 중…</p> : null}
      {statusState === 'error' ? <p className="t-sm" role="alert">요청 상태를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.</p> : null}
      {statusState === 'none' ? <p className="t-sm muted">이 회차에는 아직 요청이 없습니다.</p> : null}
      {status && sv ? (
        <section className="card col gap-4 p-4 md:gap-[18px] md:p-6" aria-labelledby="cx-status-h">
          <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start md:justify-between">
            <div className="col" style={{ gap: 2 }}>
              <h2 className="t-md fw-b" id="cx-status-h">
                {current ? kstText(current.startsAt) : status.eventId} 회차 · {status.kind === 'CANCEL' ? '취소' : '연기'} 요청
              </h2>
              <span className="t-xs muted">
                요청 {kstText(status.requestedAt)} · 파트너 관리자
              </span>
            </div>
            <div className="row wrap" style={{ gap: 8 }} role="status">
              <span className={`badge badge-lg ${toneClass}`}>{sv.label}</span>
              {sv.dueText ? <span className="badge badge-lg">{sv.dueText}</span> : null}
            </div>
          </div>

          <ol className="timeline" aria-label="요청 진행 단계">
            <Step dot="ok" title="요청 접수 · 완료" meta={kstText(status.requestedAt)} />
            <Step
              dot={status.fault ? 'ok' : status.status === 'REQUESTED' ? 'info' : undefined}
              title={status.fault ? `판정 · ${faultLabel(status.fault)}` : status.status === 'REQUESTED' ? '귀책 판정 · 진행 중' : '귀책 판정 · 대기'}
              meta={
                status.judgementSummary
                  ? `팬 통지 사유: ${status.judgementSummary}`
                  : status.status === 'REQUESTED'
                    ? 'PEAKET 운영자가 주최 측 귀책, 불가항력, 공연 내용 변경 중 하나로 판정합니다.'
                    : '판정 결과를 기다리고 있습니다.'
              }
            />
            <Step
              dot={status.status === 'APPROVED' || status.status === 'RUNNING' || status.status === 'COMPLETED' ? 'ok' : undefined}
              title={status.status === 'APPROVED' || status.status === 'RUNNING' || status.status === 'COMPLETED' ? '확정 · 완료' : '확정 · 대기'}
              meta={status.status === 'PENDING_APPROVAL' ? '판정한 사람 말고 1명이 더 승인해야 확정됩니다' : '확정되면 예매자 전원에게 환불 일정이 안내됩니다'}
            />
          </ol>

          {status.rejectionReason ? (
            <div className="banner banner-danger" role="alert">
              <div className="banner-body">
                <span className="banner-title">반려 사유</span>
                {status.rejectionReason}
              </div>
            </div>
          ) : null}

          <dl className="t-sm grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 md:grid-cols-[120px_minmax(0,1fr)] md:gap-x-4">
            <dt className="muted">요청 종류</dt>
            <dd>
              {status.kind === 'CANCEL' ? '취소' : '연기'}
              {status.newStartsAt ? ` · 바뀐 일시 ${kstText(status.newStartsAt)}` : ''}
            </dd>
            <dt className="muted">사유</dt>
            <dd>{status.reason ?? '—'}</dd>
            <dt className="muted">증빙 참조</dt>
            <dd>{status.evidenceRef ?? '—'}</dd>
            <dt className="muted">귀책 의견</dt>
            <dd>{status.faultOpinion ? `${faultLabel(status.faultOpinion)}(참고값)` : '의견 없음'}</dd>
          </dl>

          {status.refundProgress ? (
            <div className="card-flat pad col" style={{ gap: 8 }}>
              <div className="row between wrap" style={{ gap: '4px 8px' }}>
                <span className="t-sm fw-b">환불 진행률</span>
                <span className="t-sm num">
                  {status.refundProgress.done}건 완료 / {status.refundProgress.total}건 · {sv.progress?.percent ?? 0}%
                </span>
              </div>
              <ProgressBar value={sv.progress?.percent ?? 0} label="환불 진행률" size="lg" />
              <span className="t-xs muted">실패 {status.refundProgress.failed}건은 PEAKET CS가 따로 처리합니다.</span>
            </div>
          ) : null}

          {status.postponement ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <div className="stat">
                <span className="stat-label">팬 환급 신청</span>
                <span className="stat-value">{status.postponement.refundApplicationCount}건</span>
                <span className="stat-meta">신청 기한 {kstText(status.postponement.refundDeadlineAt)}</span>
              </div>
            </div>
          ) : null}

          {status.compensation ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <div className="stat">
                <span className="stat-label">배상 대상</span>
                <span className="stat-value">{status.compensation.targetCount}명</span>
                <span className="stat-meta">실제 결제 금액의 10%</span>
              </div>
              <div className="stat">
                <span className="stat-label">배상 합계</span>
                <span className="stat-value">{won(status.compensation.totalAmount)}</span>
                <span className="stat-meta">대상 수와 합계만 보입니다</span>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {confirmOpen && current ? (
        <Modal id="cx-confirm-live" defaultOpen labelledBy="cx-confirm-h" describedBy="cx-confirm-d" maxWidth={460}>
          <span className="state-icon is-warning" style={{ width: 48, height: 48 }}>
            <i className="ic ic-alert" aria-hidden="true" />
          </span>
          <h2 className="dialog-title" id="cx-confirm-h">
            회차 {kind === 'CANCEL' ? '취소' : '연기'}를 요청합니다
          </h2>
          <p className="t-md" id="cx-confirm-d">
            요청을 보냅니다. 확정과 귀책 판정은 PEAKET이 합니다
          </p>
          <dl className="kv card-flat pad">
            <dt>회차</dt>
            <dd>{kstText(current.startsAt)}</dd>
            {kind === 'POSTPONE' ? (
              <>
                <dt>바뀐 일시</dt>
                <dd>{kstText(kstLocalToIso(newStartsAtLocal)) || '—'}</dd>
              </>
            ) : null}
            <dt>귀책 의견(참고값)</dt>
            <dd>{FAULT_OPTIONS.find((f) => f.value === fault)?.label ?? '의견 없음'}</dd>
          </dl>
          <p className="t-sm muted">판정은 요청을 받은 뒤 1영업일 안에 합니다. 확정되면 예매자 전원에게 환불 일정이 안내됩니다.</p>
          <div className="dialog-actions">
            <button className="btn btn-ghost" type="button" onClick={() => setConfirmOpen(false)} disabled={busy}>
              돌아가서 고치기
            </button>
            <Button variant="danger" loading={busy} onClick={() => void send()}>
              {kind === 'CANCEL' ? '취소 요청 보내기' : '연기 요청 보내기'}
            </Button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

function faultLabel(v: 'ORGANIZER' | 'FORCE_MAJEURE' | 'CONTENT_CHANGE'): string {
  return v === 'ORGANIZER' ? '주최 측 귀책' : v === 'FORCE_MAJEURE' ? '불가항력' : '공연 내용 변경';
}

function Step({ dot, title, meta }: { dot?: 'ok' | 'info'; title: string; meta: string }) {
  return (
    <li className="tl-item">
      <span className={dot ? `tl-dot ${dot}` : 'tl-dot'} aria-hidden="true" />
      <div className="col" style={{ gap: 2 }}>
        <span className="t-sm fw-b">{title}</span>
        <span className="t-xs muted">{meta}</span>
      </div>
    </li>
  );
}
