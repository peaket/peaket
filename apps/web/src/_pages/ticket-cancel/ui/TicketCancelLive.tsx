'use client';
// SCR-038 예매 취소 실제 화면(d5 §5.20, docs/frontend.md §4.1·§4.2.4, ADR-0328).
// 차례: 티켓·견적 읽기 → 견적의 refundAccountRequired로 재인증 purpose를 정하고 재인증(/reauth/{provider})으로 떠남 →
// 돌아와 /reauth/token으로 토큰을 메모리에 받음 → (계좌가 필요하면) 마지막 확인 안에서 계좌 입력 → POST /v1/tickets/{ticketId}/cancellation.
// 계좌 칸은 재인증에서 돌아온 뒤에만 그린다(왕복은 전체 페이지 이동이라 미리 적은 값이 사라진다, RV-03). 계좌는 저장하지 않고 본문에만 싣는다.
// 카드 끝 4자리는 계약에 없어 '원결제 수단'으로만 쓴다.
// URL의 티켓 한 장만 취소한다(같은 주문의 여러 좌석은 지갑·주문 읽기 계약이 생기는 다음 묶음).
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { Button } from '@peaket/ds/Button';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { refundAccountShape } from '@peaket/validation/refund-account';
import { reauthFailureText } from '@/shared/lib/reauth-failure';
import { pickupReauthToken, submitReauthForm } from '@/shared/lib/reauth-return';
import { AppShell } from '@/widgets/app-shell';
import { errorOf, keyForBody, reauthPurposeOf, sendFailureOf, takePending, writePending, type AttemptKey, type CancelError, type CancelPurpose, type ProblemLike, type StorageLike } from '../model/cancel-flow';
import { quoteView, resultView, refundMethodText, type QuoteView, type ResultView } from '../model/view';

const won = (n: number) => `₩${new Intl.NumberFormat('ko-KR').format(n)}`;

// 계좌 입력과 결과 카드는 그릴 때만 받는다(첫 묶음·실제 화면 첫 묶음에서 뺀다, frontend §5.8)
const AccountSection = dynamic(() => import('./AccountSection').then((m) => m.AccountSection), { ssr: false });
const ResultCard = dynamic(() => import('./ResultCard').then((m) => m.ResultCard), { ssr: false });

interface TicketLine {
  seatLabel: string;
  gateZone: string;
  eventTitle: string;
  placeName: string;
  eventStartsAt: string;
  status: string;
}

const textOf = (v: unknown): string => (typeof v === 'string' ? v : '');

function ticketOf(raw: unknown): TicketLine {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    seatLabel: textOf(t.seatLabel),
    gateZone: textOf(t.gateZone),
    eventTitle: textOf(t.eventTitle),
    placeName: textOf(t.placeName),
    eventStartsAt: textOf(t.eventStartsAt),
    status: textOf(t.status),
  };
}

/** 표준 sessionStorage를 화면 저장소 모양으로 쓴다(브라우저가 막으면 null) */
const tabStore: StorageLike = {
  getItem(k) {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem(k, v) {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      // 저장하지 못하면 돌아온 뒤 이어 가지 못하고 다시 인증한다(계좌·토큰은 원래 저장하지 않는다)
    }
  },
  removeItem(k) {
    try {
      sessionStorage.removeItem(k);
    } catch {
      // 위와 같다
    }
  },
};

type Load = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; text: string; traceId?: string };

