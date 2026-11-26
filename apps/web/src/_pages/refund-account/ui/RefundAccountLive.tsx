'use client';
// SCR-060 지연 환급 계좌 입력의 실제 화면(F-07-15 I-05·I-07, d5 §5.34, docs/frontend.md §4.1·§4.2.4).
// 차례: 취소 상세·회차 읽기 → [환급 받기] → 재인증(/reauth/{provider}, purpose refund-account) → 돌아와
// /reauth/token으로 토큰을 메모리에 받음 → 계좌를 다시 입력해 POST /v1/cancellations/{id}/account.
// 계좌는 저장소·주소·로그에 남기지 않고 요청 본문에만 싣는다. 계좌 원문은 응답에도 두지 않는다.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@peaket/ds/Button';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { BankAccountForm } from '@peaket/ds/BankAccountForm';
import { REFUND_BANKS, refundAccountShape } from '@peaket/validation/refund-account';
import { reauthFailureText, REAUTH_UNAVAILABLE } from '@/shared/lib/reauth-failure';
import { pickupReauthToken, submitReauthForm } from '@/shared/lib/reauth-return';
import { AppShell } from '@/widgets/app-shell';
import { REFUND_REAUTH_EXPIRED, REFUND_REAUTH_NOT_SENT } from '../model/copy';
import { cancellationViewOf, type CancellationView } from '../model/live';

const won = (n: number) => `₩${new Intl.NumberFormat('ko-KR').format(n)}`;
const BANKS = REFUND_BANKS.map((b) => ({ value: b.code, label: b.label }));
const textOf = (v: unknown): string => (typeof v === 'string' ? v : '');

type Load = { kind: 'loading' } | { kind: 'ready'; view: CancellationView; eventTitle: string } | { kind: 'error'; text: string; traceId?: string };

interface ProblemLike {
  readonly status?: unknown;
  readonly type?: unknown;
  readonly traceId?: unknown;
}

const typeOf = (v: unknown): string => (typeof v === 'string' ? (v.split('/').pop() ?? '') : '');

function errorText(e: ProblemLike): { text: string; traceId?: string; reauth: boolean } {
  const status = typeof e.status === 'number' ? e.status : 0;
  const type = typeOf(e.type);
  const traceId = status >= 500 && typeof e.traceId === 'string' && e.traceId ? e.traceId : undefined;
  if (status === 403 && type === 'reauth-required') return { text: REFUND_REAUTH_EXPIRED, reauth: true };
  if (status === 503 && type === 'reauth-unavailable') return { text: REAUTH_UNAVAILABLE, reauth: true };
  if (status === 409 && type === 'cancellation-not-account-pending')
    return { text: '이미 환급했거나 지금은 계좌를 입력할 수 없습니다', reauth: false };
  if (status === 422 && type === 'refund-account-required')
    return { text: '환불받을 계좌를 입력해 주세요. 계좌를 넣으면 다시 시도할 수 있습니다', reauth: false };
  if (status === 422 && type === 'refund-rejected')
    return { text: '환급이 거절되었습니다. 고객센터에서 도와드리겠습니다', reauth: false };
  if (status === 400 || status === 422) return { text: '은행과 계좌번호, 예금주를 다시 확인해 주세요', reauth: false, ...(traceId ? { traceId } : {}) };
  return { text: '환급을 요청하지 못했습니다. 잠시 뒤 다시 시도해 주세요', reauth: false, ...(traceId ? { traceId } : {}) };
}

const fieldValue = (form: HTMLFormElement, id: string): string => {
  const el = form.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
  return el?.value ?? '';
};

