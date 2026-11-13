// SCR-053 연결 화면: ticket-svc 스캐너 기기 API(ops-api 경유)로 목록·등록 코드·폐기를 한다.
// 디자인 보드(ui/board-*.tsx)는 미리보기(?state=)에 남기고, 실제 경로는 이 화면을 쓴다(d5 §7.11, offline-gate §6.1·§8).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useChosenRole, usePreviewHost } from '@/features/preview-host';
import { ensureConsoleApi, opsApiAvailable } from '@/shared/api';
import { SCANNER_ORIGIN } from '@/shared/config/origins';
import { Overlay } from '@/shared/ui/Overlay';
import {
  type DeviceRow,
  type DeviceStatus,
  enrollmentCodeNotice,
  enrollmentUrl,
  filterDevices,
  formatKstDate,
  formatKstDateTime,
  mapDeviceList,
  promoterLabel,
  relativeLastSeen,
  statusLabel,
  statusTone,
} from '../model/devices';

type Load = { kind: 'loading' } | { kind: 'ready'; items: DeviceRow[]; nextCursor: string | null } | { kind: 'error'; message: string } | { kind: 'config' };
interface Promoter {
  promoterId: string;
  legalName: string;
}
interface CodeState {
  deviceId: string;
  code: string;
  expiresAt: string;
}

const NOW = () => Date.now();

