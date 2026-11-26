'use client';
// SCR-014 티켓 양도 실제 화면(F-05-2, d5 §5.14). 상세 → 회원 코드 확인 → 재인증(/reauth/{provider}) 왕복 →
// 돌아와 /reauth/token으로 토큰을 메모리에 받음 → 법정 고지 확인 → 양도 요청. 진행 중 요청은 남은 시간과 [요청 철회]를 보인다.
// 재인증 토큰은 메모리에만 두고 X-Reauth-Token 머리로만 보낸다(ASVS 3.3.4). 주소·본문·저장소에 싣지 않는다.
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@peaket/ds/Badge';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { TransferOfferCard } from '@peaket/ds/TransferOfferCard';
import { createEventSummaryReader, type EventSummary } from '@/entities/event-summary';
import { reauthFailureText } from '@/shared/lib/reauth-failure';
import { pickupReauthToken, submitReauthForm } from '@/shared/lib/reauth-return';
import { ORIGINS } from '@/shared/config/origins';
import {
  loadLinkedProviders,
  loadTransferTicket,
  lookupRecipient,
  reauthProviderFor,
  recipientRefUsable,
  remainingText,
  sendTransferRequest,
  transferAttemptFor,
  transferFailureOf,
  transferReauthTarget,
  transferStateOf,
  withdrawTransferRequest,
  type Net,
  type TransferTicketBody,
} from '../model/transfer-flow';
import { transferView } from '../model/view';

const LEGAL_RESALE_NOTICE =
  '매크로 등으로 판매자가 정한 공정한 구입 과정을 우회하거나 방해하여 되팔 목적으로 입장권을 구매하는 부정구매와, 판매자의 동의 없이 상습 또는 영업으로 자신이 구입한 가격보다 비싸게 입장권을 판매하거나 알선하는 부정판매는 1년 이하의 징역 또는 1천만원 이하의 벌금에 처해질 수 있습니다(공연법 §41). 부정판매에는 판매금액의 50배 이하의 과징금이 부과될 수 있습니다(공연법 §4의4).';

const PENDING_KEY = 'peaket.transfer.reauth';
interface Pending {
  readonly ticketId: string;
  readonly key: string;
  readonly recipientRef: string;
  readonly lookedUpAtMs: number;
}

function readPending(ticketId: string): Pending | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Pending;
    return v.ticketId === ticketId && typeof v.key === 'string' && typeof v.recipientRef === 'string' ? v : null;
  } catch {
    return null;
  }
}
function writePending(p: Pending): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    // 저장하지 못하면 돌아온 뒤 다시 인증한다(토큰은 원래 저장하지 않는다)
  }
}
function clearPending(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // 위와 같다
  }
}

type Failure = { readonly state: string; readonly text: string };
type Load = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; text: string };