export function RefundAccountLive({ refundId }: { refundId: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [token, setToken] = useState<string | null>(null);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; traceId?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const started = useRef(false);
  const keyRef = useRef<string | null>(null);

  const loadCancellation = useCallback(async () => {
    setLoad({ kind: 'loading' });
    setError(null);
    try {
      const [{ OPERATIONS }, api] = await Promise.all([import('@peaket/api-client'), import('@/shared/api')]);
      if (!api.fanApiAvailable()) {
        setLoad({ kind: 'error', text: '지금은 환급 계좌를 입력할 수 없습니다. 잠시 뒤 다시 시도해 주세요' });
        return;
      }
      const client = api.browserApiClient();
      if (!client) {
        setLoad({ kind: 'error', text: '지금은 환급 계좌를 입력할 수 없습니다. 잠시 뒤 다시 시도해 주세요' });
        return;
      }
      const r = await api.withFanRefresh(() => client.send(OPERATIONS.getCancellation, { params: { cancellationId: refundId } }));
      const view = cancellationViewOf(r.data);
      if (!view) {
        setLoad({ kind: 'error', text: '취소 정보를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요' });
        return;
      }
      let eventTitle = '';
      const eventId = view.eventId;
      if (eventId) {
        try {
          const ev = await api.withFanRefresh(() => client.send(OPERATIONS.getEvent, { params: { eventId } }));
          const raw = (typeof ev.data === 'object' && ev.data !== null ? ev.data : {}) as Record<string, unknown>;
          eventTitle = textOf(raw.title);
        } catch {
          // 회차 이름은 없어도 환급 계좌 입력은 계속한다
        }
      }
      setLoad({ kind: 'ready', view, eventTitle });
    } catch (e) {
      const mapped = errorText(e as ProblemLike);
      setLoad({ kind: 'error', text: mapped.text, ...(mapped.traceId ? { traceId: mapped.traceId } : {}) });
    }
  }, [refundId]);

  // 처음 한 번: 취소 상세를 읽고, 재인증에서 돌아왔으면 토큰을 한 번 받아 계좌를 다시 받는다.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      await loadCancellation();
      const picked = await pickupReauthToken();
      if (picked.kind === 'token') {
        setToken(picked.token);
        setAwaitingConfirm(true);
        setNotice('다시 로그인한 확인을 마쳤습니다. 계좌를 다시 입력해 주세요');
      } else if (picked.reason !== 'missing') {
        setNotice(`다시 로그인하지 못했습니다: ${reauthFailureText(picked.reason)}`);
      }
    })();
    // 처음 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 재인증으로 떠난다. 계좌는 왕복하는 동안 저장하지 않는다 */
  const startReauth = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const [{ OPERATIONS }, api] = await Promise.all([import('@peaket/api-client'), import('@/shared/api')]);
      const client = api.browserApiClient();
      if (!client) throw new Error('no-client');
      const r = await api.withFanRefresh(() => client.send<{ providers?: { provider?: unknown }[] }>(OPERATIONS.getIdentityProviders));
      const provider = (r.data.providers ?? []).map((p) => p.provider).find((p): p is string => typeof p === 'string' && p.length > 0);
      if (!provider) {
        setNotice('다시 로그인할 수단을 찾지 못했습니다. 로그인 수단을 확인한 뒤 다시 시도해 주세요');
        return;
      }
      keyRef.current ??= crypto.randomUUID();
      submitReauthForm(provider, `/my/refunds/${encodeURIComponent(refundId)}/account`, 'refund-account');
    } catch (e) {
      const mapped = errorText(e as ProblemLike);
      setNotice(mapped.text);
    } finally {
      setBusy(false);
    }
  }, [refundId]);

  const send = useCallback(
    async (reauthToken: string, form: HTMLFormElement) => {
      const shape = refundAccountShape({
        bankCode: fieldValue(form, 'rf-bank'),
        accountNumber: fieldValue(form, 'rf-acct'),
        holderName: fieldValue(form, 'rf-name'),
      });
      if (!shape.ok) {
        setError({ text: '은행과 계좌번호, 예금주를 다시 확인해 주세요' });
        return;
      }
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const [{ OPERATIONS }, api] = await Promise.all([import('@peaket/api-client'), import('@/shared/api')]);
        const client = api.browserApiClient();
        if (!client) throw new Error('no-client');
        keyRef.current ??= crypto.randomUUID();
        const r = await api.withFanRefresh(() =>
          client.send(OPERATIONS.createCancellationAccount, {
            params: { cancellationId: refundId },
            body: shape.value,
            idempotencyKey: keyRef.current!,
            headers: { 'X-Reauth-Token': reauthToken },
          }),
        );
        const view = cancellationViewOf(r.data);
        if (view) setLoad((prev) => (prev.kind === 'ready' ? { ...prev, view } : prev));
        setDone(view?.done === true || view?.status === 'REFUND_PENDING');
        setToken(null);
        setAwaitingConfirm(false);
        keyRef.current = null;
      } catch (e) {
        const mapped = errorText(e as ProblemLike);
        setError({ text: mapped.text, ...(mapped.traceId ? { traceId: mapped.traceId } : {}) });
        if (mapped.reauth) {
          setToken(null);
          setAwaitingConfirm(false);
          setNotice(`${REFUND_REAUTH_EXPIRED}. ${REFUND_REAUTH_NOT_SENT}`);
        }
      } finally {
        setBusy(false);
      }
    },
    [refundId],
  );

  const view = load.kind === 'ready' ? load.view : null;
  const eventTitle = load.kind === 'ready' ? load.eventTitle : '';

  return (
    <AppShell>
      <main className="page-main px-4 pt-4 pb-10 md:px-6 md:pt-8 md:pb-12 lg:pt-10 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[560px] gap-5">
          <div className="col" style={{ gap: 4 }}>
            <Link className="row t-sm gap-0.5 self-start text-(--text-muted)" href="/my/orders">
              <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
              예매·주문 내역
            </Link>
            <h1 className="t-xl">환불 계좌 입력</h1>
            <p className="t-sm muted">가상계좌로 결제해 바로 환급하지 못한 금액을 받을 계좌를 입력합니다</p>
          </div>

          {notice ? <NoticeBanner tone="info" role="status">{notice}</NoticeBanner> : null}
          {error ? (
            <NoticeBanner tone="danger" role="alert">
              {error.text}
              {error.traceId ? (
                <span className="t-xs muted block">
                  문의 번호 <span className="mono">{error.traceId}</span>
                </span>
              ) : null}
            </NoticeBanner>
          ) : null}
          {load.kind === 'loading' ? <p className="t-sm muted">환급 정보를 불러오는 중…</p> : null}
          {load.kind === 'error' ? (
            <div className="card col gap-3 p-4" role="alert">
              <p className="t-md">{load.text}</p>
              {load.traceId ? <p className="t-xs muted">문의 번호 {load.traceId}</p> : null}
              <Button variant="secondary" onClick={() => void loadCancellation()}>
                다시 시도
              </Button>
            </div>
          ) : null}

          {view ? (
            <section className="card-flat col p-4 md:px-5" style={{ gap: 10 }} aria-labelledby="rf-h">
              <span className="eyebrow">환급 대상</span>
              <div className="col" style={{ gap: 2 }}>
                <h2 id="rf-h" className="t-md fw-b">
                  {eventTitle || '취소한 예매'}
                </h2>
                <p className="t-sm muted">취소 사유: {view.reason || '고객 요청'}</p>
              </div>
              <hr className="divider" />
              <dl className="kv">
                <dt>공제({view.deductionPercent}%)</dt>
                <dd className="num">−{won(view.deductionAmount)}</dd>
                <dt>환급액</dt>
                <dd className="kv-total">{won(view.refundAmount)}</dd>
              </dl>
              <p className="t-xs muted">계좌번호는 저장하지 않고 환급 요청에만 씁니다</p>
            </section>
          ) : null}

          {view?.form && !done ? (
            token && awaitingConfirm ? (
              <>
                <NoticeBanner tone="info" role={null}>다시 로그인한 확인을 마쳤습니다. 계좌를 다시 입력해 주세요</NoticeBanner>
                <BankAccountForm
                  idPrefix="rf"
                  purpose="refund"
                  layout="split"
                  label="환불받을 계좌"
                  notice="계좌번호는 저장하지 않고 환급 요청에만 씁니다"
                  banks={BANKS}
                  submitHint="환급 요청은 한 번만 보냅니다"
                  submitLabel="환급 받기"
                  submitting={busy}
                  submittingLabel="환급 요청 중"
                  submittingStatus="환급을 요청하고 있습니다"
                  onSubmit={(e) => void send(token, e.currentTarget)}
                />
              </>
            ) : (
              <BankAccountForm
                idPrefix="rf"
                purpose="refund"
                layout="split"
                label="환불받을 계좌"
                notice="계좌번호는 저장하지 않고 환급 요청에만 씁니다"
                banks={BANKS}
                submitHint="환급을 요청하기 전에 다시 로그인합니다"
                submitLabel="환급 받기"
                submitting={busy}
                submittingLabel="환급 요청 중"
                submittingStatus="환급을 요청하고 있습니다"
                onSubmit={() => void startReauth()}
              />
            )
          ) : null}

          {done || view?.done ? (
            <section className="card col items-start px-5 py-6" style={{ gap: 14 }} role="status">
              <span className="state-icon is-success" style={{ width: 56, height: 56 }}>
                <i className="ic ic-check-circle" aria-hidden="true" />
              </span>
              <h2 className="t-lg">환급을 요청했습니다. 3영업일 안에 입금됩니다</h2>
              <dl className="kv w-full">
                <dt>환급액</dt>
                <dd className="kv-total">{view ? won(view.refundAmount) : ''}</dd>
              </dl>
              <p className="t-xs muted">계좌번호는 저장하지 않아 은행과 끝 4자리만 보입니다</p>
              <Link className="btn btn-secondary btn-block" href="/my/orders">
                예매·주문 내역
              </Link>
            </section>
          ) : null}
        </div>
      </main>
    </AppShell>
  );
}
