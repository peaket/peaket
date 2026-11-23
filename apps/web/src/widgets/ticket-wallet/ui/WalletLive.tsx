'use client';
// SCR-013 마이 티켓(월렛)의 실제 화면(FIX-wallet-tickets, docs/frontend.md §4.2.4 '월렛 목록 세부', d5 §5.13 상태 표, O-T52).
// - 목록(/my/tickets)과 펼침(/my/tickets/{ticketId})이 함께 쓴다. 화면은 저장소(peaket-wallet)의 표로 그리고(오프라인 우선), 열릴 때·[ 지금 동기화 ]·`online`에
//   목록을 다시 받는다. 받기(features/wallet-sync/sync)·QR·오프라인 배너 조각은 첫 화면이 다 그려진(load) 뒤에 받는다(BAT-177 T6 ⑦).
// - 첫 HTML은 서버가 그린 '불러오는 중'(loading)과 QR 뼈대(qrFallback)다. 서버 셸은 티켓 ID로 아무것도 읽지 않는다: 펼침의 ID는 붙은 뒤 주소창에서 읽는다
//   (빌드 때 그린 셸 하나를 모든 ID가 같이 쓰고, 요청 때 그리는 조각이 없어 캐시 화면의 인라인 스크립트 해시가 그대로 맞는다).
// - 갱신 뒤에도 401이면 저장된 표를 그리지 않고 로그인 화면(SCR-004)으로 보낸다. QR 글자·쿠키는 console·주소창에 내지 않는다.
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { EmptyState } from '@peaket/ds/EmptyState';
import { ErrorState } from '@peaket/ds/ErrorState';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { walletScreenOf, type WalletCard, type WalletSyncResult } from '@/features/wallet-sync';
import type * as WalletSyncModule from '@/features/wallet-sync/sync';
import { afterLoad } from '@/shared/lib/after-load';
import { cx } from '@/shared/lib/cx';
import { reauthFailureText } from '@/shared/lib/reauth-failure';
import { pickupReauthToken } from '@/shared/lib/reauth-return';
import { ORIGINS } from '@/shared/config/origins';
import { canReturn, receivedOfferCardsOf, returnFailureOf } from '../model/transfer-rules';
import { DeviceQrLazy, OfflineBannerLazy } from './wallet-lazy';

// 받은 티켓 카드의 돌려주기 확인 대화상자·WebShell은 누를 때만 필요하다. 첫 화면 JS에서 빼고 늦게 싣는다
// (docs/frontend.md §5.8 월렛 첫 JS 예산, CI 실행 45240606103에서 195.9kB > 한도 161.6kB).
const ReturnAction = dynamic(() => import('./return-action').then((m) => m.ReturnAction), { ssr: false });

export interface WalletLiveProps {
  /** 서버가 그린 '불러오는 중'(첫 HTML의 글과 QR 뼈대) */
  loading: ReactNode;
  /** QR 조각을 받기 전 QR 자리(서버가 그린 뼈대) */
  qrFallback: ReactNode;
  /** 펼침 경로(/my/tickets/{ticketId})인가. 티켓 ID는 붙은 뒤 주소에서 읽는다 */
  detail: boolean;
}

/** 펼침 주소의 마지막 조각(티켓 ID). 풀 수 없는 퍼센트 부호면 그 글자 그대로(어느 표와도 같지 않아 '찾을 수 없음') */
function ticketIdOfPath(pathname: string): string {
  const raw = pathname.replace(/\/+$/, '').split('/').pop() ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type SyncModule = typeof WalletSyncModule;

const loadSyncModule = (): Promise<SyncModule> => import('@/features/wallet-sync/sync');

const H2 = 't-md fw-b lg:text-[20px] lg:leading-[27px]';
const SUMMARY_FAILED = '공연 정보를 불러오지 못했습니다';

let kst: Intl.DateTimeFormat | undefined;

/** 회차 시작 글(KST, 예 10/25(일) 18:00). 표가 있을 때만 만든다 */
function whenText(iso: string | null): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  kst ??= new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  return kst.format(new Date(at));
}

/** 배지 색(보드 CMP-028의 색 규칙: 유효 초록·진행 중 노랑·끝남 회색·무효 빨강) */
function badgeClass(card: WalletCard): string {
  switch (card.badge) {
    case '사용 가능':
    case '받은 티켓':
      return 'badge badge-success';
    case '양도 요청 중':
    case '취소 접수됨':
    case '확인 중':
      return 'badge badge-warning';
    case '무효':
      return 'badge badge-danger';
    default:
      return 'badge';
  }
}

