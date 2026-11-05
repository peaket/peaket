'use client';
// SCR-002 회차·오픈·좌석 등급 묶음(⑪ CMP-066 RoundPicker, 등급별 가격 요약)과 예매 버튼(⑥ 알림 토글 · ⑦ 주 버튼, d5 §5.2 상태 표).
// 휴대폰·태블릿은 히어로 안 묶음 + 화면 아래 고정 띠(bar), 데스크톱은 오른쪽 고정 예매 패널(panel)이다(d5 §5.2 'lg: 2단').
// 같은 묶음을 두 곳에 그리므로(한쪽은 display:none) id에 prefix를 붙여 겹치지 않게 한다.
// 버튼 상태는 브라우저가 시각으로 고른다(BUILD_ORDER HOT-311): 서버 시각으로 보정한 시계(docs/frontend.md §3.3)로 로비 개방·이 기기의
// [로비 입장] 열리는 시각(로비 개방 + 0~60초, queue-admission §2 '로비 참가 퍼뜨리기')·오픈·판매 종료를 견주고, 다음에 바뀔 때 다시 고른다.
// 캐시 화면이라 서버는 상태를 정하지 않는다(첫 그리기는 뼈대, d5 §5.2 '로딩'). 개인 상태(비로그인·본인확인·예매 제한·선예매)는 HOT-320이 얹는다.
import Link from 'next/link';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { RoundPicker } from '@peaket/ds/RoundPicker';
import { formatWon } from '@/entities/production';
import { OpenAlertToggle } from '@/features/open-alert';
import { queueRoomHref } from '@/shared/config/origins';
import { browserClock } from '@/shared/lib/clock';
import { cx } from '@/shared/lib/cx';
import { deviceId } from '@/shared/lib/device-id';
import { lobbyUnlockDelayMs } from '@/shared/lib/lobby-unlock';
import { renderNextLink } from '@/shared/lib/next-link';
import { bookingPhase, roundBadge, tierBadge, type BookingPhase, type DetailRound, type EventDetail } from '../model/detail';
import { useDetailPersonal } from './DetailPersonal';

/** 브라우저로 넘기는 값(서버 → 클라이언트, 평평한 값만) */
export type BookingData = Pick<
  EventDetail,
  'eventId' | 'title' | 'roundLabel' | 'status' | 'openAtMs' | 'lobbyOpensAtMs' | 'saleEndsAtMs' | 'openText' | 'lobbyText' | 'openTimeText' | 'rounds' | 'tiers'
> & { otherRoundFallbackHref: string };

interface BookingState {
  phase?: BookingPhase;
  now?: number;
  unlockAt?: number;
}

const BookingContext = createContext<BookingState>({});

/** 시각이 바뀌지 않아도 이만큼마다 다시 고른다(시계 보정 표본이 늦게 와도 따라가게) [가정] */
const RECHECK_MS = 15_000;

export function BookingProvider({ data, children }: { data: BookingData; children: ReactNode }) {
  const [state, setState] = useState<BookingState>({});
  const [unlockAt, setUnlockAt] = useState<number | undefined>(undefined);
  const [announce, setAnnounce] = useState('');
  const prev = useRef<BookingPhase | undefined>(undefined);
  const { eventId, status, openAtMs, lobbyOpensAtMs, saleEndsAtMs } = data;

  // 이 기기의 버튼이 열리면 "로비에 들어갈 수 있습니다"를 한 번 읽는다(d5 §5.2 '로비 열림, 이 기기의 버튼은 아직')
  useEffect(() => {
    if (prev.current === 'notYet' && state.phase === 'lobby') setAnnounce('로비에 들어갈 수 있습니다');
    prev.current = state.phase;
  }, [state.phase]);

  useEffect(() => {
    if (lobbyOpensAtMs === undefined) return;
    let live = true;
    void lobbyUnlockDelayMs(eventId, deviceId()).then((ms) => {
      if (live) setUnlockAt(lobbyOpensAtMs + ms);
    });
    return () => {
      live = false;
    };
  }, [eventId, lobbyOpensAtMs]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const times = { status, openAtMs, saleEndsAtMs, ...(lobbyOpensAtMs !== undefined ? { lobbyOpensAtMs } : {}) };
    const tick = () => {
      const now = browserClock().now();
      const r = bookingPhase(times, now, unlockAt);
      setState({ phase: r.phase, now, ...(unlockAt !== undefined ? { unlockAt } : {}) });
      if (r.nextAt !== undefined) timer = setTimeout(tick, Math.min(Math.max(r.nextAt - now, 0) + 50, RECHECK_MS));
    };
    tick();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status, openAtMs, lobbyOpensAtMs, saleEndsAtMs, unlockAt]);

  return (
    <BookingContext.Provider value={state}>
      {children}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </BookingContext.Provider>
  );
}

