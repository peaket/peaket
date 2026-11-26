'use client';
// SCR-043 배상금 계좌 입력의 실제 화면(F-07-15 I-04·I-07, d5 §5.25, docs/frontend.md §4.1·§4.2.4).
// 차례: 배상 건 읽기 → [송금 요청] → 재인증(/reauth/{provider}, purpose compensation-account) → 돌아와
// /reauth/token으로 토큰을 메모리에 받음 → 계좌를 다시 입력해 POST /v1/compensations/{id}/account.
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
import { COMPENSATION_REAUTH_EXPIRED, COMPENSATION_REAUTH_NOT_SENT } from '../model/copy';
import { compensationViewOf, type CompensationView } from '../model/live';

const won = (n: number) => `₩${new Intl.NumberFormat('ko-KR').format(n)}`;
const BANKS = REFUND_BANKS.map((b) => ({ value: b.code, label: b.label }));

type Load = { kind: 'loading' } | { kind: 'ready'; view: CompensationView } | { kind: 'error'; text: string; traceId?: string };

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
  if (status === 403 && type === 'reauth-required') return { text: COMPENSATION_REAUTH_EXPIRED, reauth: true };
  if (status === 503 && type === 'reauth-unavailable') return { text: REAUTH_UNAVAILABLE, reauth: true };
  if (status === 409 && type === 'compensation-not-account-pending') return { text: '이미 지급된 배상금입니다', reauth: false };
  if (status === 422 && type === 'compensation-transfer-failed')
    return { text: '송금이 3회 실패했습니다. 고객센터에서 도와드리겠습니다', reauth: false };
  if (status === 400 || status === 422) return { text: '은행과 계좌번호, 예금주를 다시 확인해 주세요', reauth: false, ...(traceId ? { traceId } : {}) };
  return { text: '송금을 요청하지 못했습니다. 잠시 뒤 다시 시도해 주세요', reauth: false, ...(traceId ? { traceId } : {}) };
}

const fieldValue = (form: HTMLFormElement, id: string): string => {
  const el = form.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
  return el?.value ?? '';
};