function TicketCard({ card, qrFallback }: { card: WalletCard; qrFallback: ReactNode }) {
  const hid = `wt-${card.ticketId}`;
  const muted = card.badge === '지난 공연' || card.badge === '환급됨' || card.badge === '무효';
  const when = whenText(card.startsAt);
  const sub = [when, card.placeName].filter(Boolean).join(' · ');
  return (
    <article className={cx('col gap-3', muted ? 'card-flat px-4 py-[14px] lg:px-5 lg:py-4' : 'card p-4 lg:p-5')} aria-labelledby={hid}>
      <div className="row between items-start gap-2">
        <div className="col min-w-0 gap-1">
          <h3 className={cx('t-md fw-b', (muted || card.title === null) && 'muted')} id={hid}>
            {card.title ?? SUMMARY_FAILED}
          </h3>
          {sub ? <p className="t-sm muted">{sub}</p> : null}
        </div>
        <span className={badgeClass(card)}>{card.badge}</span>
      </div>
      {card.note ? <p className="t-sm">{card.note}</p> : null}
      {card.showQr ? <DeviceQrLazy ticketId={card.ticketId} label={card.qrLabel} fallback={qrFallback} /> : null}
      {card.received &&
      card.badge === '받은 티켓' &&
      canReturn({ ticketId: card.ticketId, status: card.status, received: card.received, eventStartsAt: card.startsAt ?? undefined, entryOpensAt: card.entryOpensAt ?? undefined }, Date.now()) ? (
        <ReturnAction ticketId={card.ticketId} />
      ) : null}
      {card.pendingOfferId ? (
        <Link className="link-more" href={`/my/tickets/${encodeURIComponent(card.ticketId)}/transfer`}>
          요청 보기
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      ) : null}
    </article>
  );
}

