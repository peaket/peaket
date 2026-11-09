'use client';
// SCR-010 좌석 선택의 실제 화면(d5 §5.10, docs/frontend.md §4.2.2·§5.2, BUILD_ORDER HOT-350 ①, ADR-0224).
// 대기실이 탭 저장소에 둔 입장 저장값을 읽어 구매 세션 키를 열고(첫 스냅샷에 임시 공개키를 싣는다), 좌석맵 Worker에 좌석맵 파일·스냅샷을 맡긴다.
// 좌석맵 패키지·서명기는 늦게 가져온다(첫 JS 예산, §5.8). 캔버스는 효과 안에서 만든다: OffscreenCanvas로 넘긴 캔버스는 다시 넘길 수 없어 다시 시도·Strict Mode마다 새로 만든다.
// 고른 좌석의 홀드·요약은 HOT-353, 접근성 목록은 HOT-354, 실시간은 HOT-357에서 잇는다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { PriceTierLegend } from '@peaket/ds/PriceTierLegend';
import { SeatLegend, type SeatStatus } from '@peaket/ds/SeatStatusBadge';
import type { FromWorker, SeatMapClient } from '@peaket/seatmap';
import type { PurchaseSigner } from '@peaket/api-client/purchase';
import Link from 'next/link';
import { ORIGINS } from '@/shared/config/origins';
import { holdClock } from '@/shared/lib/hold-clock';
import { AppShell } from '@/widgets/app-shell';
import { canPick, clearAdmission, createGesture, createHoverTracker, errorPhase, readAdmission, seatmapLayoutUrl, snapshotUrl, tierNames, tierRank, wheelFactor, type GestureCommand, type SeatsPhase } from '../model/live';
import type { Booking, HoldResult } from '../model/booking-runtime';
import type { BookingNotice, SeatPick } from '../model/booking-machine';
import type { ListSection, OpenSection } from '../model/seat-list';
import { GoneState } from './GoneState';
import { LiveSummary } from './LiveSummary';
import { ZoneLegend } from './ZoneLegend';

type SeatListView = typeof import('./SeatList').SeatList;
/** 멈춘 홀드를 다시 읽는 간격(초) [가정] */
const FROZEN_REREAD_TICKS = 10;
const SEAT_LEGEND: readonly SeatStatus[] = ['available', 'held-by-others', 'mine', 'sold', 'unavailable', 'wheelchair'];
/** [+]·[−] 배율(엔진 ZOOM_STEP과 같다. 좌석맵 패키지를 첫 묶음에 넣지 않으려고 글자로 둔다) */
const ZOOM_STEP = 1.5;
/** Retry-After가 있는 503·429를 스스로 다시 받는 횟수 [가정] */
const AUTO_RETRY_MAX = 3;
/** 일시 정지 뒤 다시 홀드를 받기까지 [가정] */
const PAUSED_RETRY_MS = 10_000;
/** 회차 요약이 오기 전의 1인 매수 한도 [가정](서버가 422로 다시 본다) */
const DEFAULT_LIMIT = 4;

const holdKey = (eventId: string) => `peaket.hold.${eventId}`;
/** 결제 화면이 홀드를 다시 읽을 값(docs/frontend.md §3.12) */
function clearHold(eventId: string): void {
  try {
    sessionStorage.removeItem(holdKey(eventId));
  } catch {
    /* 저장소를 못 쓰면 지울 것도 없다 */
  }
}

function savedHoldId(eventId: string): string | undefined {
  try {
    const v = JSON.parse(sessionStorage.getItem(holdKey(eventId)) ?? 'null') as { holdId?: unknown } | null;
    return typeof v?.holdId === 'string' && v.holdId ? v.holdId : undefined;
  } catch {
    return undefined;
  }
}

function saveHold(eventId: string, h: HoldResult): void {
  try {
    sessionStorage.setItem(holdKey(eventId), JSON.stringify({ holdId: h.holdId, seatIds: h.seatIds, expiresAt: h.expiresAt }));
  } catch {
    /* 저장하지 못해도 이 화면에서 결제로 넘어간다 */
  }
}
/** 예매 시간이 끝났을 때 안내를 보이고 대기실로 옮기기까지 [가정](d5 §5.10 '버튼 없이 넘어가는 중') */
const LEAVE_AFTER_MS = 2500;