export function TicketTransferLive({ ticketId }: { ticketId: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [ticket, setTicket] = useState<TransferTicketBody | null>(null);
  const [summary, setSummary] = useState<EventSummary | null>(null);
  const [recipientRef, setRecipientRef] = useState<string | null>(null);
  const [nickname, setNickname] = useState<string | null>(null);
  const [lookedUpAtMs, setLookedUpAtMs] = useState<number | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'CODE' | 'PHONE'>('CODE');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const withdrawKeyRef = useRef<string | null>(null);

  const net = useCallback((): Net | null => (ORIGINS.api === '' ? null : { origin: ORIGINS.api, fetch: globalThis.fetch }), []);

  const reload = useCallback(async (): Promise<TransferTicketBody | null> => {
    const n = net();
    if (n === null) {
      setLoad({ kind: 'error', text: '지금은 양도할 수 없습니다. 잠시 뒤 다시 시도해 주세요' });
      return null;
    }
    const r = await loadTransferTicket({ ticketId, ...n });
    if (r.kind !== 'ok') {
      setLoad({ kind: 'error', text: r.kind === 'network' ? '연결을 확인한 뒤 다시 시도해 주세요' : '티켓을 불러오지 못했습니다' });
      return null;
    }
    setTicket(r.body);
    setLoad({ kind: 'ready' });
    if (r.body.eventId) {
      const answer = await createEventSummaryReader(n).read(r.body.eventId);
      if (answer.kind === 'ok') setSummary(answer.summary);
    }
    return r.body;
  }, [net, ticketId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await reload();
      if (cancelled) return;
      const pending = readPending(ticketId);
      if (pending === null) return;
      keyRef.current = pending.key;
      setRecipientRef(pending.recipientRef);
      setLookedUpAtMs(pending.lookedUpAtMs);
      const r = await pickupReauthToken();
      if (cancelled) return;
      if (r.kind === 'token') {
        setToken(r.token);
        setNotice('다시 로그인한 확인을 마쳤습니다. 법정 고지를 확인한 뒤 양도 요청을 보내 주세요');
      } else {
        setNotice(`다시 로그인하지 못했습니다: ${reauthFailureText(r.reason)}`);
      }
      clearPending();
    })();
    return () => {
      cancelled = true;
    };
  }, [reload, ticketId]);

  const lookup = async () => {
    const n = net();
    const value = mode === 'PHONE' ? phone.trim() : code.trim();
    if (n === null || value === '') return;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    const r = mode === 'PHONE' ? await lookupRecipient({ phoneNumber: value, ...n }) : await lookupRecipient({ memberCode: value, ...n });
    setBusy(false);
    if (r.kind === 'network') {
      setFailure({ state: '확인 시도 초과', text: '연결을 확인한 뒤 다시 시도해 주세요' });
      return;
    }
    if (r.kind === 'problem') {
      const f = transferFailureOf('lookup', r);
      setFailure(f);
      return;
    }
    setRecipientRef(r.body.recipientRef);
    setNickname(r.body.nicknameMasked);
    setLookedUpAtMs(Date.now());
    const prev = keyRef.current !== null && recipientRef !== null ? { recipientRef, key: keyRef.current } : null;
    keyRef.current = transferAttemptFor(prev, r.body.recipientRef, () => crypto.randomUUID()).key;
  };

  const startReauth = async () => {
    const n = net();
    if (n === null || recipientRef === null) return;
    setBusy(true);
    setFailure(null);
    const providers = await loadLinkedProviders(n);
    const provider = reauthProviderFor(providers);
    setBusy(false);
    if (provider === undefined) {
      setNotice('다시 로그인할 수단을 찾지 못했습니다. 로그인 수단을 확인한 뒤 다시 시도해 주세요');
      return;
    }
    const target = transferReauthTarget(ticketId);
    writePending({ ticketId, key: keyRef.current ?? crypto.randomUUID(), recipientRef, lookedUpAtMs: lookedUpAtMs ?? Date.now() });
    submitReauthForm(provider, target.returnTo, target.purpose);
  };

  const send = async () => {
    const n = net();
    if (n === null || recipientRef === null || token === null) return;
    if (lookedUpAtMs !== null && !recipientRefUsable(lookedUpAtMs, Date.now())) {
      setFailure({ state: '받는 사람 확인', text: '받는 분 확인이 오래되어 다시 확인해 주세요' });
      setRecipientRef(null);
      setToken(null);
      return;
    }
    setBusy(true);
    setFailure(null);
    const r = await sendTransferRequest({ ticketId, recipientRef, reauthToken: token, idempotencyKey: keyRef.current ?? crypto.randomUUID(), ...n });
    setBusy(false);
    if (r.kind === 'network') {
      setNotice('전송 결과를 확인하지 못했습니다. 다시 인증한 뒤 같은 요청으로 이어서 보냅니다');
      return;
    }
    if (r.kind === 'problem') {
      const f = transferFailureOf('request', r, ticket?.transferLockExpiresAt ? { lockExpiresAt: ticket.transferLockExpiresAt } : {});
      setFailure(f);
      if (r.status === 403) setToken(null);
      if (f.relookup) {
        setRecipientRef(null);
        setLookedUpAtMs(null);
        keyRef.current = null;
      }
      return;
    }
    setToken(null);
    clearPending();
    setNotice('양도 요청을 보냈습니다. 받는 분이 수락하면 티켓이 넘어갑니다');
    await reload();
  };

  const withdraw = async () => {
    const n = net();
    const offerId = ticket?.pendingTransfer?.offerId;
    if (n === null || offerId === undefined) return;
    setBusy(true);
    setFailure(null);
    withdrawKeyRef.current ??= crypto.randomUUID();
    const r = await withdrawTransferRequest({ offerId, idempotencyKey: withdrawKeyRef.current, ...n });
    setBusy(false);
    if (r.kind === 'network') {
      setNotice('연결이 끊겨 철회하지 못했습니다. 같은 요청으로 다시 시도해 주세요');
      return;
    }
    if (r.kind === 'problem') {
      setFailure(transferFailureOf('withdraw', r));
      return;
    }
    withdrawKeyRef.current = null;
    setNotice('양도 요청을 철회했습니다');
    await reload();
  };

  const state = failure?.state ?? (ticket ? transferStateOf(ticket, Date.now()) : '받는 사람 확인');
  const v = transferView(state as Parameters<typeof transferView>[0]);
  const title = summary?.title ?? '양도할 티켓';
  const pending = ticket?.pendingTransfer;
  const canSend = recipientRef !== null && token !== null && (lookedUpAtMs === null || recipientRefUsable(lookedUpAtMs, Date.now()));

  return (
    <main className="page-main px-4 pt-4 pb-10 md:px-6 md:pt-5 md:pb-12 lg:px-8 lg:pt-8 lg:pb-16" id="main" tabIndex={-1}>
      <div className="col mx-auto w-full max-w-[600px] gap-6 lg:max-w-[640px]">
        <div className="col gap-2">
          <Link className="row t-sm gap-0.5 self-start text-(--text-muted)" href="/my/tickets">
            <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
            마이 티켓
          </Link>
          <h1 className="t-xl lg:text-2xl">티켓 양도</h1>
        </div>

        {load.kind === 'loading' ? (
          <p className="t-sm muted" role="status">
            티켓과 양도 조건을 불러오는 중…
          </p>
        ) : null}
        {load.kind === 'error' ? (
          <NoticeBanner tone="danger" role="alert">
            {load.text}
          </NoticeBanner>
        ) : null}

        {ticket ? (
          <div className="card row items-start gap-3 px-4 py-3.5 md:gap-3.5 md:px-5 md:py-4" role="group" aria-label="양도할 티켓">
            <div className="col grow gap-1">
              <p className="t-md fw-b lg:text-lg">{title}</p>
              <p className="t-sm muted">{summary?.placeName ?? ''}</p>
              <p className="t-sm">지금 보유자: 나</p>
            </div>
            {v.fraudLocked ? <Badge tone="warning">양도 잠김</Badge> : v.badgeOk ? <Badge tone="success">사용 가능</Badge> : null}
          </div>
        ) : null}

        {v.blockRecv ? (
          <NoticeBanner tone="danger" role="alert" title="이 티켓은 양도할 수 없습니다">
            받은 티켓은 다시 양도할 수 없고 결제한 분에게 돌려주기만 할 수 있습니다
          </NoticeBanner>
        ) : null}
        {v.blockDeadline ? (
          <NoticeBanner tone="danger" role="alert" title="양도 가능 시간이 지났습니다">
            이 공연의 양도 마감은 공연 시작 2시간 전입니다.
          </NoticeBanner>
        ) : null}
        {v.blockProduct ? (
          <NoticeBanner tone="danger" role="alert">
            이 상품은 양도할 수 없습니다
          </NoticeBanner>
        ) : null}
        {v.fraudLocked ? (
          <NoticeBanner tone="warning" role="alert" title="이 티켓은 지금 양도할 수 없습니다">
            {v.transferLockedError ? failure?.text : `부정 예매 조사가 끝날 때까지 이 티켓은 양도할 수 없습니다.${ticket?.transferLockExpiresAt ? ` 늦어도 ${new Date(ticket.transferLockExpiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}에 풀립니다.` : ''} 입장과 직접 취소는 그대로 할 수 있습니다`}
          </NoticeBanner>
        ) : null}

        {failure && !v.fraudLocked ? (
          <NoticeBanner tone="danger" role="alert">
            {failure.text}
          </NoticeBanner>
        ) : null}
        {notice ? (
          <NoticeBanner tone="info" role="status">
            {notice}
          </NoticeBanner>
        ) : null}

        {v.form ? (
          <section className="col gap-3" aria-labelledby="h-rc">
            <h2 className="t-md fw-b lg:text-lg" id="h-rc">
              받는 분 확인
            </h2>
            <div className="field">
              <div className="row gap-2" role="group" aria-label="받는 분 찾기 방법">
                <button className={mode === 'CODE' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} type="button" onClick={() => setMode('CODE')}>
                  회원 코드
                </button>
                <button className={mode === 'PHONE' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} type="button" onClick={() => setMode('PHONE')}>
                  휴대폰 번호
                </button>
              </div>
              <label className="label" htmlFor="rc-id">
                {mode === 'PHONE' ? '받는 분 휴대폰 번호' : '받는 분 회원 코드'}
              </label>
              <div className="row gap-2">
                <input
                  className="input"
                  id="rc-id"
                  type={mode === 'PHONE' ? 'tel' : 'text'}
                  inputMode={mode === 'PHONE' ? 'tel' : 'text'}
                  autoComplete="off"
                  value={mode === 'PHONE' ? phone : code}
                  onChange={(e) => (mode === 'PHONE' ? setPhone(e.target.value) : setCode(e.target.value))}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button className="btn btn-secondary" type="button" disabled={busy || (mode === 'PHONE' ? phone.trim() === '' : code.trim() === '')} onClick={() => void lookup()}>
                  회원 확인
                </button>
              </div>
              <span className="hint">{mode === 'PHONE' ? '번호는 저장하지 않고 확인에만 씁니다' : '회원 코드는 받는 분의 계정 설정(SCR-017)에 있습니다'}</span>
            </div>
            {recipientRef !== null && !canSend ? (
              <div className="card-flat row gap-3 px-3.5 py-3" role="status">
                <span className="avatar" aria-hidden="true">
                  {(nickname ?? '회').slice(0, 1)}
                </span>
                <span className="col grow gap-0.5">
                  <span className="t-md fw-b">{nickname ?? '회원'}</span>
                  <span className="t-xs muted">본인확인을 마친 피켓 회원입니다</span>
                </span>
                <i className="ic ic-check-circle tx-success" aria-hidden="true" />
              </div>
            ) : null}
            {recipientRef !== null && token === null ? (
              <button className="btn btn-primary btn-lg btn-block" type="button" disabled={busy} onClick={() => void startReauth()}>
                다시 로그인하고 계속
              </button>
            ) : null}
            {canSend ? (
              <>
                <NoticeBanner tone="legal" role={null} tag="법정 고지">
                  {LEGAL_RESALE_NOTICE}
                </NoticeBanner>
                <p className="t-sm">받는 분: {nickname ?? '확인된 회원'}</p>
                <button className="btn btn-primary btn-lg btn-block" type="button" disabled={busy} onClick={() => void send()}>
                  양도 요청 보내기
                </button>
              </>
            ) : null}
          </section>
        ) : null}

        {v.sentSec && pending ? (
          <section className="col gap-3" aria-labelledby="h-prog">
            <h2 className="t-md fw-b lg:text-lg" id="h-prog">
              진행 중인 요청
            </h2>
            <TransferOfferCard
              variant="sender"
              aria-label="양도 요청"
              partyName="받는 분"
              partyInitial="받"
              status={{ label: '수락 대기', tone: 'warning' }}
              details={[
                { label: '남은 시간', value: remainingText(pending.expiresAt, Date.now()), num: true },
                { label: '수락 기한', value: new Date(pending.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) },
              ]}
            >
              {v.sent ? (
                <button className="btn btn-outline btn-sm" type="button" disabled={busy} onClick={() => void withdraw()}>
                  요청 철회
                </button>
              ) : null}
            </TransferOfferCard>
          </section>
        ) : null}

        <Link className="link-more self-center" href="/my/tickets">
          마이 티켓으로 돌아가기
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      </div>
    </main>
  );
}