export function ConnectedPage() {
  const role = useChosenRole() ?? 'operator';
  const canAct = role === 'operator' || role === 'commander';
  usePreviewHost({ scope: { stage: '현장' }, control: { kind: 'ok' } }, []);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [promoters, setPromoters] = useState<readonly Promoter[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [partnerFilter, setPartnerFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<DeviceStatus | 'ALL'>('ALL');
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerName, setRegisterName] = useState('');
  const [registerPartner, setRegisterPartner] = useState('');
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState('');
  const [code, setCode] = useState<CodeState | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const notify = useCallback((text: string) => {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const refresh = useCallback(async () => {
    if (!ensureConsoleApi()) {
      setLoad({ kind: 'config' });
      return;
    }
    setLoad({ kind: 'loading' });
    try {
      const [{ listOpsScannerDevices, listOpsPromoters }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const [devices, partners] = await Promise.all([
        listOpsScannerDevices({ limit: 100 }),
        listOpsPromoters({ limit: 100 }).catch(() => null),
      ]);
      const page = mapDeviceList(devices.data);
      setLoad({ kind: 'ready', ...page });
      setSelectedId((prev) => prev ?? page.items[0]?.deviceId ?? null);
      if (partners) {
        setPromoters((partners.data.items ?? []).flatMap((p) => (p.promoterId ? [{ promoterId: p.promoterId, legalName: p.legalName ?? promoterLabel(p.promoterId) }] : [])));
      }
    } catch {
      setLoad({ kind: 'error', message: '기기 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const tick = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => {
      clearInterval(tick);
      clearTimeout(toastTimer.current);
    };
  }, [refresh]);

  const items = load.kind === 'ready' ? load.items : [];
  const filtered = useMemo(() => filterDevices(items, { promoterId: partnerFilter, status: statusFilter }), [items, partnerFilter, statusFilter]);
  const selected = items.find((d) => d.deviceId === selectedId) ?? null;
  const partnerName = (id: string) => promoters.find((p) => p.promoterId === id)?.legalName ?? promoterLabel(id);

  useEffect(() => {
    if (!code) {
      setQr(null);
      return;
    }
    let live = true;
    void QRCode.toDataURL(enrollmentUrl(code.code, SCANNER_ORIGIN), { margin: 1, width: 180, errorCorrectionLevel: 'M' }).then(
      (url) => {
        if (live) setQr(url);
      },
      () => {
        if (live) setQr(null);
      },
    );
    return () => {
      live = false;
    };
  }, [code]);

  const register = async () => {
    if (busy || !registerName.trim() || !registerPartner) return;
    setBusy(true);
    try {
      const [{ createOpsScannerDevice }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await createOpsScannerDevice({ name: registerName.trim(), promoterId: registerPartner });
      setRegisterOpen(false);
      setRegisterName('');
      setRegisterPartner('');
      if (r.data.deviceId && r.data.enrollmentCode && r.data.enrollmentCodeExpiresAt) {
        setCode({ deviceId: r.data.deviceId, code: r.data.enrollmentCode, expiresAt: r.data.enrollmentCodeExpiresAt });
        setSelectedId(r.data.deviceId);
      }
      notify('기기를 등록했습니다. 등록 코드를 스캐너 앱에 입력하세요.');
      await refresh();
    } catch {
      notify('기기를 등록하지 못했습니다. 입력과 권한을 확인해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const issueCode = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const [{ createOpsScannerDeviceEnrollmentCode }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await createOpsScannerDeviceEnrollmentCode(selected.deviceId);
      if (r.data.enrollmentCode && r.data.enrollmentCodeExpiresAt) {
        setCode({ deviceId: selected.deviceId, code: r.data.enrollmentCode, expiresAt: r.data.enrollmentCodeExpiresAt });
      }
    } catch {
      notify('등록 코드를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!selected || busy || revokeReason.trim() === '') return;
    setBusy(true);
    try {
      const [{ createOpsScannerDeviceRevocation }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      await createOpsScannerDeviceRevocation(selected.deviceId, { reason: revokeReason.trim() });
      setRevokeOpen(false);
      setRevokeReason('');
      setCode(null);
      notify('기기를 폐기했습니다. 이 기기의 다음 요청부터 막힙니다.');
      await refresh();
    } catch {
      notify('기기를 폐기하지 못했습니다. 사유와 권한을 확인해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.code);
      notify('등록 코드를 복사했습니다.');
    } catch {
      notify(`등록 코드를 직접 입력해 주세요: ${code.code}`);
    }
  };

  if (load.kind === 'config') {
    return (
      <section className="widget" role="alert">
        <h1 className="t-xl">스캐너 기기 관리</h1>
        <p className="t-sm muted">관제 API 주소가 설정되지 않아 기기 목록을 부를 수 없습니다. 빌드의 `PEAKET_OPS_API_ORIGIN`을 확인해 주세요.</p>
      </section>
    );
  }

  return (
    <>
      <div className="row between" style={{ alignItems: 'flex-end', gap: 24 }}>
        <div className="col" style={{ gap: 4 }}>
          <h1 className="t-xl">스캐너 기기 관리</h1>
          <p className="t-sm muted">현장 스캐너 기기를 등록해 한 파트너에 배정하고, 분실·도난이면 즉시 폐기합니다.</p>
        </div>
        <button className="btn btn-primary" type="button" onClick={() => setRegisterOpen(true)} disabled={!canAct} title={canAct ? undefined : 'viewer는 기기를 등록할 수 없습니다'}>
          <i className="ic ic-plus" aria-hidden="true" />
          기기 등록하기
        </button>
      </div>

      <div className="grid-12" style={{ rowGap: 16, alignItems: 'start', marginTop: 16 }}>
        <div className="span-8 col" style={{ gap: 16 }}>
          <section className="widget" aria-labelledby="h-dev">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-dev">
                기기 {filtered.length}대
              </h2>
              <div className="actions" style={{ gap: 8 }}>
                <label className="t-xs muted" htmlFor="f-pt">파트너</label>
                <div className="input-group input-group-sm" style={{ width: 210, height: 32 }}>
                  <select id="f-pt" value={partnerFilter} onChange={(e) => setPartnerFilter(e.currentTarget.value)}>
                    <option value="">전체 파트너</option>
                    {promoters.map((p) => (
                      <option key={p.promoterId} value={p.promoterId}>{p.legalName}</option>
                    ))}
                  </select>
                  <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
                </div>
                <label className="t-xs muted" htmlFor="f-st">상태</label>
                <div className="input-group input-group-sm" style={{ width: 140, height: 32 }}>
                  <select id="f-st" value={statusFilter} onChange={(e) => setStatusFilter(e.currentTarget.value as DeviceStatus | 'ALL')}>
                    <option value="ALL">전체 상태</option>
                    <option value="ACTIVE">사용 중</option>
                    <option value="REVOKED">폐기됨</option>
                    <option value="RETIRED">퇴역</option>
                  </select>
                  <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
                </div>
              </div>
            </div>
            {load.kind === 'loading' ? (
              <p className="t-sm muted" role="status" aria-busy="true" style={{ padding: 16 }}>기기 목록을 불러오는 중입니다…</p>
            ) : load.kind === 'error' ? (
              <div className="state" style={{ padding: 24 }} role="alert">
                <p className="t-md">{load.message}</p>
                <button className="btn btn-secondary" type="button" onClick={() => void refresh()}>다시 불러오기</button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="state" style={{ padding: 24 }}>
                <p className="t-lg">등록된 기기가 없습니다</p>
                <p className="t-sm muted">기기를 등록하면 이곳에 이름·배정 파트너·상태와 마지막 연락이 보입니다.</p>
              </div>
            ) : (
              <table className="table dense">
                <caption className="sr-only">스캐너 기기 목록. 이름을 누르면 오른쪽에 상세가 열립니다</caption>
                <thead>
                  <tr>
                    <th scope="col">이름</th>
                    <th scope="col">배정 파트너</th>
                    <th scope="col">상태</th>
                    <th scope="col">키 등록일·인증서 만료</th>
                    <th scope="col">마지막 연락</th>
                    <th scope="col">로그인 세션</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.deviceId} className={d.deviceId === selectedId ? 'is-selected' : undefined}>
                      <td>
                        <button className="fw-b" type="button" style={{ color: 'inherit', background: 'none', border: 0, padding: 0 }} onClick={() => { setSelectedId(d.deviceId); setCode(null); }} aria-current={d.deviceId === selectedId ? 'true' : undefined}>
                          {d.name}
                        </button>
                      </td>
                      <td>{partnerName(d.promoterId)}</td>
                      <td><span className={`badge badge-${statusTone(d.status)}`}>{statusLabel(d.status)}</span></td>
                      <td title={d.credentialType === 'DEVICE_KEY' ? '기기 키는 만료가 없고 API에 등록일이 없습니다' : undefined}>{d.credentialType === 'MTLS_CERT' ? formatKstDate(d.certExpiresAt) : '—'}</td>
                      <td>{relativeLastSeen(d.lastSeenAt, NOW())}</td>
                      <td>{d.activeSessionNickname ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <aside className="span-4 col" style={{ gap: 16 }}>
          <section className="widget" aria-labelledby="h-detail">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-detail">기기 상세</h2></div>
            {!selected ? (
              <p className="t-sm muted" style={{ padding: 16 }}>왼쪽에서 기기를 고르세요.</p>
            ) : (
              <div className="col" style={{ gap: 12, padding: 16 }}>
                <div className="row between" style={{ gap: 8 }}>
                  <strong className="t-lg">{selected.name}</strong>
                  <span className={`badge badge-${statusTone(selected.status)}`}>{statusLabel(selected.status)}</span>
                </div>
                <dl className="col" style={{ gap: 6 }}>
                  <div className="row between"><dt className="t-sm muted">배정 파트너</dt><dd className="t-sm">{partnerName(selected.promoterId)}</dd></div>
                  <div className="row between"><dt className="t-sm muted">기기 자격</dt><dd className="t-sm">{selected.credentialType === 'DEVICE_KEY' ? '기기 키 + DPoP' : 'mTLS 인증서'}</dd></div>
                  <div className="row between"><dt className="t-sm muted">마지막 연락</dt><dd className="t-sm">{formatKstDateTime(selected.lastSeenAt)}</dd></div>
                  <div className="row between"><dt className="t-sm muted">로그인 세션</dt><dd className="t-sm">{selected.activeSessionNickname ?? '없음'}</dd></div>
                </dl>
                {code && code.deviceId === selected.deviceId ? (
                  <div className="card col" style={{ gap: 8, padding: 12 }} role="status">
                    <p className="t-sm fw-b">등록 코드 <span className="mono">{code.code}</span></p>
                    {qr ? <img src={qr} width={180} height={180} alt={`등록 코드 QR, ${code.code}`} /> : <p className="t-xs muted">QR을 만드는 중입니다…</p>}
                    <p className="t-xs muted">{enrollmentCodeNotice(code.expiresAt, NOW())}</p>
                    <div className="row" style={{ gap: 8 }}>
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => void copyCode()}>코드 복사</button>
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => void issueCode()} disabled={!canAct || busy}>새 코드 만들기</button>
                    </div>
                  </div>
                ) : (
                  <button className="btn btn-secondary" type="button" onClick={() => void issueCode()} disabled={!canAct || busy || selected.status !== 'ACTIVE'}>
                    등록 코드 만들기
                  </button>
                )}
                <button className="btn btn-danger" type="button" onClick={() => setRevokeOpen(true)} disabled={!canAct || busy || selected.status !== 'ACTIVE'}>
                  <i className="ic ic-alert" aria-hidden="true" />
                  즉시 폐기
                </button>
                <p className="t-xs muted">폐기하면 이 기기의 다음 요청부터 막히고 로그인한 스태프 세션이 끝납니다.</p>
              </div>
            )}
          </section>
        </aside>
      </div>

      {registerOpen ? (
        <Overlay onClose={() => setRegisterOpen(false)}>
          <form className="card col" role="dialog" aria-modal="true" aria-labelledby="h-register" style={{ gap: 12, padding: 20, width: 420, maxWidth: '92vw' }} onSubmit={(e) => { e.preventDefault(); void register(); }}>
            <h2 className="t-lg" id="h-register">기기 등록</h2>
            <label className="col" style={{ gap: 4 }}><span className="t-sm fw-b">기기 이름</span><input className="input" autoFocus value={registerName} onChange={(e) => setRegisterName(e.currentTarget.value)} required maxLength={60} /></label>
            <label className="col" style={{ gap: 4 }}><span className="t-sm fw-b">배정 파트너</span>
              <select className="input" value={registerPartner} onChange={(e) => setRegisterPartner(e.currentTarget.value)} required>
                <option value="">고르세요</option>
                {promoters.map((p) => <option key={p.promoterId} value={p.promoterId}>{p.legalName}</option>)}
              </select>
            </label>
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" type="button" onClick={() => setRegisterOpen(false)}>닫기</button>
              <button className="btn btn-primary" type="submit" disabled={busy || !registerName.trim() || !registerPartner}>{busy ? '등록 중…' : '등록'}</button>
            </div>
          </form>
        </Overlay>
      ) : null}

      {revokeOpen && selected ? (
        <Overlay onClose={() => setRevokeOpen(false)}>
          <form className="card col" role="alertdialog" aria-modal="true" aria-labelledby="h-revoke" style={{ gap: 12, padding: 20, width: 460, maxWidth: '92vw' }} onSubmit={(e) => { e.preventDefault(); void revoke(); }}>
            <h2 className="t-lg" id="h-revoke">기기를 폐기할까요?</h2>
            <p className="t-sm">폐기하면 이 기기의 다음 요청부터 막히고 로그인한 스태프 세션이 끝납니다. 되돌리려면 다시 등록해야 합니다.</p>
            <label className="col" style={{ gap: 4 }}><span className="t-sm fw-b">사유 (필수)</span><textarea className="input" autoFocus value={revokeReason} onChange={(e) => setRevokeReason(e.currentTarget.value)} required maxLength={500} rows={3} /></label>
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" type="button" onClick={() => setRevokeOpen(false)}>그대로 두기</button>
              <button className="btn btn-danger" type="submit" disabled={busy || revokeReason.trim() === ''}>{busy ? '폐기 중…' : '폐기합니다'}</button>
            </div>
          </form>
        </Overlay>
      ) : null}

      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[101] flex justify-center px-4" role="status" aria-live="polite">
        {toast ? <div className="toast"><i className="ic ic-info" aria-hidden="true" /><span>{toast}</span></div> : null}
      </div>
    </>
  );
}
