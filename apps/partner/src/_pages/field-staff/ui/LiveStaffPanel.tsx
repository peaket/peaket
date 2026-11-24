'use client';
// GAT-360 파트너 SCR-037 실제 명단·초대(F-05-8). identity-svc 계약(openapi partner staff)만 부른다.
// - 명단: GET /v1/partner/events/{eventId}/staff (이메일·계정 ID 없음)
// - 초대: POST /v1/partner/events/{eventId}/staff-invitations (1~200명, gate_staff·gate_lead)
// - 재발송: POST /v1/partner/staff/{assignmentId}/invitation, 해제: DELETE /v1/partner/staff/{assignmentId}
// 미리보기(?state=)에서는 기존 목업 StaffPanel을 그대로 쓰고, 이 부품은 실제 경로에서만 쓴다.
import { useCallback, useEffect, useState } from 'react';
import { OPERATIONS, partnerApi } from '@/shared/api';
import { problemMessage } from '@/shared/api/problem';
import { invitationInputOf, staffRowsOf, type StaffRole, type StaffRow } from '../model/live';

type Load = { kind: 'loading' } | { kind: 'ready'; rows: StaffRow[] } | { kind: 'error'; text: string };

const STATUS_BADGE: Record<string, string> = {
  '초대 중': 'badge badge-warning',
  수락: 'badge badge-success',
  해제: 'badge badge-danger',
  종료: 'badge',
  만료: 'badge',
};

function Badge({ status }: { status: string }) {
  return <span className={STATUS_BADGE[status] ?? 'badge'}>{status}</span>;
}

