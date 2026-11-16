'use client';
// SCR-002 공연 상세의 판매 상태·판매 자격·명단 밖 알림 훅(ADR-0272 결정 1·3·4, BUILD_ORDER HOT-346).
// 판정은 model/의 순수 함수가 하고, 이 파일은 받기만 한다. 받기·가게 코드와 api-client는 늦게 가져온다(첫 JS 예산, 결정 6).
// - useLiveSale: 예매 버튼 상태를 받기 운전자(model/live-sale-store.ts createLiveSaleDriver)에 넘기기만 한다. 운전자가 정한 때(문서가 처음 고른 상태가
//   queue일 때 한 번, queue인 동안 다시 보일 때)에만 대기 상태 파일 구간 0을 받는다. 오픈 전에 연 화면은 오픈 순간에 받지 않는다(리뷰 R040-1)
// - useSaleEligibility: 회원 팬이고 끝나지 않은 PRESALE 조각이 있을 때만 팬별 판매 자격을 문서마다 한 번 받는다(페이지 보관에서 돌아오면 다시)
// - useDeniedMarker: 대기실이 명단 밖으로 돌려보낸 주소 조각(#sale-eligibility-required)과 같은 탭 저장소의 출처 표시가 짝이 맞을 때만 알림의 창을 한 번 정하고,
//   조각은 늘 지운다(리뷰 R040-2, 보안 리뷰 W7L2-S2)
// 시계는 효과 안에서만 읽는다(그리는 중에 읽으면 ISR 항목이 저장되지 않는다, ui/no-render-clock.test.mjs).
import { useEffect, useRef, useState } from 'react';
import { ORIGINS } from '@/shared/config/origins';
import { browserClock } from '@/shared/lib/clock';
import type { BookingPhase } from '../model/detail';
import type { LiveSale } from '../model/live-sale';
import { takeDeniedMarker, type DetailSalePhase, type FanEligibilityState } from '../model/sale';

type LiveDriver = { phase(p: BookingPhase | undefined): void; visible(): void; view(): LiveSale; listen(l: () => void): () => void };
type EligibilityStore = { get(): FanEligibilityState; subscribe(l: () => void): () => void; refreshIfStarted(): Promise<void> };

/** 회차마다 문서에 하나(여러 부품이 같은 값을 본다) */
const liveDrivers = new Map<string, Promise<LiveDriver>>();
const eligibilityStores = new Map<string, Promise<EligibilityStore>>();

function liveDriver(eventId: string): Promise<LiveDriver> {
  let p = liveDrivers.get(eventId);
  if (!p) {
    p = Promise.all([import('../model/live-sale-store'), import('../model/live-sale')]).then(([{ createLiveSaleStore, createLiveSaleDriver }, { liveSaleUrl, LIVE_SALE_FETCH_INIT }]) => {
      const store = createLiveSaleStore({
        // 쿠키·사용자 머리·캐시 버스터 없이 브라우저 HTTP 캐시만 건너뛴다(docs/frontend.md §5.9). 본문을 읽지 못하면 모양 틀림(unknown)
        fetchFile: async () => {
          const r = await fetch(liveSaleUrl(ORIGINS.queueFiles, eventId), LIVE_SALE_FETCH_INIT);
          const body: unknown = r.status === 200 ? await r.json().catch(() => null) : null;
          return { status: r.status, body };
        },
        now: () => browserClock().now(),
      });
      return createLiveSaleDriver(store);
    });
    liveDrivers.set(eventId, p);
  }
  return p;
}

function eligibilityStore(eventId: string): Promise<EligibilityStore> {
  let p = eligibilityStores.get(eventId);
  if (!p) {
    p = import('../model/eligibility-store').then(({ createEligibilityStore }) => {
      const store = createEligibilityStore({
        // 401이면 토큰을 한 번 갱신하고 다시 보낸다(withFanRefresh). 그래도 실패면 가게가 자격 모름으로 본다
        fetchEligibility: async () => {
          const [catalog, api] = await Promise.all([import('@peaket/api-client/endpoints/catalog'), import('@/shared/api')]);
          api.ensureBrowserApi();
          return (await api.withFanRefresh(() => catalog.getFanSaleEligibility(eventId))).data;
        },
      });
      window.addEventListener('pageshow', (e) => {
        if (e.persisted) void store.refreshIfStarted();
      });
      return store;
    });
    eligibilityStores.set(eventId, p);
  }
  return p;
}