export function CompensationLive({ compensationId }: { compensationId: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [token, setToken] = useState<string | null>(null);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; traceId?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const started = useRef(false);
  const keyRef = useRef<string | null>(null);

  const loadCompensation = useCallback(async () => {
    setLoad({ kind: 'loading' });
    setError(null);
    try {
      const [{ OPERATIONS }, api] = await Promise.all([import('@peaket/api-client'), import('@/shared/api')]);
      if (!api.fanApiAvailable()) {
        setLoad({ kind: 'error', text: '지금은 배상금 계좌를 입력할 수 없습니다. 잠시 뒤 다시 시도해 주세요' });
        return;
      }
      const client = api.browserApiClient();
      if (!client) {
        setLoad({ kind: 'error', text: '지금은 배상금 계좌를 입력할 수 없습니다. 잠시 뒤 다시 시도해 주세요' });
        return;
      }
      const r = await api.withFanRefresh(() => client.send(OPERATIONS.getCompensation, { params: { compensationId } }));
      const view = compensationViewOf(r.data);
      if (!view) {
        setLoad({ kind: 'error', text: '배상금 정보를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요' });
        return;
      }
      setLoad({ kind: 'ready', view });
    } catch (e) {
      const mapped = errorText(e as ProblemLike);
      setLoad({ kind: 'error', text: mapped.text, ...(mapped.traceId ? { traceId: mapped.traceId } : {}) });
    }
  }, [compensationId]);

  // 처음 한 번: 배상 건을 읽고, 재인증에서 돌아왔으면 토큰을 한 번 받아 계좌를 다시 받는다.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      await loadCompensation();
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
      submitReauthForm(provider, `/my/compensations/${encodeURIComponent(compensationId)}`, 'compensation-account');
    } catch (e) {
      const mapped = errorText(e as ProblemLike);
      setNotice(mapped.text);
    } finally {
      setBusy(false);
    }
  }, [compensationId]);

  const send = useCallback(
    async (reauthToken: string, form: HTMLFormElement) => {
      const shape = refundAccountShape({
        bankCode: fieldValue(form, 'cp-bank'),
        accountNumber: fieldValue(form, 'cp-acct'),
        holderName: fieldValue(form, 'cp-name'),
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
          client.send(OPERATIONS.createCompensationAccount, {
            params: { compensationId },
            body: shape.value,
            idempotencyKey: keyRef.current!,
            headers: { 'X-Reauth-Token': reauthToken },
          }),
        );
        const view = compensationViewOf(r.data);
        if (view) setLoad({ kind: 'ready', view });
        setDone(view?.requested === true || view?.paid === true);
        setToken(null);
        setAwaitingConfirm(false);
        keyRef.current = null;
      } catch (e) {
        const mapped = errorText(e as ProblemLike);
        setError({ text: mapped.text, ...(mapped.traceId ? { traceId: mapped.traceId } : {}) });
        if (mapped.reauth) {
          setToken(null);
          setAwaitingConfirm(false);
          setNotice(`${COMPENSATION_REAUTH_EXPIRED}. ${COMPENSATION_REAUTH_NOT_SENT}`);
        }
      } finally {
        setBusy(false);
      }
    },
    [compensationId],
  );

  const view = load.kind === 'ready' ? load.view : null;

  return (
    <AppShell>
      <main className="page-main px-4 pt-4 pb-10 md:px-6 md:pt-8 md:pb-12 lg:pt-10 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[560px] gap-5">
          <div className="col" style={{ gap: 4 }}>
            <Link className="row t-sm gap-0.5 self-start text-(--text-muted)" href="/my/orders">
              <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
              예매·주문 내역
            </Link>
            <h1 className="t-xl">배상금 계좌 입력</h1>
            <p className="t-sm muted">배상금을 받을 계좌를 입력합니다</p>
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
          {load.kind === 'loading' ? <p className="t-sm muted">배상금 정보를 불러오는 중…</p> : null}
          {load.kind === 'error' ? (
            <div className="card col gap-3 p-4" role="alert">
              <p className="t-md">{load.text}</p>
              {load.traceId ? <p className="t-xs muted">문의 번호 {load.traceId}</p> : null}
              <Button variant="secondary" onClick={() => void loadCompensation()}>
                다시 시도
              </Button>
            </div>
          ) : null}

          {view ? (
            <section className="card-flat col p-4 md:px-5" style={{ gap: 10 }} aria-labelledby="cp-h">
              <span className="eyebrow">배상 사유</span>
              <h2 id="cp-h" className="t-md fw-b">
                {view.reasonText}
              </h2>
              <hr className="divider" />
              <dl className="kv">
                <dt>배상금</dt>
                <dd className="kv-total">{won(view.amount)}</dd>
                {view.accountLast4 ? (
                  <>
                    <dt>지급 계좌</dt>
                    <dd>끝 {view.accountLast4}</dd>
                  </>
                ) : null}
              </dl>
              <p className="t-sm muted">분쟁해결기준에 따른 배상금입니다</p>
            </section>
          ) : null}

          {view?.form && !done ? (
            token && awaitingConfirm ? (
              <>
                <NoticeBanner tone="info" role={null}>다시 로그인한 확인을 마쳤습니다. 계좌를 다시 입력해 주세요</NoticeBanner>
                <BankAccountForm
                  idPrefix="cp"
                  purpose="compensation"
                  layout="split"
                  label="배상금 받을 계좌"
                  notice="계좌번호는 저장하지 않고 송금에만 씁니다"
                  banks={BANKS}
                  submitHint="송금 요청은 한 번만 보냅니다"
                  submitLabel="송금 요청"
                  submitting={busy}
                  submittingLabel="송금 요청 중"
                  submittingStatus="송금을 요청하고 있습니다"
                  onSubmit={(e) => void send(token, e.currentTarget)}
                />
              </>
            ) : (
              <BankAccountForm
                idPrefix="cp"
                purpose="compensation"
                layout="split"
                label="배상금 받을 계좌"
                notice="계좌번호는 저장하지 않고 송금에만 씁니다"
                banks={BANKS}
                submitHint="송금을 요청하기 전에 다시 로그인합니다"
                submitLabel="송금 요청"
                submitting={busy}
                submittingLabel="송금 요청 중"
                submittingStatus="송금을 요청하고 있습니다"
                onSubmit={() => void startReauth()}
              />
            )
          ) : null}

          {view?.paid || done ? (
            <section className="card col items-start px-5 py-6" style={{ gap: 14 }} role="status">
              <span className="state-icon is-success" style={{ width: 56, height: 56 }}>
                <i className="ic ic-check-circle" aria-hidden="true" />
              </span>
              <h2 className="t-lg">{view?.paid ? '이미 지급된 배상금입니다' : '송금을 요청했습니다'}</h2>
              <dl className="kv w-full">
                <dt>배상금</dt>
                <dd>{view ? won(view.amount) : ''}</dd>
              </dl>
              <Link className="btn btn-secondary btn-block" href="/my/orders">
                예매·주문 내역
              </Link>
            </section>
          ) : null}

          {view?.failed ? (
            <NoticeBanner tone="danger" role="alert" title="송금하지 못했습니다">
              고객센터에서 도와드리겠습니다. 계좌를 다시 확인한 뒤 새로 요청해 주세요
            </NoticeBanner>
          ) : null}
        </div>
      </main>
    </AppShell>
  );
}