export function WalletLive({ loading, qrFallback, detail }: WalletLiveProps) {
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [cards, setCards] = useState<WalletCard[] | null>(null);
  const [sync, setSync] = useState<'pending' | WalletSyncResult>('pending');
  const [returnNotice, setReturnNotice] = useState<string | null>(null);
  const [offers, setOffers] = useState<{ offerId: string; eventId: string; expiresAt: string; href: string }[]>([]);
  const syncModule = useRef<SyncModule | null>(null);
  /** 마지막으로 시작한 받기 번호. 늦게 끝난 앞 받기가 뒤 결과를 덮지 않게 한다 */
  const run = useRef(0);

  const resync = useCallback(async () => {
    const m = syncModule.current;
    if (!m) return;
    const id = ++run.current;
    setSync('pending');
    const result = await m.syncWallet();
    const next = await m.loadWalletCards(Date.now());
    if (id !== run.current) return;
    setCards(next);
    setSync(result);
  }, []);

  // 받은 요청 카드(SCR-013 ⑬): 기한 전 OFFERED만 SCR-041로 잇는다
  useEffect(() => {
    const origin = ORIGINS.api;
    if (origin === '') return;
    // 받은 요청이 없으면 돌려주기 코드가 필요 없다. 첫 화면 JS에서 빼고, 첫 화면이 다 그려진 뒤에 가져온다
    // (docs/frontend.md §5.8 월렛 첫 JS·TBT 예산, CI 실행 45250236631에서 214.5ms > 200ms).
    const cancel = afterLoad(() => {
      void (async () => {
        const { loadReceivedOffers } = await import('../model/transfer-actions');
        const r = await loadReceivedOffers({ origin, fetch: globalThis.fetch });
        if (r.kind === 'ok') setOffers(receivedOfferCardsOf(r.body.items, Date.now()));
      })();
    });
    return cancel;
  }, []);

  // 돌려주기 재인증에서 돌아오면: 표시를 한 번 꺼내 토큰을 받고 POST한 뒤 동기화한다
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem('peaket.return.reauth');
    } catch {
      raw = null;
    }
    if (raw === null) return;
    let pending: { ticketId?: unknown; key?: unknown };
    try {
      pending = JSON.parse(raw) as { ticketId?: unknown; key?: unknown };
    } catch {
      return;
    }
    try {
      sessionStorage.removeItem('peaket.return.reauth');
    } catch {
      // 위와 같다
    }
    if (typeof pending.ticketId !== 'string' || typeof pending.key !== 'string') return;
    if (ORIGINS.api === '') {
      setReturnNotice('지금은 돌려줄 수 없습니다. 잠시 뒤 다시 시도해 주세요');
      return;
    }
    void (async () => {
      const r = await pickupReauthToken();
      if (r.kind !== 'token') {
        setReturnNotice(`다시 로그인하지 못했습니다: ${reauthFailureText(r.reason)}`);
        return;
      }
      const { returnTicket } = await import('../model/transfer-actions');
      const out = await returnTicket({ ticketId: pending.ticketId as string, reauthToken: r.token, idempotencyKey: pending.key as string, origin: ORIGINS.api, fetch: globalThis.fetch });
      if (out.kind === 'ok') {
        setReturnNotice('결제한 분에게 돌려주었습니다');
        await resync();
      } else {
        setReturnNotice(returnFailureOf(out).text);
      }
    })();
  }, [resync]);

  useEffect(() => {
    if (detail) setTicketId(ticketIdOfPath(window.location.pathname));
  }, [detail]);

  useEffect(() => {
    let cancelled = false;
    const cancel = afterLoad(() => {
      void loadSyncModule()
        .then(async (m) => {
          if (cancelled) return;
          syncModule.current = m;
          // 저장된 표로 먼저 그리고(오프라인 우선), 이어서 목록을 받는다
          const stored = await m.loadWalletCards(Date.now());
          if (!cancelled && run.current === 0) setCards(stored);
          if (!cancelled) await resync();
        })
        .catch(() => {
          // 조각을 받지 못하면 저장된 표를 그릴 수 없다: 받지 못함으로 보인다
          if (!cancelled) setSync({ kind: 'failed', reason: 'network' });
        });
    });
    const online = () => void resync();
    window.addEventListener('online', online);
    return () => {
      cancelled = true;
      cancel();
      window.removeEventListener('online', online);
    };
  }, [resync]);

  const { screen, offline } = walletScreenOf({ stored: cards?.length ?? 0, sync });

  // 갱신 뒤에도 401: 로그인 화면으로 보낸다(저장된 표는 그리지 않는다)
  useEffect(() => {
    const m = syncModule.current;
    if (screen !== 'login' || !m) return;
    window.location.assign(m.loginHrefAfterRefresh(`${window.location.pathname}${window.location.search}`));
  }, [screen]);

  const retry = () => void resync();
  const found = ticketId === null ? null : (cards?.find((c) => c.ticketId === ticketId) ?? null);

  let body: ReactNode;
  if (screen === 'login') {
    body = null;
  } else if (screen === 'loading' || (detail && ticketId === null)) {
    body = loading;
  } else if (screen === 'error') {
    body = <ErrorState title="티켓을 불러오지 못했습니다" description="인터넷 연결을 확인한 뒤 다시 시도해 주세요." onRetry={retry} />;
  } else if (detail) {
    if (found) body = <TicketCard card={found} qrFallback={qrFallback} />;
    else if (sync === 'pending') body = loading;
    else
      body = (
        <EmptyState
          icon="ticket"
          title="티켓을 찾을 수 없습니다"
          style={{ padding: '56px 16px' }}
          actions={
            <Link className="link-more" href="/my/tickets">
              마이 티켓
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </Link>
          }
        />
      );
  } else if (screen === 'empty') {
    body = (
      <EmptyState
        icon="ticket"
        title="아직 티켓이 없습니다"
        description="예매를 마치면 티켓이 여기에 나타납니다."
        style={{ padding: '56px 16px' }}
        actions={
          <Link className="link-more" href="/search">
            공연 둘러보기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        }
      />
    );
  } else {
    body = (
      <section className="col gap-3 lg:gap-4" aria-labelledby="h-tickets">
        <h2 className={H2} id="h-tickets">
          내 티켓
        </h2>
        <div className="grid gap-3 md:grid-cols-2 md:items-start md:gap-x-4 lg:gap-x-6 lg:gap-y-4">
          {(cards ?? []).map((c) => (
            <TicketCard key={c.ticketId} card={c} qrFallback={qrFallback} />
          ))}
        </div>
      </section>
    );
  }

  return (
    <>
      <OfflineBannerLazy forceOffline={offline} />
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[1040px] gap-6 px-4 pt-5 pb-10 md:gap-7 md:px-6 md:pb-12 lg:gap-8 lg:px-8 lg:pt-8 lg:pb-16">
          <h1 className="t-xl lg:text-[32px] lg:leading-[42px]">{detail ? '티켓 상세' : '마이 티켓'}</h1>
          {returnNotice ? (
            <NoticeBanner tone={returnNotice.includes('돌려주었습니다') ? 'success' : 'danger'} role="status">
              {returnNotice}
            </NoticeBanner>
          ) : null}
          {offers.length > 0 ? (
            <section className="col gap-3" aria-labelledby="h-offers">
              <h2 className={H2} id="h-offers">
                받은 양도 요청
              </h2>
              {offers.map((o) => (
                <Link key={o.offerId} className="card-flat row between gap-3 px-4 py-3" href={o.href}>
                  <span className="col gap-0.5">
                    <span className="t-md fw-b">받은 양도 요청</span>
                    <span className="t-xs muted">수락 기한 {new Date(o.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</span>
                  </span>
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              ))}
            </section>
          ) : null}
          {body}
          {screen === 'list' && (!detail || found) ? (
            <div className="col items-center gap-1.5 md:flex-row md:gap-3">
              <button className="btn btn-outline btn-block md:w-auto" type="button" onClick={sync === 'pending' ? undefined : retry} aria-disabled={sync === 'pending' ? true : undefined}>
                <i className="ic ic-refresh" aria-hidden="true" />
                지금 동기화
              </button>
            </div>
          ) : null}
        </div>
      </main>
    </>
  );
}