/**
 * 등급별 실시간 판매 상태. 예매 버튼 상태를 받기 운전자에 넘기기만 하고, 받을 때는 운전자가 정한다.
 * 다시 보임(visibilitychange) 듣기는 이 효과 안에서 달고 정리한다(판매 종료 뒤·화면을 떠난 뒤에는 받지 않는다, 리뷰 R040-4)
 */
export function useLiveSale(eventId: string, phase: BookingPhase | undefined): LiveSale {
  const [live, setLive] = useState<LiveSale>({ status: 'loading' });
  const [driver, setDriver] = useState<LiveDriver | null>(null);
  /** 문서가 처음 고른 상태(운전자 코드를 가져오기 전에 상태가 바뀌어도 첫 상태를 잃지 않게) */
  const first = useRef<BookingPhase | undefined>(undefined);
  if (first.current === undefined && phase !== undefined) first.current = phase;
  const known = phase !== undefined;

  // 운전자 코드는 처음 상태를 안 뒤에 늦게 가져온다
  useEffect(() => {
    if (!known) return;
    let alive = true;
    liveDriver(eventId).then(
      (d) => {
        if (alive) setDriver(d);
      },
      // 받기 코드를 가져오지 못하면 실패와 같다(고정 글 '판매 중')
      () => {
        if (alive) setLive({ status: 'unknown' });
      },
    );
    return () => {
      alive = false;
    };
  }, [eventId, known]);

  useEffect(() => {
    if (!driver) return;
    const off = driver.listen(() => setLive(driver.view()));
    const onVisible = () => {
      if (document.visibilityState === 'visible') driver.visible();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      off();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [driver]);

  useEffect(() => {
    if (!driver) return;
    if (first.current !== undefined) driver.phase(first.current);
    driver.phase(phase);
    setLive(driver.view());
  }, [driver, phase]);
  return live;
}

/** 팬별 판매 자격. needed(부를 때)가 아니면 받지 않고 idle이다. 받기 코드를 가져오는 동안도 받는 중이다 */
export function useSaleEligibility(eventId: string, needed: boolean): FanEligibilityState {
  const [fan, setFan] = useState<FanEligibilityState>({ status: 'idle' });
  useEffect(() => {
    if (!needed) return;
    let alive = true;
    let off: (() => void) | undefined;
    eligibilityStore(eventId).then(
      (s) => {
        if (!alive) return;
        off = s.subscribe(() => setFan(s.get()));
        setFan(s.get());
      },
      () => {
        if (alive) setFan({ status: 'none' });
      },
    );
    return () => {
      alive = false;
      off?.();
    };
  }, [eventId, needed]);
  return needed && fan.status === 'idle' ? { status: 'loading' } : needed ? fan : { status: 'idle' };
}

/**
 * 명단 밖 알림(ADR-0272 결정 4, 리뷰 R040-2·보안 리뷰 W7L2-S2 뒤). 처음 그린 뒤 한 번, 같은 탭 저장소의 대기실 출처 표시를 읽고 지우며(takeDeniedMarker)
 * 조각과 짝이 맞을 때만 그 시각으로 알림의 창을 정한다(조각만 붙인 바깥 링크로는 켜지지 않는다). 조각은 어느 경우든 history.replaceState로 지운다.
 * 끄는 타이머는 두지 않는다: 창 끝은 늘 조각 경계라 예매 버튼의 다음 고르기 시각(saleBoundaryAfter)이 이미 잡는다
 */
export function useDeniedMarker(eventId: string, phases: DetailSalePhase[], openAtMs: number): { untilMs?: number } | null {
  const [denied, setDenied] = useState<{ untilMs?: number } | null>(null);
  useEffect(() => {
    let kv: Storage | null = null;
    try {
      kv = window.sessionStorage;
    } catch {
      kv = null;
    }
    const marker = takeDeniedMarker({ kv, eventId, loc: window.location, deviceNowMs: Date.now(), readAtMs: browserClock().now(), phases, openAtMs });
    if (marker.cleanUrl !== null) window.history.replaceState(window.history.state, '', marker.cleanUrl);
    // 개발 모드의 효과 두 번 실행에서 두 번째(표시가 이미 없음)가 켠 값을 덮지 않게 켤 때만 둔다
    if (marker.denied) setDenied(marker.denied);
    // 처음 그린 뒤 한 번만 읽는다(표시와 조각은 지우므로 다시 읽어도 없다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return denied;
}
