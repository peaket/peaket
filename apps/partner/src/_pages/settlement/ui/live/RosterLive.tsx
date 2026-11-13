'use client';
// SCR-027 [예매자 명단]·[다운로드 이력] 실제 API 판(openapi listPartnerEventAttendees·attendee-exports).
// 명단 보기·내려받기는 파트너 관리자만. 내려받기는 비밀번호·TOTP·패스키 재인증(act BOOKER_EXPORT) 뒤에만 된다.
import { useEffect, useState } from 'react';
import { createAttendeeExport, listAttendeeExports, listAttendees } from '@/shared/api/partner-live';
import { isProblem, isRetentionEnded } from '@/shared/api/problem';
import { requestBookerExportReauth } from '@/shared/api/reauth';
import { EmptyCard, ErrorCard, LoadingCard, useAsync } from '@/shared/ui/Async';
import { Modal } from '@/shared/ui/Modal';
import { checkAttendeeExportReason, downloadName, exportCount, exportFormatLabel, exportResult, exportWhen, reauthErrorView } from '../../model/roster-live';

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function AdminLock() {
  return (
    <div className="card-flat pad col" style={{ gap: 6 }}>
      <p className="t-sm fw-b">
        <i className="ic ic-lock" aria-hidden="true" /> 예매자 명단은 파트너 관리자만 볼 수 있습니다
      </p>
      <p className="t-sm muted">명단 내려받기도 파트너 관리자만 할 수 있습니다</p>
    </div>
  );
}

export interface LiveRound {
  eventId: string;
  label: string;
}