interface Head {
  title: string;
  subtitle: string;
  tiers: { tierId: string; name: string; price: number }[];
  /** 1인 매수 한도 */
  limit: number;
  /** 자동 배정 공연 */
  auto: boolean;
}
type View = Extract<FromWorker, { type: 'view' }>;

const dateText = (iso: string | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }).format(d);
};

/** 회차 공개 요약(머리·가격표). 실패해도 좌석맵은 그린다 */
async function loadHead(eventId: string, signal: AbortSignal): Promise<Head | null> {
  try {
    const [{ ensureBrowserApi }, { getEvent }] = await Promise.all([import('@/shared/api'), import('@peaket/api-client/endpoints/catalog')]);
    if (!ensureBrowserApi()) return null;
    const { data: e } = await getEvent(eventId, { signal });
    const tiers = (e.priceTiers ?? []).flatMap((t) => (t.tierId && t.name && typeof t.price === 'number' ? [{ tierId: t.tierId, name: t.name, price: t.price }] : []));
    return { title: e.title ?? '좌석 선택', subtitle: [dateText(e.startsAt), e.placeName].filter(Boolean).join(' · '), tiers: [...tiers].sort((a, b) => b.price - a.price), limit: e.perPersonLimit ?? DEFAULT_LIMIT, auto: e.seatAssignment === 'AUTO' };
  } catch {
    return null;
  }
}

const themeNow = (): 'light' | 'dark' => (document.documentElement.dataset.seedUserColorScheme === 'dark' ? 'dark' : 'light');

/** 자동 배정 공연의 진행·실패(d5 §5.10 ⑦) */
function AutoState({ kind, eventId, seats }: { kind: 'assigning' | 'done' | 'expired' | 'unavailable' | 'no-match' | 'wish-error'; eventId: string; seats: string[] }) {
  const text =
    kind === 'assigning'
      ? '좌석을 배정하는 중'
      : kind === 'done'
        ? '배정 결과'
        : kind === 'expired'
          ? '홀드 시간이 끝나 좌석이 풀렸습니다. 요금은 청구되지 않습니다'
          : kind === 'no-match'
            ? '희망 조건에 맞는 좌석이 없습니다'
            : kind === 'wish-error'
              ? '희망 조건을 다시 골라 주세요'
              : '자동 좌석 배정을 지금 쓸 수 없습니다';
  return (
    <section className="state" role={kind === 'assigning' || kind === 'done' ? 'status' : 'alert'} style={{ padding: '96px 24px 24px' }}>
      <h1 className="sr-only">좌석 선택</h1>
      {kind === 'assigning' ? <span className="spinner tx-link" aria-hidden="true" /> : kind === 'done' ? null : <i className="ic ic-alert" aria-hidden="true" />}
      <h2 className="t-lg">{text}</h2>
      {kind === 'done' ? <strong className="t-xl">{seats.join(', ')}</strong> : null}
      {kind === 'assigning' || kind === 'done' ? null : (
        <Link className="btn btn-primary" href={`/events/${encodeURIComponent(eventId)}`}>
          공연 정보로 돌아가기
        </Link>
      )}
    </section>
  );
}