export function LiveStaffPanel({ eventId }: { eventId: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<StaffRole>('gate_staff');
  const [inviteErrors, setInviteErrors] = useState<{ line: number; input: string; reason: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const loadRows = useCallback(async (): Promise<void> => {
    setLoad({ kind: 'loading' });
    try {
      const r = await partnerApi().request<{ items: unknown[]; nextCursor?: string | null }>(OPERATIONS.listPartnerEventStaff, { params: { eventId }, query: { limit: 100 } });
      setLoad({ kind: 'ready', rows: staffRowsOf(r) });
    } catch (e) {
      setLoad({ kind: 'error', text: problemMessage(e, '명단을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요') });
    }
  }, [eventId]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  async function invite(): Promise<void> {
    const input = invitationInputOf(emails, role);
    setInviteErrors(input.errors);
    if (input.errors.length > 0) return;
    setBusy('invite');
    setNotice(null);
    try {
      await partnerApi().request(OPERATIONS.createPartnerEventStaffInvitation, { params: { eventId }, body: { invitations: input.invitations } });
      setEmails('');
      setNotice({ tone: 'ok', text: `${input.invitations.length}명을 초대했습니다` });
      await loadRows();
    } catch (e) {
      setNotice({ tone: 'bad', text: problemMessage(e, '초대하지 못했습니다. 잠시 뒤 다시 시도해 주세요') });
    } finally {
      setBusy(null);
    }
  }

  async function resend(row: StaffRow): Promise<void> {
    setBusy(`resend:${row.id}`);
    setNotice(null);
    try {
      await partnerApi().request(OPERATIONS.createPartnerStaffInvitation, { params: { assignmentId: row.id } });
      setNotice({ tone: 'ok', text: '초대를 다시 보냈습니다' });
      await loadRows();
    } catch (e) {
      setNotice({ tone: 'bad', text: problemMessage(e, '초대를 다시 보내지 못했습니다') });
    } finally {
      setBusy(null);
    }
  }

  async function revoke(row: StaffRow): Promise<void> {
    setBusy(`revoke:${row.id}`);
    setNotice(null);
    try {
      await partnerApi().request(OPERATIONS.deletePartnerStaff, { params: { assignmentId: row.id } });
      setNotice({ tone: 'ok', text: '권한을 해제했습니다' });
      await loadRows();
    } catch (e) {
      setNotice({ tone: 'bad', text: problemMessage(e, '권한을 해제하지 못했습니다') });
    } finally {
      setBusy(null);
    }
  }

  const rows = load.kind === 'ready' ? load.rows : [];

  return (
    <div className="col" style={{ gap: 16 }}>
      <section className="card col gap-4 p-4 md:p-6" aria-labelledby="inv-h">
        <h3 className="t-md fw-b" id="inv-h">
          현장 스태프 초대
        </h3>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="field">
            <span className="label">초대할 이메일 (한 줄에 하나, 최대 200명)</span>
            <textarea className="textarea min-h-32" value={emails} onChange={(e) => setEmails(e.target.value)} inputMode="email" autoComplete="off" />
          </label>
          <fieldset className="col" style={{ gap: 10 }}>
            <legend className="label">역할</legend>
            <label className="check-row">
              <input className="rd" type="radio" name="live-inv-role" checked={role === 'gate_staff'} onChange={() => setRole('gate_staff')} />
              현장 스태프
            </label>
            <label className="check-row">
              <input className="rd" type="radio" name="live-inv-role" checked={role === 'gate_lead'} onChange={() => setRole('gate_lead')} />
              현장 책임자
            </label>
            <button className="btn btn-primary self-start max-md:w-full" type="button" onClick={() => void invite()} disabled={busy !== null}>
              <i className="ic ic-mail" aria-hidden="true" />
              {busy === 'invite' ? '보내는 중…' : '초대 보내기'}
            </button>
          </fieldset>
        </div>
        {inviteErrors.length > 0 ? (
          <div className="banner banner-danger" role="alert">
            <i className="ic ic-alert-circle" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">형식이 맞지 않는 행이 있어 아무도 초대하지 않았습니다({inviteErrors.length}건)</span>
              <ul className="col" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>
                {inviteErrors.map((e) => (
                  <li key={`${e.line}-${e.input}`} className="t-sm">
                    {e.line === 0 ? '' : `${e.line}행 `}
                    {e.input ? `${e.input} — ` : ''}
                    {e.reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        {notice ? (
          <div className={`banner ${notice.tone === 'ok' ? 'banner-info' : 'banner-danger'}`} role="status">
            <div className="banner-body">{notice.text}</div>
          </div>
        ) : null}
      </section>

      <section className="card col gap-3 p-4 md:p-6" aria-labelledby="ros-h">
        <div className="row between wrap" style={{ gap: 8 }}>
          <h3 className="t-md fw-b" id="ros-h">
            배정 명단
          </h3>
          <button className="btn btn-outline btn-sm" type="button" onClick={() => void loadRows()} disabled={busy !== null}>
            <i className="ic ic-refresh" aria-hidden="true" /> 새로 고침
          </button>
        </div>
        {load.kind === 'loading' ? <p className="t-sm muted">불러오는 중…</p> : null}
        {load.kind === 'error' ? (
          <p className="t-sm" role="alert">
            {load.text}
          </p>
        ) : null}
        {load.kind === 'ready' && rows.length === 0 ? <p className="t-sm muted">배정된 현장 스태프가 없습니다.</p> : null}
        {rows.length > 0 ? (
          <>
            <div className="table-wrap table-scroll max-md:hidden">
              <table className="table dense">
                <caption className="sr-only">현장 스태프 배정 명단(닉네임·역할·상태·권한 유효 시간)</caption>
                <thead>
                  <tr>
                    <th scope="col">닉네임</th>
                    <th scope="col">역할</th>
                    <th scope="col">상태</th>
                    <th scope="col">권한 유효 시간</th>
                    <th scope="col">관리</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className={r.nickname ? 'fw-b' : 'muted'}>{r.nickname ?? '수락 전'}</td>
                      <td>{r.role}</td>
                      <td>
                        <Badge status={r.status} />
                      </td>
                      <td className="num">{r.validity || '—'}</td>
                      <td>
                        <div className="row" style={{ gap: 6 }}>
                          {r.canResend ? (
                            <button className="btn btn-outline btn-sm" type="button" disabled={busy !== null} onClick={() => void resend(r)}>
                              재발송
                            </button>
                          ) : null}
                          {r.canRevoke ? (
                            <button className="btn btn-danger-outline btn-sm" type="button" disabled={busy !== null} onClick={() => void revoke(r)}>
                              권한 해제
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="col md:hidden" style={{ gap: 8 }}>
              {rows.map((r) => (
                <li key={r.id} className="card col" style={{ padding: 14, gap: 8 }}>
                  <div className="row between" style={{ gap: 8 }}>
                    <span className={r.nickname ? 't-md fw-b' : 't-md muted'}>{r.nickname ?? '수락 전'}</span>
                    <Badge status={r.status} />
                  </div>
                  <p className="t-sm muted">
                    {r.role} · {r.validity || '유효 시간 없음'}
                  </p>
                  <div className="row" style={{ gap: 8 }}>
                    {r.canResend ? (
                      <button className="btn btn-outline grow" type="button" disabled={busy !== null} onClick={() => void resend(r)}>
                        재발송
                      </button>
                    ) : null}
                    {r.canRevoke ? (
                      <button className="btn btn-danger-outline grow" type="button" disabled={busy !== null} onClick={() => void revoke(r)}>
                        권한 해제
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </div>
  );
}