export function LiveRosterPanel({ eventName, rounds, isMember }: { eventName: string; rounds: readonly LiveRound[]; isMember: boolean }) {
  const [selected, setSelected] = useState(rounds[0]?.eventId ?? '');
  useEffect(() => {
    if (!rounds.some((r) => r.eventId === selected)) setSelected(rounds[0]?.eventId ?? '');
  }, [rounds, selected]);
  const page = useAsync(`attendees:${selected}:${isMember}`, (signal) =>
    isMember || !selected ? Promise.resolve({ items: [], nextCursor: null }) : listAttendees(selected, { limit: 100 }, signal),
  );
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('현장 명단 대조(동문 입장 확인용)');
  const [format, setFormat] = useState<'CSV' | 'XLSX' | 'PDF'>('XLSX');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (rounds.length === 0) return <EmptyCard title="회차가 없습니다">명단을 볼 회차가 아직 없습니다.</EmptyCard>;
  if (isMember) return <AdminLock />;

  const retention = page.status === 'error' && isRetentionEnded(page.error);
  const forbidden = page.status === 'error' && isProblem(page.error) && page.error.status === 403;

  async function doExport() {
    const reasonError = checkAttendeeExportReason(reason);
    if (reasonError) {
      setError(reasonError);
      return;
    }
    if (!password || !/^[0-9]{3} ?[0-9]{3}$/.test(code.trim())) {
      setError('비밀번호와 인증 앱 6자리 코드를 적어 주세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await requestBookerExportReauth({ password, code: code.trim() });
      const file = await createAttendeeExport(selected, token, { reason: reason.trim(), format });
      saveBlob(file.blob, file.filename || downloadName(eventName, format));
      setOpen(false);
      setPassword('');
      setCode('');
      setMessage('명단을 내려받았습니다. 사유와 건수는 다운로드 이력과 접속기록에 남았습니다.');
    } catch (e) {
      setError(reauthErrorView(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="field" style={{ maxWidth: 360 }}>
        <label className="label" htmlFor="roster-round">
          회차
        </label>
        <div className="input-group input-group-sm">
          <select id="roster-round" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {rounds.map((r) => (
              <option key={r.eventId} value={r.eventId}>
                {r.label}
              </option>
            ))}
          </select>
          <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
        </div>
      </div>
      <div className="banner banner-info" role="note">
        <i className="ic ic-shield" aria-hidden="true" />
        <div className="banner-body">예매 때 받은 제3자 제공 동의 범위의 항목만 보입니다(예매자 이름·휴대폰 번호·예매번호·회차·좌석·매수). 회차가 끝나고 1개월까지 볼 수 있습니다.</div>
      </div>
      {message ? (
        <div className="banner banner-success" role="status">
          <i className="ic ic-check-circle" aria-hidden="true" />
          <div className="banner-body">{message}</div>
        </div>
      ) : null}
      {page.status === 'loading' ? <LoadingCard label="예매자 명단을 불러오는 중입니다" /> : null}
      {retention ? (
        <div className="card-flat pad col" style={{ gap: 6 }}>
          <p className="t-sm fw-b">
            <i className="ic ic-lock" aria-hidden="true" /> 회차가 끝나고 1개월이 지나 명단을 볼 수 없습니다
          </p>
          <p className="t-sm muted">예매 때 받은 제3자 제공 동의의 보유 기간이 끝났습니다.</p>
        </div>
      ) : null}
      {forbidden ? <AdminLock /> : null}
      {page.status === 'error' && !retention && !forbidden ? <ErrorCard error={page.error} onRetry={page.reload} fallback="예매자 명단을 불러오지 못했습니다" /> : null}

      {page.status === 'ready' ? (
        <>
          <div className="row between wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
            <span className="t-sm muted num">
              {page.data.totals ? `예매 ${page.data.totals.bookings.toLocaleString('ko-KR')}건 · ${page.data.totals.tickets.toLocaleString('ko-KR')}매` : `예매자 ${page.data.items.length}명`}
            </span>
            <div className="col" style={{ gap: 4, alignItems: 'flex-end' }}>
              <button className="btn btn-outline" type="button" onClick={() => setOpen(true)} aria-describedby="rs-dl-h">
                <i className="ic ic-download" aria-hidden="true" />
                명단 내려받기
              </button>
              <span className="t-xs muted" id="rs-dl-h">
                파트너 관리자 · 사유를 적고 다시 인증한 뒤 내려받습니다
              </span>
            </div>
          </div>
          {page.data.items.length === 0 ? (
            <EmptyCard title="예매자가 없습니다" />
          ) : (
            <div className="table-wrap table-scroll" role="region" aria-label="예매자 명단 표" tabIndex={0}>
              <table className="table dense">
                <caption className="sr-only">예매자 명단, 동의 범위 항목만 가려서 표시</caption>
                <thead>
                  <tr>
                    <th scope="col">예매자</th>
                    <th scope="col">휴대폰</th>
                    <th scope="col">예매번호</th>
                    <th scope="col">회차(KST)</th>
                    <th scope="col">좌석</th>
                    <th scope="col" className="r">
                      매수
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.data.items.map((r) => (
                    <tr key={r.bookingNo}>
                      <td>{r.name}</td>
                      <td className="mono">{r.phone}</td>
                      <td className="mono">{r.bookingNo}</td>
                      <td className="num">{r.round}</td>
                      <td>{r.seat}</td>
                      <td className="r">{r.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {open ? (
        <Modal id="roster-dl-live" defaultOpen labelledBy="dl-t" describedBy="dl-d" maxWidth={520} sheetOnMobile={false}>
          <h2 className="dialog-title" id="dl-t">
            예매자 명단 내려받기
          </h2>
          <p className="t-sm muted" id="dl-d">
            {eventName} · 동의 범위 항목만 담습니다. 다운로드 사유는 접속기록에 남습니다.
          </p>
          {error ? (
            <div className="banner banner-danger" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              <div className="banner-body">{error}</div>
            </div>
          ) : null}
          <fieldset className="col" role="radiogroup" aria-labelledby="dl-fmt-l">
            <legend className="label" id="dl-fmt-l" style={{ marginBottom: 10 }}>
              파일 형식 (필수)
            </legend>
            <div className="row" style={{ gap: 24 }}>
              {(['CSV', 'XLSX', 'PDF'] as const).map((f) => (
                <label key={f} className="check-row">
                  <input className="rd" type="radio" name="dl-fmt" checked={format === f} onChange={() => setFormat(f)} />
                  {f}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="field">
            <label className="label" htmlFor="dl-reason">
              다운로드 사유 (필수)
            </label>
            <textarea className="input textarea" id="dl-reason" style={{ minHeight: 96 }} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            <span className="hint">사유와 내려받은 건수는 접속기록에 남고 다운로드 이력에서 볼 수 있습니다.</span>
          </div>
          <div className="field">
            <label className="label" htmlFor="dl-pw">
              비밀번호 (필수)
            </label>
            <input className="input" id="dl-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="dl-code">
              인증 앱 코드 (필수)
            </label>
            <input className="input" id="dl-code" type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="000 000" value={code} onChange={(e) => setCode(e.target.value)} />
            <span className="hint">내려받기 전에 등록한 패스키로 한 번 더 확인합니다.</span>
          </div>
          <div className="dialog-actions">
            <button className="btn btn-ghost" type="button" onClick={() => setOpen(false)}>
              닫기
            </button>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void doExport()}>
              {busy ? <span className="spinner" aria-hidden="true" /> : <i className="ic ic-download" aria-hidden="true" />}
              명단 내려받기
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

export function LiveExportLogPanel({ eventName, rounds, isMember }: { eventName: string; rounds: readonly LiveRound[]; isMember: boolean }) {
  const [selected, setSelected] = useState(rounds[0]?.eventId ?? '');
  useEffect(() => {
    if (!rounds.some((r) => r.eventId === selected)) setSelected(rounds[0]?.eventId ?? '');
  }, [rounds, selected]);
  const page = useAsync(`exports:${selected}:${isMember}`, (signal) =>
    isMember || !selected ? Promise.resolve({ items: [], nextCursor: null }) : listAttendeeExports(selected, { limit: 100 }, signal),
  );
  if (rounds.length === 0) return <EmptyCard title="회차가 없습니다">다운로드 이력을 볼 회차가 아직 없습니다.</EmptyCard>;
  if (isMember)
    return (
      <div className="card-flat pad col" style={{ gap: 6 }}>
        <p className="t-sm fw-b">
          <i className="ic ic-lock" aria-hidden="true" /> 다운로드 이력은 파트너 관리자만 볼 수 있습니다
        </p>
      </div>
    );

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="field" style={{ maxWidth: 360 }}>
        <label className="label" htmlFor="log-round">
          회차
        </label>
        <div className="input-group input-group-sm">
          <select id="log-round" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {rounds.map((r) => (
              <option key={r.eventId} value={r.eventId}>
                {r.label}
              </option>
            ))}
          </select>
          <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
        </div>
      </div>
      <div className="banner banner-info" role="note">
        <i className="ic ic-history" aria-hidden="true" />
        <div className="banner-body">예매자 명단을 내려받은 기록입니다. 같은 기록이 PEAKET 접속기록에 2년 이상 남습니다.</div>
      </div>
      <div className="row between wrap" style={{ gap: 8 }}>
        <h3 className="t-md fw-b">내려받은 기록</h3>
        <span className="badge badge-outline">파트너 관리자만 봅니다</span>
      </div>
      {page.status === 'loading' ? <LoadingCard label="다운로드 이력을 불러오는 중입니다" /> : null}
      {page.status === 'error' ? <ErrorCard error={page.error} onRetry={page.reload} fallback="다운로드 이력을 불러오지 못했습니다" /> : null}
      {page.status === 'ready' && page.data.items.length === 0 ? <EmptyCard title="내려받은 기록이 없습니다" /> : null}
      {page.status === 'ready' && page.data.items.length > 0 ? (
        <div className="table-wrap table-scroll" role="region" aria-label="다운로드 이력 표" tabIndex={0}>
          <table className="table dense">
            <caption className="sr-only">{eventName} 예매자 명단 다운로드 이력: 일시, 내려받은 사람, 사유, 건수, 형식, 결과</caption>
            <thead>
              <tr>
                <th scope="col">일시(KST)</th>
                <th scope="col">내려받은 사람</th>
                <th scope="col">사유</th>
                <th scope="col" className="r">
                  건수
                </th>
                <th scope="col">형식</th>
                <th scope="col">결과</th>
              </tr>
            </thead>
            <tbody>
              {page.data.items.map((r) => {
                const result = exportResult(r);
                return (
                  <tr key={r.exportId}>
                    <td className="num">{exportWhen(r)}</td>
                    <td>
                      <div className="col" style={{ gap: 2 }}>
                        <span className="fw-b">{r.actorDisplayName}</span>
                        <span className="t-xs muted">{r.actorRole}</span>
                      </div>
                    </td>
                    <td>{r.reason}</td>
                    <td className={r.result === 'COMPLETED' ? 'r' : 'r muted'}>{exportCount(r)}</td>
                    <td>{exportFormatLabel(r.format)}</td>
                    <td>
                      <span className={result.badge}>{result.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