export function TicketCancelLive({ ticketId }: { ticketId: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [ticket, setTicket] = useState<TicketLine | null>(null);
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [needAccount, setNeedAccount] = useState(false);
  const [account, setAccount] = useState({ bankCode: '', accountNumber: '', holderName: '' });
  const [accountError, setAccountError] = useState<string | null>(null);
  const [error, setError] = useState<CancelError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResultView | null>(null);
  const started = useRef(false);
  const keyRef = useRef<string | null>(null);
  const attemptRef = useRef<AttemptKey | null>(null);

  const loadTicket = useCallback(async () => {
    setLoad({ kind: 'loading' });
    setError(null);
    try {
      const [{ OPERATIONS }, api] = await Promise.all([import('@peaket/api-client'), import('@/shared/api')]);
      if (!api.fanApiAvailable()) {
        setLoad({ kind: 'error', text: '지금은 예매 취소를 할 수 없습니다. 잠시 뒤 다시 시도해 주세요' });
        return;
      }
      const client = api.browserApiClient();
      if (!client) {
        setLoad({ kind: 'error', text: '지금은 예매 취소를 할 수 없습니다. 잠시 뒤 다시 시도해 주세요' });
        return;
      }
      const t = await api.withFanRefresh(() => client.send(OPERATIONS.getTicket, { params: { ticketId } }));
      const q = await api.withFanRefresh(() => client.send(OPERATIONS.getTicketCancellationQuote, { params: { ticketId } }));
      const qv = quoteView(q.data);
      setTicket(ticketOf(t.data));
      setQuote(qv);
      setNeedAccount(qv.refundAccountRequired);
      setLoad({ kind: 'ready' });
    } catch (e) {
      const mapped = errorOf(e as ProblemLike);
      setLoad({ kind: 'error', text: mapped.text, traceId: mapped.traceId });
    }
  }, [ticketId]);

  // 처음 한 번: 티켓·견적을 읽고, 재인증에서 돌아왔으면 표시를 한 번 꺼내 토큰을 받는다.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      await loadTicket();
      const pending = takePending(tabStore);
      if (!pending || pending.ticketId !== ticketId) return;
      keyRef.current = pending.key;
      const r = await pickupReauthToken();
      if (r.kind === 'token') {
        setToken(r.token);
        setAwaitingConfirm(true);
        setNotice('다시 로그인한 확인을 마쳤습니다. 환급 내용을 확인한 뒤 취소해 주세요');
      } else {
        setNotice(`다시 로그인하지 못했습니다: ${reauthFailureText(r.reason)}`);
      }
    })();
    // 처음 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(
    async (reauthToken: string) => {
      const body: { refundAccount?: { bankCode: string; accountNumber: string; holderName: string } } = needAccount
        ? {
            refundAccount: {
              bankCode: account.bankCode,
              accountNumber: account.accountNumber,
              holderName: account.holderName,
            },
          }
        : {};
      if (needAccount) {
        const shape = refundAccountShape(body.refundAccount);
        if (!shape.ok) {
          setAccountError('은행과 계좌번호, 예금주를 다시 확인해 주세요');
          return;
        }
        body.refundAccount = shape.value;
      }
      setBusy(true);
      setError(null);
      setAccountError(null);
      try {
        const [{ OPERATIONS }, api] = await Promise.all([import('@peaket/api-client'), import('@/shared/api')]);
        const client = api.browserApiClient();
        if (!client) throw new Error('no-client');
        // 같은 본문이면 같은 키, 계좌를 더한 새 본문이면 새 키다(frontend §4.1 '멱등키')
        const attempt = keyForBody(attemptRef.current, body, () => keyRef.current ?? crypto.randomUUID());
        attemptRef.current = attempt;
        keyRef.current = attempt.key;
        // Idempotency-Key는 attempt.key다. 같은 본문의 다시 시도는 같은 키, 계좌를 더한 새 본문은 새 키다.
        const r = await api.withFanRefresh(() =>
          client.send(OPERATIONS.createTicketCancellation, {
            params: { ticketId },
            body,
            idempotencyKey: attempt.key,
            headers: { 'X-Reauth-Token': reauthToken },
          }),
        );
        setResult(resultView(r.data));
        setToken(null);
        setAwaitingConfirm(false);
        setNotice(null);
        attemptRef.current = null;
        keyRef.current = null;
      } catch (e) {
        const mapped = errorOf(e as ProblemLike);
        setError(mapped);
        // 503 reauth-unavailable을 포함한 모든 오류에서 토큰 폐기·확인 화면 소멸은 조건 없이 한다.
        // 403 reauth-required·503은 토큰만 버리고 새 재인증을 받는다. 처리기가 던지면 멱등 키 행이
        // 되돌아가므로 같은 본문은 같은 키로 다시 보낸다(RV-04, platform/idempotency.ts).
        const failed = sendFailureOf(mapped.kind, reauthToken);
        setToken(failed.token);
        setAwaitingConfirm(failed.awaitingConfirm);
        if (failed.resetAttempt) {
          attemptRef.current = null;
          keyRef.current = null;
        }
        if (mapped.kind === 'account-invalid') {
          // 400은 재인증 앞에서 막히므로 토큰을 쓰지 않았다. 계좌만 고쳐 같은 토큰으로 다시 보낼 수 있다
          setAccountError(mapped.text);
          return;
        }
        if (failed.needAccount) {
          setNeedAccount(true);
          setAccountError(null);
        }
      } finally {
        setBusy(false);
      }
    },
    [account, needAccount, ticketId],
  );

  /** 재인증으로 떠난다. purpose는 견적의 refundAccountRequired(또는 422 뒤 계좌 필요)로 정한다 */
  const startReauth = useCallback(
    async (purpose: CancelPurpose) => {
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
        writePending(tabStore, { ticketId, key: keyRef.current });
        submitReauthForm(provider, `/my/tickets/${encodeURIComponent(ticketId)}/cancel`, purpose);
      } catch (e) {
        const mapped = errorOf(e as ProblemLike);
        setNotice(mapped.text);
      } finally {
        setBusy(false);
      }
    },
    [ticketId],
  );

  const purpose: CancelPurpose = needAccount ? 'ticket-cancel-refund-account' : reauthPurposeOf(quote);
  const accountReady = account.bankCode !== '' && account.accountNumber !== '' && account.holderName !== '';
  const canceled = ticket?.status === 'REFUNDED' || ticket?.status === 'VOIDED' || ticket?.status === 'CANCEL_REQUESTED';

  return (
    <AppShell>
      <main className="page-main px-4 pt-4 pb-8 md:px-6 md:pt-5 md:pb-10 lg:px-8 lg:pt-8 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[600px] gap-6 lg:max-w-[976px] lg:gap-7">
          <div className="col gap-2">
            <Link className="row t-sm gap-0.5 self-start text-(--text-muted)" href="/my/tickets">
              <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
              마이 티켓
            </Link>
            <h1 className="t-xl lg:text-2xl">예매 취소</h1>
            {ticket ? (
              <p className="t-sm muted lg:text-md">
                {ticket.eventTitle || '공연'}
                {ticket.placeName ? ` · ${ticket.placeName}` : ''}
                {ticket.seatLabel ? ` · ${ticket.seatLabel}` : ''}
              </p>
            ) : null}
          </div>

          <div className="col gap-3" aria-live="polite">
            {notice ? <NoticeBanner tone="info" role="status">{notice}</NoticeBanner> : null}
            {error ? (
              <NoticeBanner tone={error.kind === 'reauth' || error.kind === 'reauth-unavailable' ? 'warning' : 'danger'} role="alert">
                {error.text}
                {error.kind === 'transfer' ? (
                  <>
                    {' '}
                    <Link className="link" href={`/my/tickets/${encodeURIComponent(ticketId)}/transfer`}>
                      요청 보기
                    </Link>
                  </>
                ) : null}
                {error.kind === 'event-cancelled' || error.kind === 'conflict' || error.kind === 'entry-started' || error.kind === 'not-payer' ? (
                  <>
                    {' '}
                    <Link className="link" href="/my/tickets">
                      예매 내역 보기
                    </Link>
                  </>
                ) : null}
                {error.traceId ? <TraceLine traceId={error.traceId} /> : null}
              </NoticeBanner>
            ) : null}
          </div>

          {load.kind === 'loading' ? <p className="t-sm muted">티켓과 환급액을 불러오는 중…</p> : null}
          {load.kind === 'error' ? (
            <div className="card col gap-3 p-4 md:p-5" role="alert">
              <p className="t-md">{load.text}</p>
              {load.traceId ? <TraceLine traceId={load.traceId} /> : null}
              <Button variant="secondary" onClick={() => void loadTicket()}>
                다시 시도
              </Button>
            </div>
          ) : null}

          {load.kind === 'ready' && quote && ticket ? (
            <>
              {result ? (
                <ResultCard result={result} accountUsed={needAccount && accountReady} />
              ) : (
                <>
                  {canceled ? (
                    <NoticeBanner tone="warning" role="alert">
                      이미 취소된 티켓입니다. 예매 내역에서 진행 상태를 확인해 주세요
                    </NoticeBanner>
                  ) : null}
                  <section className="card col gap-3.5 p-4 md:px-5 md:py-[18px]" aria-labelledby="h-quote">
                    <div className="row between gap-2">
                      <h2 className="t-md fw-b lg:text-lg" id="h-quote">
                        환급 예상액
                      </h2>
                      <span className="badge badge-primary">{ticket.seatLabel || '티켓 1장'}</span>
                    </div>
                    <dl className="kv">
                      <dt>결제 금액</dt>
                      <dd className="num">{won(quote.ticketPrice)}</dd>
                      <dt>취소 수수료{quote.deductionRate > 0 ? `(${Math.round(quote.deductionRate * 100)}%)` : ''}</dt>
                      <dd className="num">{quote.deductionAmount > 0 ? `−${won(quote.deductionAmount)}` : '없음'}</dd>
                      <dt className="kv-total">환급 예상액</dt>
                      <dd className="kv-total num">{won(quote.refundAmount)}</dd>
                      <dt>환급 수단</dt>
                      <dd>{refundMethodText(needAccount, accountReady)}</dd>
                    </dl>
                    {quote.basis ? <p className="t-xs muted">{quote.basis}</p> : null}
                    {quote.refundAfterEntryClose ? (
                      <NoticeBanner tone="warning" role={null} title="입장 기록 마감 뒤 환급">
                        입장이 시작된 뒤 취소하면 티켓은 바로 쓸 수 없게 되고, 환급은 입장 기록 마감 뒤 입장하지 않은 것이 확인되면 실행합니다
                      </NoticeBanner>
                    ) : null}
                  </section>

                  {needAccount ? (
                    <p className="t-sm muted">가상계좌로 결제한 예매라 다시 로그인한 뒤 환불받을 계좌를 받습니다. 계좌는 저장하지 않고 환불 요청에만 씁니다.</p>
                  ) : null}

                  <section className="card col gap-3 p-4 md:px-5 md:py-[18px]" aria-labelledby="h-action">
                    <h2 className="t-md fw-b lg:text-lg" id="h-action">
                      {token && awaitingConfirm ? '마지막 확인' : '다시 로그인하고 계속'}
                    </h2>
                    {token && awaitingConfirm ? (
                      <>
                        <p className="t-sm">
                          {ticket.seatLabel || '이 티켓'}을 취소하고 {won(quote.refundAmount)}을 {refundMethodText(needAccount, accountReady)}으로
                          환급합니다. 취소하면 되돌릴 수 없습니다.
                        </p>
                        {needAccount && token && awaitingConfirm ? (
                          <AccountSection account={account} error={accountError} onChange={setAccount} />
                        ) : null}
                        <div className="col gap-2">
                          <Button variant="danger" size="lg" block loading={busy} onClick={() => void send(token)} disabled={canceled}>
                            예매를 취소하고 {won(quote.refundAmount)}을 환급받습니다
                          </Button>
                          <Button
                            variant="ghost"
                            block
                            disabled={busy}
                            onClick={() => {
                              setToken(null);
                              setAwaitingConfirm(false);
                              keyRef.current = null;
                              attemptRef.current = null;
                              setNotice('예매를 취소하지 않았습니다');
                            }}
                          >
                            예매 유지하기
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="t-sm muted">
                          예매 취소는 되돌릴 수 없어 로그인한 분이 맞는지 한 번 더 확인합니다. 다시 로그인한 뒤 5분 안에 취소를 마쳐야 합니다.
                        </p>
                        <Button
                          size="lg"
                          block
                          loading={busy}
                          disabled={canceled}
                          onClick={() => void startReauth(purpose)}
                        >
                          다시 로그인하고 계속
                        </Button>
                        {error?.kind === 'reauth' || error?.kind === 'reauth-unavailable' ? (
                          <p className="t-xs muted">새로 다시 로그인하면 같은 취소를 이어서 보냅니다.</p>
                        ) : null}
                      </>
                    )}
                  </section>

                  <p className="t-xs muted">
                    환급은 원결제 수단으로 3영업일 안에 시작합니다. 카드사나 은행에 따라 실제로 돌려받는 날은 더 늦을 수 있습니다.{' '}
                    <Link className="link" href="/my/tickets">
                      예매 내역 보기
                    </Link>
                  </p>
                </>
              )}
            </>
          ) : null}
        </div>
      </main>
    </AppShell>
  );
}

/** 5xx에서만 보이는 문의용 번호(G3). 서버 title·detail은 그리지 않는다 */
function TraceLine({ traceId }: { traceId: string }) {
  return (
    <span className="t-xs muted block">
      문의 번호 <span className="mono">{traceId}</span>
    </span>
  );
}