export function SeatsLive({ eventId }: { eventId: string }) {
  const [phase, setPhase] = useState<SeatsPhase>('loading');
  const [attempt, setAttempt] = useState(0);
  const [head, setHead] = useState<Head | null>(null);
  const [view, setView] = useState<View | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<SeatMapClient | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const listedRef = useRef<number | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [listView, setListView] = useState<SeatListView | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [listSections, setListSections] = useState<ListSection[] | null>(null);
  const [openSection, setOpenSection] = useState<OpenSection | null>(null);
  const viewRef = useRef<View | null>(null);
  const sessionRef = useRef<PurchaseSigner | null>(null);
  const bookingRef = useRef<Booking | null>(null);
  const [booking, setBooking] = useState<{ value: string; picks: SeatPick[]; notice: BookingNotice | null; limit: number; extended: boolean } | null>(null);
  const [auto, setAuto] = useState<'assigning' | 'done' | 'unavailable' | 'no-match' | 'wish-error' | null>(null);
  const [heldLeft, setHeldLeft] = useState<number | null>(null);
  /** 이번 화면에서 401로 토큰을 갱신했는가(한 번만) */
  const refreshedRef = useRef(false);
  const autoRetriesRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setPhase('loading');
    setView(null);
    viewRef.current = null;
    let live = true;
    let drawn = false;
    const abort = new AbortController();
    const cleanups: Array<() => void> = [];

    const start = async () => {
      const adm = readAdmission(eventId, sessionStorage);
      if (!adm) return setPhase('ended');
      const layoutUrl = seatmapLayoutUrl(eventId, adm.seatmapLayoutPath);
      if (!ORIGINS.api) return setPhase('failed');

      // 입장 토큰을 처음 쓰기 전에 구매 세션 키를 연다(첫 스냅샷의 임시 공개키, ADR-0221 결정 3)
      const { PurchaseKeyError, openPurchaseSession } = await import('@peaket/api-client/purchase');
      let ephemeralKey: string;
      try {
        const session = await openPurchaseSession({
          admissionToken: adm.admissionToken,
          ...(adm.serverEcdhPublicKey ? { serverEcdhPublicKey: adm.serverEcdhPublicKey } : {}),
          ...(adm.purchaseSessionExpiresAt ? { purchaseSessionExpiresAt: adm.purchaseSessionExpiresAt } : {}),
        });
        sessionRef.current = session;
        ephemeralKey = session.clientPublicKey;
      } catch (e) {
        if (live) setPhase(e instanceof PurchaseKeyError && e.reason !== 'storage' ? 'invalid' : 'failed');
        return;
      }

      // 회차 요약을 기다리지 않고 그린다(첫 그림 예산 §5.2). 오면 머리와 지도의 등급 차례·글자를 고친다
      const headLoad = loadHead(eventId, abort.signal);
      void headLoad.then((h) => live && h && setHead(h));
      // 예매 흐름(요청·기계)도 늦게 가져온다
      const [{ createBooking, readWish }, api, { createBehaviorTracker, listenBehavior }] = await Promise.all([import('../model/booking-runtime'), import('@/shared/api'), import('@/features/behavior-summary/tracker')]);
      // 행동 요약은 좌석맵을 처음 그린 때부터 잰다(좌표·본 좌석은 남기지 않는다, ADR-0171 결정 4). 첫 직접 선택 홀드에만 싣는다
      let behaviorTracker: ReturnType<typeof createBehaviorTracker> | undefined;
      const client = api.browserApiClient();
      if (!live) return;
      if (!client) return setPhase('failed');
      let toggle: (seatIndex: number) => void = () => undefined;
      const b = createBooking({
        eventId,
        session: sessionRef.current!,
        client,
        toggleOnMap: (i) => toggle(i),
        refreshToken: api.refreshFanToken,
        limit: DEFAULT_LIMIT,
        behaviorSummary: () => behaviorTracker?.summary(),
        saveHold: (h) => saveHold(eventId, h),
        clearHold: () => clearHold(eventId),
        admissionToken: adm.admissionToken,
        savedHoldId: () => savedHoldId(eventId),
        setMineOnMap: (seatIds, on) => mapRef.current?.send({ type: 'setMine', seatIds: [...seatIds], on }),
        markReleasedOnMap: (seats) => mapRef.current?.send({ type: 'released', seats: [...seats] }),
      });
      bookingRef.current = b;
      const sync = () => {
        const s = b.actor.getSnapshot();
        setBooking({ value: String(s.value), picks: s.context.picks, notice: s.context.notice, limit: s.context.limit, extended: s.context.extended });
        if (s.value === 'ended') setPhase('ended');
        const f = b.autoFailure();
        if (f) setAuto(f);
      };
      const off = b.subscribe(sync);
      sync();
      cleanups.push(() => {
        off();
        b.dispose();
        bookingRef.current = null;
      });
      void headLoad.then((h) => live && h && b.setLimit(h.limit));

      // 자동 배정 공연은 좌석맵이 없다(일정 사본에 판 번호가 없어 경로가 없다): 희망 조건으로 바로 홀드한다
      if (!layoutUrl) {
        const h = await headLoad;
        if (!live) return;
        if (!h?.auto) return setPhase('failed');
        setAuto('assigning');
        setPhase('ready');
        // 저장한 홀드가 있으면 다시 읽어 잇는다(새로고침, docs/frontend.md §4.2.2 7행)
        await b.restore();
        if (b.actor.getSnapshot().value === 'held') {
          setAuto('done');
          return;
        }
        await b.autoHold(readWish(eventId, localStorage));
        if (live && b.actor.getSnapshot().value === 'held') {
          setAuto('done');
          localStorage.removeItem(`peaket.autoassign.${eventId}`);
        }
        return;
      }
      const { createSeatMap } = await import('@peaket/seatmap');
      if (!live) return;

      const onMapError = (m: Extract<FromWorker, { type: 'error' }>) => {
        // 첫 그림 뒤의 메시지 오류 하나로 지도를 잃지 않는다(요청 실패만 화면을 바꾼다)
        if (drawn && !m.source) return;
        const next = errorPhase(m);
        if (next === 'refresh') {
          if (refreshedRef.current) return setPhase('ended');
          refreshedRef.current = true;
          void (async () => {
            const { refreshFanToken } = await import('@/shared/api');
            const r = await refreshFanToken();
            if (!live) return;
            if (r === 'ok') setAttempt((a) => a + 1);
            else setPhase(r === 'rejected' ? 'ended' : 'failed');
          })();
          return;
        }
        if (next === 'retry' && autoRetriesRef.current < AUTO_RETRY_MAX) {
          autoRetriesRef.current += 1;
          // 서버가 준 시각은 하한이고 위로만 흩는다(§4.1 '자동 재시도')
          const t = setTimeout(() => setAttempt((a) => a + 1), (m.retryAfter ?? 1) * 1000 * (1 + Math.random() * 0.2));
          cleanups.push(() => clearTimeout(t));
          return;
        }
        setPhase(next === 'retry' ? 'failed' : next);
      };

      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.className = 'block size-full touch-none';
      host.appendChild(canvas);
      cleanups.push(() => canvas.remove());

      const map = createSeatMap({
        canvas,
        layoutUrl,
        snapshotUrl: snapshotUrl(ORIGINS.api, eventId),
        admission: { token: adm.admissionToken, ephemeralKey },
        theme: themeNow(),
        createWorker: () => new Worker(new URL('../workers/seatmap.worker.ts', import.meta.url), { type: 'module' }),
        onMessage: (m) => {
          if (!live) return;
          if (m.type === 'ready') {
            if (!drawn) void b.restore();
            drawn = true;
            if (!behaviorTracker) {
              behaviorTracker = createBehaviorTracker(() => performance.now());
              cleanups.push(listenBehavior(window, behaviorTracker));
            }
            setPhase('ready');
          } else if (m.type === 'view') {
            viewRef.current = m;
            // 카메라만 바뀌면 화면을 다시 그리지 않는다(끌 때마다 전체가 다시 그려지지 않게)
            setView((v) => (v && v.level === m.level && v.zoom === m.zoom && v.maxZoom === m.maxZoom && v.selectable === m.selectable ? v : m));
          } else if (m.type === 'hover') {
            // 고를 수 있는 좌석 위에서만 손 모양이다(ADR-0236)
            canvas.style.cursor = m.selectable ? 'pointer' : '';
          } else if (m.type === 'hit' && m.seatIndex >= 0 && m.selectable && m.seatId && m.label) {
            b.pick({ seatId: m.seatId, label: m.label, tier: m.tier }, m.seatIndex);
          } else if (m.type === 'sectionList') setListSections(m.sections);
          else if (m.type === 'sectionState') {
            // 그사이 닫거나 다른 구역을 열었으면 늦게 온 응답은 버린다(Worker가 지금 보내는 구역과 어긋나지 않게)
            if (m.section === listedRef.current) setOpenSection({ section: m.section, baseIndex: m.baseIndex, states: m.states, seats: m.seats, tiers: m.tiers });
          } else if (m.type === 'stateChanged') {
            setOpenSection((o) => {
              if (!o || o.section !== m.section) return o;
              const states = o.states.slice();
              m.offsets.forEach((offset, i) => {
                states[offset] = m.states[i]!;
              });
              return { ...o, states };
            });
          } else if (m.type === 'error') onMapError(m);
        },
      });
      mapRef.current = map;
      toggle = (seatIndex) => map.send({ type: 'select', seatIndex });
      void headLoad.then((h) => {
        if (!live || !h || h.tiers.length === 0) return;
        const rank = tierRank(h.tiers);
        const names = tierNames(h.tiers);
        map.send({ type: 'tiers', ...(rank ? { tierRank: rank } : {}), ...(names ? { tierNames: names } : {}) });
      });
      cleanups.push(() => {
        mapRef.current = null;
        map.dispose();
        // 지도를 다시 만들면(다시 시도) 목록의 값도 새로 받는다
        listedRef.current = null;
        setListOpen(false);
        setListSections(null);
        setOpenSection(null);
      });

      const run = (c: GestureCommand) => {
        if (c.type === 'tap') map.send({ type: 'pointer', kind: 'up', x: c.x, y: c.y });
        else if (c.type === 'pan') map.send(c);
        else map.send({ type: 'zoomBy', factor: c.factor, x: c.x, y: c.y });
      };
      const gesture = createGesture();
      const at = (e: PointerEvent | WheelEvent) => {
        const r = canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top] as const;
      };
      const onDown = (e: PointerEvent) => {
        // 주 버튼(터치·펜 포함)만 받는다. 오른쪽·가운데 클릭은 좌석을 고르지 않는다
        if (e.button !== 0) return;
        canvas.setPointerCapture(e.pointerId);
        gesture.down(e.pointerId, ...at(e));
      };
      // 마우스 올림 표시(ADR-0236): 누르지 않은 마우스·펜이고 좌석을 고르는 동안만 Worker에 위치를 알린다
      const pickable = () => canPick(b.actor.getSnapshot().value);
      const hover = createHoverTracker((m) => map.send({ type: 'pointer', ...m }), pickable);
      const unsubscribe = b.subscribe(() => {
        if (!pickable()) hover.stop();
      });
      cleanups.push(() => void unsubscribe());
      const onMove = (e: PointerEvent) => {
        const [x, y] = at(e);
        gesture.move(e.pointerId, x, y).forEach(run);
        hover.move(x, y, e);
      };
      const onUp = (e: PointerEvent) => gesture.up(e.pointerId, ...at(e)).forEach(run);
      const onCancel = (e: PointerEvent) => gesture.cancel(e.pointerId);
      const onWheel = (e: WheelEvent) => {
        const factor = wheelFactor(e.deltaY, e.deltaMode);
        // 전체 보기에서 더 축소할 수 없으면 페이지가 스크롤되게 둔다
        if (factor < 1 && (viewRef.current?.zoom ?? 1) <= 1) return;
        e.preventDefault();
        const [x, y] = at(e);
        map.send({ type: 'zoomBy', factor, x, y });
      };
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onCancel);
      canvas.addEventListener('lostpointercapture', onCancel);
      canvas.addEventListener('pointerleave', hover.stop);
      canvas.addEventListener('wheel', onWheel, { passive: false });

      const resize = new ResizeObserver(() => {
        if (host.clientWidth > 0 && host.clientHeight > 0) map.send({ type: 'viewport', w: host.clientWidth, h: host.clientHeight, dpr: Math.min(8, window.devicePixelRatio || 1) });
      });
      resize.observe(host);
      const themeWatch = new MutationObserver(() => map.send({ type: 'theme', theme: themeNow() }));
      themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-seed-user-color-scheme'] });
      cleanups.push(() => {
        resize.disconnect();
        themeWatch.disconnect();
      });
    };
    start().catch(() => live && setPhase('failed'));

    return () => {
      live = false;
      abort.abort();
      cleanups.reverse().forEach((f) => f());
    };
  }, [eventId, attempt]);

  // 예매 시간이 끝났으면 안내를 잠깐 보이고 대기실로 옮긴다(차례가 온 뒤 15분 안이면 같은 대기표로 다시 입장한다, §5.3)
  useEffect(() => {
    if (phase !== 'ended' && phase !== 'invalid') return;
    clearAdmission(eventId, sessionStorage);
    clearHold(eventId);
    // 끝난 구매 세션의 키도 지운다(§5.3 '401'). 뒤로 가기로 되돌아오지 않게 지금 기록을 바꾼다
    void sessionRef.current?.end().catch(() => undefined);
    const t = setTimeout(() => window.location.replace(`/queue/${encodeURIComponent(eventId)}`), LEAVE_AFTER_MS);
    return () => clearTimeout(t);
  }, [phase, eventId]);

  // 홀드 타이머: 응답의 서버 시각으로 정한 마감까지(단조 시계, 끝나면 좌석을 비운다)
  const isHeld = booking?.value === 'held';
  useEffect(() => {
    if (!isHeld) {
      setHeldLeft(null);
      return;
    }
    let frozenTicks = 0;
    const tick = () => {
      const h = bookingRef.current?.held();
      if (!h) return;
      // 기기가 잠든 사이 단조 시계가 멈출 수 있어 벽시계와 함께 보고 더 이른 쪽을 쓴다
      if (h.frozen) {
        // 멈춘 홀드는 줄어들지 않고 만료로 끝내지 않는다. 풀렸는지는 가끔 다시 읽는다(H3, ADR-0254)
        setHeldLeft(h.frozenLeftMs ?? 0);
        frozenTicks += 1;
        if (frozenTicks % FROZEN_REREAD_TICKS === 0) void bookingRef.current?.refreshFrozen();
        return;
      }
      const left = Math.min(h.deadlineMono - performance.now(), h.deadlineWall - Date.now());
      setHeldLeft(left);
      if (left <= 0) bookingRef.current?.expire();
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [isHeld]);

  // 일시 정지: 재개를 알려 주는 길이 아직 없어 잠시 뒤 다시 홀드할 수 있게 한다(서버가 여전히 423이면 돌아온다)
  const isPaused = booking?.value === 'paused';
  useEffect(() => {
    if (!isPaused) return;
    const t = setTimeout(() => bookingRef.current?.resume(), PAUSED_RETRY_MS);
    return () => clearTimeout(t);
  }, [isPaused]);

  const prices = useMemo(() => new Map((head?.tiers ?? []).map((t) => [t.tierId, t.price])), [head]);
  const listTierNames = useMemo(() => new Map((head?.tiers ?? []).map((t) => [t.tierId, t.name])), [head]);
  const leave = useCallback(() => {
    void (async () => {
      await bookingRef.current?.leave();
      clearAdmission(eventId, sessionStorage);
      window.location.assign(`/events/${encodeURIComponent(eventId)}`);
    })();
  }, [eventId]);
  const send = useCallback((m: Parameters<SeatMapClient['send']>[0]) => mapRef.current?.send(m), []);
  const atFit = !view || view.zoom <= 1;
  const atMax = !view || view.zoom >= view.maxZoom;
  const seatLevel = view?.level === 'seats';
  const gone = phase === 'ended' || phase === 'invalid';
  const heldNow = isHeld ? (bookingRef.current?.held() ?? null) : null;
  const holdTimer = heldLeft === null ? null : holdClock(heldLeft);
  const summaryPhase = booking?.value === 'holding' || booking?.value === 'held' || booking?.value === 'paused' || booking?.value === 'saleEnded' ? booking.value : 'selecting';
  // 목록과 가상 스크롤은 연 사람만 받는다(첫 JS 예산, §5.8). 받지 못하면 그 자리에서 다시 시도한다(지도와 고른 좌석은 그대로다)
  const loadListView = () => {
    setListFailed(false);
    import('./SeatList').then(
      (m) => setListView(() => m.SeatList),
      () => setListFailed(true),
    );
  };

  const toggleList = () => {
    if (listOpen) {
      listedRef.current = null;
      setListOpen(false);
      setOpenSection(null);
      mapRef.current?.send({ type: 'listSection', section: null });
      return;
    }
    setListOpen(true);
    if (!listView) loadListView();
    if (!listSections) mapRef.current?.send({ type: 'listSections' });
  };

  const SeatListComponent = listView;

  // 자동 배정: 배정된 동안만 요약을 보이고, 홀드가 끝나면 고를 지도가 없으니 안내로 바꾼다
  const autoView = auto === 'done' && !isHeld ? 'expired' : auto;
  const showSummary = phase === 'ready' && booking && (auto === null || autoView === 'done');
  const bottomBar =
    showSummary && booking ? (
      <div className="sticky bottom-0 z-10">
        <LiveSummary
          picks={booking.picks}
          prices={prices}
          limit={booking.limit}
          phase={summaryPhase}
          notice={booking.notice}
          held={heldNow ? { labels: heldNow.seats?.map((x) => x.label) ?? heldNow.seatIds, total: heldNow.totalAmount ?? 0 } : null}
          checkoutHref={`/booking/${encodeURIComponent(eventId)}/checkout`}
          oneMinute={heldLeft !== null && heldLeft <= 60_000}
          onHold={() => void bookingRef.current?.hold()}
          onLeave={leave}
          extended={booking.extended}
          onExtend={() => void bookingRef.current?.extend()}
          onRelease={() => void bookingRef.current?.release()}
        />
      </div>
    ) : null;

  return (
    <AppShell variant="focus" bottomBar={bottomBar} focus={{ title: head?.title ?? '좌석 선택', subtitle: head?.subtitle ?? '', closeHref: `/events/${encodeURIComponent(eventId)}`, hold: holdTimer }}>
      <main ref={mainRef} className="page-main" id="main" tabIndex={-1}>
        {gone ? (
          <GoneState kind={phase} />
        ) : autoView ? (
          <AutoState kind={autoView} eventId={eventId} seats={heldNow?.seats?.map((x) => x.label) ?? []} />
        ) : phase === 'failed' ? (
          <section className="state" role="alert" style={{ padding: '96px 24px 24px' }}>
            <h1 className="sr-only">좌석 선택</h1>
            <span className="state-icon">
              <i className="ic ic-alert" aria-hidden="true" />
            </span>
            <h2 className="t-lg">좌석맵을 불러오지 못했습니다</h2>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => {
                // 지도 자리를 먼저 다시 그려야 효과가 그 자리에 캔버스를 만든다
                refreshedRef.current = false;
                autoRetriesRef.current = 0;
                setPhase('loading');
                setAttempt((a) => a + 1);
                mainRef.current?.focus();
              }}
            >
              다시 시도
            </button>
          </section>
        ) : (
          <div className="col gap-3 pt-3 pb-4 md:gap-3.5 md:px-6 md:pt-4 md:pb-6 lg:mx-auto lg:w-full lg:max-w-[1280px] lg:gap-4 lg:px-8 lg:pt-6 lg:pb-8">
            <h1 className="t-xl px-4 max-lg:sr-only md:px-0">좌석 선택</h1>
            {booking?.value === 'paused' ? (
              <NoticeBanner tone="danger" icon="pause" role="alert" title="판매가 잠시 멈췄습니다." className="mx-4 md:mx-0">
                고른 좌석은 홀드 시간 동안 유지됩니다
              </NoticeBanner>
            ) : null}
            {booking?.value === 'saleEnded' ? (
              <NoticeBanner tone="warning" icon="calendar" role="alert" className="mx-4 md:mx-0">
                판매 시간이 끝나 좌석을 새로 고를 수 없습니다. 이미 고른 좌석은 남은 시간 안에 결제할 수 있습니다
              </NoticeBanner>
            ) : null}
            <div className="col gap-1.5 px-4 md:flex-row md:flex-wrap md:items-center md:gap-x-7 md:gap-y-2 md:px-0">
              {head && head.tiers.length > 0 ? <PriceTierLegend tiers={head.tiers} variant={seatLevel ? 'plain' : 'swatch'} /> : null}
              {seatLevel ? <SeatLegend statuses={SEAT_LEGEND} /> : <ZoneLegend size="sm" />}
            </div>
            <div className="col" style={{ gap: 8 }}>
              <div className="relative">
                <div ref={hostRef} className="card-flat relative h-[420px] overflow-hidden md:h-[560px] lg:h-[600px]" />
                {listOpen ? (
                  // 지도는 밑에 그대로 둔다(크기가 0이 되면 Worker가 다시 그릴 값을 잃는다)
                  <div className="card-flat absolute inset-0 z-[2] overflow-hidden" style={{ background: 'var(--surface)' }}>
                    {SeatListComponent ? (
                      <SeatListComponent
                        sections={listSections}
                        open={openSection}
                        tierNames={listTierNames}
                        prices={prices}
                        onOpenSection={(section) => {
                          listedRef.current = section;
                          if (section === null) setOpenSection(null);
                          mapRef.current?.send({ type: 'listSection', section });
                        }}
                        onSeat={(seat, seatIndex) => bookingRef.current?.pick(seat, seatIndex)}
                      />
                    ) : listFailed ? (
                      <div className="state h-full" role="alert">
                        <p className="t-md fw-b">좌석 목록을 불러오지 못했습니다</p>
                        <button className="btn btn-outline btn-sm" type="button" onClick={loadListView}>
                          다시 시도
                        </button>
                      </div>
                    ) : (
                      <div className="grid h-full place-items-center" role="status">
                        <span className="spinner muted" aria-hidden="true" />
                        <span className="sr-only">좌석 목록을 불러오는 중</span>
                      </div>
                    )}
                  </div>
                ) : null}
                {phase === 'loading' ? (
                  <div className="absolute inset-0 grid place-items-center" role="status">
                    <span className="spinner muted" aria-hidden="true" />
                    <span className="sr-only">좌석맵을 불러오는 중</span>
                  </div>
                ) : null}
                {listOpen ? null : (
                <div className="absolute top-2 right-2 flex flex-col-reverse items-end gap-1.5 md:top-2.5 md:right-2.5 lg:top-3 lg:right-3 lg:flex-row lg:items-center" role="group" aria-label="배치도 확대·축소">
                  <button className="btn btn-outline btn-sm" type="button" disabled={atFit} onClick={() => send({ type: 'fit' })}>
                    전체 보기
                  </button>
                  <button className="icon-btn icon-btn-sm icon-btn-outline" type="button" aria-label="축소" disabled={atFit} onClick={() => send({ type: 'zoomBy', factor: 1 / ZOOM_STEP })}>
                    <i className="ic ic-minus" aria-hidden="true" />
                  </button>
                  <button className="icon-btn icon-btn-sm icon-btn-outline" type="button" aria-label="확대" disabled={atMax} onClick={() => send({ type: 'zoomBy', factor: ZOOM_STEP })}>
                    <i className="ic ic-plus" aria-hidden="true" />
                  </button>
                </div>
                )}
              </div>
              {phase === 'ready' ? (
                <div className="row px-4 md:px-0">
                  <button className="btn btn-outline btn-sm" type="button" aria-expanded={listOpen} onClick={toggleList}>
                    {listOpen ? '지도로 보기' : '목록으로 보기'}
                  </button>
                </div>
              ) : null}
              {!listOpen && view && !view.selectable ? <p className="hint px-4 text-center md:px-0" role="status">{view.level === 'seats' ? '조금 더 확대하면 좌석을 고를 수 있습니다' : '구역을 확대하면 좌석을 고를 수 있습니다'}</p> : null}
            </div>
          </div>
        )}
      </main>
    </AppShell>
  );
}
