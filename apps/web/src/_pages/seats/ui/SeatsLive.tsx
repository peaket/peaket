'use client';
// SCR-010 좌석 선택의 실제 화면(d5 §5.10, docs/frontend.md §4.2.2·§5.2, BUILD_ORDER HOT-350 ①, ADR-0224).
// 대기실이 탭 저장소에 둔 입장 저장값을 읽어 구매 세션 키를 열고(첫 스냅샷에 임시 공개키를 싣는다), 좌석맵 Worker에 좌석맵 파일·스냅샷을 맡긴다.
// 좌석맵 패키지·서명기는 늦게 가져온다(첫 JS 예산, §5.8). 캔버스는 효과 안에서 만든다: OffscreenCanvas로 넘긴 캔버스는 다시 넘길 수 없어 다시 시도·Strict Mode마다 새로 만든다.
// 고른 좌석의 홀드·요약은 HOT-353, 접근성 목록은 HOT-354, 실시간은 HOT-357에서 잇는다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { PriceTierLegend } from '@peaket/ds/PriceTierLegend';
import { SeatLegend, type SeatStatus } from '@peaket/ds/SeatStatusBadge';
import type { FromWorker, SeatMapClient } from '@peaket/seatmap';
import type { PurchaseSigner } from '@peaket/api-client/purchase';
import { ORIGINS } from '@/shared/config/origins';
import { AppShell } from '@/widgets/app-shell';
import { clearAdmission, createGesture, errorPhase, readAdmission, seatmapLayoutUrl, snapshotUrl, tierNames, tierRank, wheelFactor, type GestureCommand, type SeatsPhase } from '../model/live';
import { GoneState } from './GoneState';
import { ZoneLegend } from './ZoneLegend';

const SEAT_LEGEND: readonly SeatStatus[] = ['available', 'held-by-others', 'mine', 'sold', 'unavailable', 'wheelchair'];
/** [+]·[−] 배율(엔진 ZOOM_STEP과 같다. 좌석맵 패키지를 첫 묶음에 넣지 않으려고 글자로 둔다) */
const ZOOM_STEP = 1.5;
/** Retry-After가 있는 503·429를 스스로 다시 받는 횟수 [가정] */
const AUTO_RETRY_MAX = 3;
/** 예매 시간이 끝났을 때 안내를 보이고 대기실로 옮기기까지 [가정](d5 §5.10 '버튼 없이 넘어가는 중') */
const LEAVE_AFTER_MS = 2500;

interface Head {
  title: string;
  subtitle: string;
  tiers: { tierId: string; name: string; price: number }[];
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
    return { title: e.title ?? '좌석 선택', subtitle: [dateText(e.startsAt), e.placeName].filter(Boolean).join(' · '), tiers: [...tiers].sort((a, b) => b.price - a.price) };
  } catch {
    return null;
  }
}

const themeNow = (): 'light' | 'dark' => (document.documentElement.dataset.seedUserColorScheme === 'dark' ? 'dark' : 'light');

export function SeatsLive({ eventId }: { eventId: string }) {
  const [phase, setPhase] = useState<SeatsPhase>('loading');
  const [attempt, setAttempt] = useState(0);
  const [head, setHead] = useState<Head | null>(null);
  const [view, setView] = useState<View | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<SeatMapClient | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const viewRef = useRef<View | null>(null);
  const sessionRef = useRef<PurchaseSigner | null>(null);
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
      if (!layoutUrl || !ORIGINS.api) return setPhase('failed');

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
            drawn = true;
            setPhase('ready');
          } else if (m.type === 'view') {
            viewRef.current = m;
            // 카메라만 바뀌면 화면을 다시 그리지 않는다(끌 때마다 전체가 다시 그려지지 않게)
            setView((v) => (v && v.level === m.level && v.zoom === m.zoom && v.maxZoom === m.maxZoom && v.selectable === m.selectable ? v : m));
          } else if (m.type === 'hit' && m.seatIndex >= 0) map.send({ type: 'select', seatIndex: m.seatIndex });
          else if (m.type === 'error') onMapError(m);
        },
      });
      mapRef.current = map;
      void headLoad.then((h) => {
        if (!live || !h || h.tiers.length === 0) return;
        const rank = tierRank(h.tiers);
        const names = tierNames(h.tiers);
        map.send({ type: 'tiers', ...(rank ? { tierRank: rank } : {}), ...(names ? { tierNames: names } : {}) });
      });
      cleanups.push(() => {
        mapRef.current = null;
        map.dispose();
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
      const onMove = (e: PointerEvent) => gesture.move(e.pointerId, ...at(e)).forEach(run);
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
    // 끝난 구매 세션의 키도 지운다(§5.3 '401'). 뒤로 가기로 되돌아오지 않게 지금 기록을 바꾼다
    void sessionRef.current?.end().catch(() => undefined);
    const t = setTimeout(() => window.location.replace(`/queue/${encodeURIComponent(eventId)}`), LEAVE_AFTER_MS);
    return () => clearTimeout(t);
  }, [phase, eventId]);

  const send = useCallback((m: Parameters<SeatMapClient['send']>[0]) => mapRef.current?.send(m), []);
  const atFit = !view || view.zoom <= 1;
  const atMax = !view || view.zoom >= view.maxZoom;
  const seatLevel = view?.level === 'seats';
  const gone = phase === 'ended' || phase === 'invalid';

  return (
    <AppShell variant="focus" focus={{ title: head?.title ?? '좌석 선택', subtitle: head?.subtitle ?? '', closeHref: `/events/${encodeURIComponent(eventId)}` }}>
      <main ref={mainRef} className="page-main" id="main" tabIndex={-1}>
        {gone ? (
          <GoneState kind={phase} />
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
            <div className="col gap-1.5 px-4 md:flex-row md:flex-wrap md:items-center md:gap-x-7 md:gap-y-2 md:px-0">
              {head && head.tiers.length > 0 ? <PriceTierLegend tiers={head.tiers} variant={seatLevel ? 'plain' : 'swatch'} /> : null}
              {seatLevel ? <SeatLegend statuses={SEAT_LEGEND} /> : <ZoneLegend size="sm" />}
            </div>
            <div className="col" style={{ gap: 8 }}>
              <div className="relative">
                <div ref={hostRef} className="card-flat relative h-[420px] overflow-hidden md:h-[560px] lg:h-[600px]" />
                {phase === 'loading' ? (
                  <div className="absolute inset-0 grid place-items-center" role="status">
                    <span className="spinner muted" aria-hidden="true" />
                    <span className="sr-only">좌석맵을 불러오는 중</span>
                  </div>
                ) : null}
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
              </div>
              {view && !view.selectable ? <p className="hint px-4 text-center md:px-0" role="status">{view.level === 'seats' ? '조금 더 확대하면 좌석을 고를 수 있습니다' : '구역을 확대하면 좌석을 고를 수 있습니다'}</p> : null}
            </div>
          </div>
        )}
      </main>
    </AppShell>
  );
}