function useBooking(): BookingState {
  return useContext(BookingContext);
}

export function BookingFacts({ prefix, data, dividers = false, className }: { prefix: string; data: BookingData; dividers?: boolean; className?: string }) {
  const { phase, now } = useBooking();
  const rounds = data.rounds.map((r: DetailRound) => ({
    id: r.eventId,
    label: r.label,
    href: r.href,
    current: r.current,
    ...(now !== undefined ? { status: roundBadge(r, now) } : {}),
  }));
  const badge = tierBadge(phase);
  const gap = dividers ? 18 : 20;
  return (
    <div className={cx('col', className)} style={{ gap }}>
      <div className="col" style={{ gap: 10 }}>
        <h2 className="eyebrow" id={`${prefix}-h-round`}>
          회차
        </h2>
        <RoundPicker items={rounds} labelledBy={`${prefix}-h-round`} renderLink={renderNextLink} />
      </div>
      {dividers ? <div className="divider" /> : null}
      <div className="col" style={{ gap: 4 }}>
        <h2 className="eyebrow">오픈</h2>
        <p className="t-md">
          <span className="num">{data.openText}</span> KST
          {data.lobbyText ? (
            <>
              {' '}
              · 로비 <span className="num">{data.lobbyText}</span>부터
            </>
          ) : null}
        </p>
      </div>
      {dividers ? <div className="divider" /> : null}
      {data.tiers.length > 0 ? (
        <div className="col" style={{ gap: 2 }}>
          <h2 className="eyebrow" id={`${prefix}-h-tier`}>
            좌석 등급
          </h2>
          <ul aria-labelledby={`${prefix}-h-tier`} aria-busy={badge ? undefined : true}>
            {data.tiers.map((t) => (
              <li key={t.id} className="row between" style={{ minHeight: 48, borderBottom: '1px solid var(--border)' }}>
                <span className="row" style={{ gap: 12 }}>
                  <strong className="t-md fw-b">{t.name}</strong> <span className="t-md num">{formatWon(t.price)}</span>
                </span>{' '}
                {!badge ? (
                  <span className="skel" style={{ width: 56, height: 22 }} />
                ) : badge.kind === 'muted' ? (
                  <span className="t-sm muted">{badge.text}</span>
                ) : (
                  <span className={badge.tone === 'primary' ? 'badge badge-primary' : 'badge'}>{badge.text}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** '로비 열림, 이 기기의 버튼은 아직': 비활성 "곧 들어갈 수 있습니다 · 0:42"(남은 초는 낭독하지 않는다). 열리면 BookingProvider가 [로비 입장]으로 바꾼다 */
function LobbyCountdown({ unlockAt, describedBy, className }: { unlockAt: number | undefined; describedBy: string | undefined; className: string }) {
  const [left, setLeft] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (unlockAt === undefined) return;
    const update = () => setLeft(Math.max(0, Math.ceil((unlockAt - browserClock().now()) / 1000)));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [unlockAt]);
  return (
    <button className={cx('btn btn-primary', className)} type="button" aria-disabled="true" aria-describedby={describedBy}>
      곧 들어갈 수 있습니다
      {left !== undefined ? (
        <span aria-hidden="true">
          {' '}
          · <span className="num">{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}</span>
        </span>
      ) : null}
    </button>
  );
}

type Primary = { type: 'link'; label: string; href: string } | { type: 'disabled'; label: string } | { type: 'countdown' };

interface CtaModel {
  desc?: ReactNode;
  meta?: string;
  alert?: { iconOnlyBelowMd?: boolean };
  primary?: Primary;
  minW?: 160 | 200 | 240;
  more?: { label: string; href: string };
  special?: 'ended' | 'load';
  endedText?: string;
}

const SAME_ORDER = '로비 안에서는 언제 들어와도 순번이 같습니다';

function otherRoundHref(data: BookingData, now: number | undefined): string {
  const next = data.rounds.find((r) => !r.current && r.status !== 'CANCELLED' && (now === undefined || r.saleEndsAtMs === undefined || r.saleEndsAtMs > now));
  return next?.href ?? data.otherRoundFallbackHref;
}

function ctaModel(phase: BookingPhase | undefined, data: BookingData, now: number | undefined): CtaModel {
  const queue = queueRoomHref(data.eventId);
  switch (phase) {
    case 'closed':
      return { desc: `로비는 ${data.lobbyText ?? ''}에 열립니다`, alert: {}, primary: { type: 'disabled', label: '로비 입장' }, minW: 200 };
    case 'notYet':
      return { desc: SAME_ORDER, alert: { iconOnlyBelowMd: true }, primary: { type: 'countdown' }, minW: 240 };
    case 'lobby':
      return { desc: SAME_ORDER, alert: {}, primary: { type: 'link', label: '로비 입장', href: queue }, minW: 200 };
    case 'fifo':
      return { desc: `대기열은 ${data.openTimeText}에 열립니다`, alert: {}, primary: { type: 'disabled', label: '대기열 들어가기' }, minW: 200 };
    case 'queue':
      return { meta: `${data.roundLabel} · 판매 중`, primary: { type: 'link', label: '대기열 들어가기', href: queue }, minW: 240 };
    case 'ended':
      return { special: 'ended', endedText: '판매가 끝난 회차입니다', meta: `${data.roundLabel} · 판매가 끝난 회차입니다`, more: { label: '다른 회차', href: otherRoundHref(data, now) } };
    case 'cancelled':
      return { special: 'ended', endedText: '취소된 회차입니다', meta: `${data.roundLabel} · 취소된 회차입니다`, more: { label: '다른 회차', href: otherRoundHref(data, now) } };
    default:
      return { special: 'load', meta: data.roundLabel };
  }
}

const MIN_W: Record<NonNullable<CtaModel['minW']>, string> = { 160: 'md:min-w-[160px]', 200: 'md:min-w-[200px]', 240: 'md:min-w-[240px]' };

function PrimaryButton({ p, className, descId, unlockAt }: { p: Primary; className: string; descId: string | undefined; unlockAt: number | undefined }) {
  if (p.type === 'countdown') return <LobbyCountdown unlockAt={unlockAt} describedBy={descId} className={className} />;
  if (p.type === 'link') {
    // 대기실(로비·대기열)은 별도 빌드라 전체 이동이다
    return (
      <a className={cx('btn btn-primary', className)} href={p.href}>
        {p.label}
      </a>
    );
  }
  return (
    <button className={cx('btn btn-primary', className)} type="button" aria-disabled="true" aria-describedby={descId}>
      {p.label}
    </button>
  );
}

function MoreLink({ more }: { more: { label: string; href: string } }) {
  return (
    <Link className="link-more" href={more.href}>
      {more.label}
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </Link>
  );
}

/** ⑥ 오픈 알림 토글: 신청 상태는 서버 값(listSubscriptions). 상태를 받기 전에는 누를 수 없다 */
function AlertToggle({ title, className, iconOnlyBelowMd }: { title: string; className: string; iconOnlyBelowMd?: boolean }) {
  const { status, alertKnown, alertOn, setAlert } = useDetailPersonal();
  return (
    <OpenAlertToggle
      title={title}
      variant="button"
      kind="open"
      pressed={alertOn}
      onToggle={setAlert}
      disabled={status !== 'guest' && !alertKnown}
      {...(iconOnlyBelowMd ? { iconOnlyBelowMd } : {})}
      className={className}
    />
  );
}

/** 휴대폰·태블릿 화면 아래 고정 띠(보드 SCR-002-m·t의 .bottom-bar). 데스크톱(lg)에서는 숨긴다 */
export function BookingBar({ data }: { data: BookingData }) {
  const { phase, now, unlockAt } = useBooking();
  const m = ctaModel(phase, data, now);
  const descId = m.desc ? `bar-${phase ?? 'load'}-why` : undefined;
  let body: ReactNode;
  if (m.special === 'load') {
    body = (
      <div className="row gap-2 md:gap-3" aria-busy="true">
        <div className="col hidden min-w-0 grow gap-0.5 md:flex">
          <strong className="t-md fw-b ellipsis">{data.title}</strong>
          <span className="t-sm muted">{m.meta}</span>
        </div>
        <span className="sr-only">예매 버튼을 불러오는 중</span>
        <span className="skel h-[52px] w-[136px] flex-none md:hidden" />
        <span className="skel h-[52px] grow md:w-[240px] md:flex-none md:grow-0" />
      </div>
    );
  } else if (m.special === 'ended') {
    body = (
      <div className="row between gap-4">
        <div className="col min-w-0" style={{ gap: 2 }}>
          <strong className="t-md fw-b ellipsis hidden md:block">{data.title}</strong>
          <p className="t-md fw-b md:hidden">{m.endedText}</p>
          <span className="t-sm muted hidden md:block">{m.meta}</span>
        </div>
        {m.more ? <MoreLink more={m.more} /> : null}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
        {m.desc || m.meta ? (
          <div className={cx('col min-w-0 gap-0.5 md:grow', !m.desc && 'hidden md:flex')}>
            <strong className="t-md fw-b ellipsis hidden md:block">{data.title}</strong>
            {m.desc ? (
              <p className="t-sm muted text-center md:text-left" id={descId}>
                {m.desc}
              </p>
            ) : (
              <span className="t-sm muted">{m.meta}</span>
            )}
          </div>
        ) : null}
        <div className="row gap-2 md:gap-3">
          {m.alert ? <AlertToggle title={data.title} iconOnlyBelowMd={m.alert.iconOnlyBelowMd} className={cx('btn-lg', !m.primary && 'grow md:grow-0')} /> : null}
          {m.primary ? <PrimaryButton p={m.primary} descId={descId} unlockAt={unlockAt} className={cx('btn-lg grow md:flex-none md:grow-0', m.minW ? MIN_W[m.minW] : '')} /> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="bottom-bar sticky bottom-0 z-10 md:px-6 lg:hidden">
      <div className="w-full">{body}</div>
    </div>
  );
}

/** 데스크톱 오른쪽 고정 예매 패널의 버튼 묶음(보드 SCR-002-d aside) */
export function BookingPanelCta({ data }: { data: BookingData }) {
  const { phase, now, unlockAt } = useBooking();
  const m = ctaModel(phase, data, now);
  const descId = m.desc ? `pnl-${phase ?? 'load'}-why` : undefined;
  if (m.special === 'load') {
    return (
      <div className="col" style={{ gap: 8 }} aria-busy="true">
        <span className="sr-only">예매 버튼을 불러오는 중</span>
        <span className="skel" style={{ height: 40 }} />
        <span className="skel" style={{ height: 52 }} />
      </div>
    );
  }
  if (m.special === 'ended') {
    return (
      <div className="col items-center" style={{ gap: 12 }}>
        <p className="t-md fw-b">{m.endedText}</p>
        {m.more ? <MoreLink more={m.more} /> : null}
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 8 }}>
      {m.desc ? (
        <p className="t-sm muted" id={descId}>
          {m.desc}
        </p>
      ) : null}
      {m.alert ? <AlertToggle title={data.title} className="btn-block" /> : null}
      {m.primary ? <PrimaryButton p={m.primary} descId={descId} unlockAt={unlockAt} className="btn-lg btn-block" /> : null}
    </div>
  );
}
