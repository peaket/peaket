'use client';
// SCR-002 공연 상세의 판매 상태·판매 자격·명단 밖 알림 훅(ADR-0272 결정 1·3·4, BUILD_ORDER HOT-346).
// 판정은 model/의 순수 함수가 하고, 이 파일은 받기만 한다. 받기·가게 코드와 api-client는 늦게 가져온다(첫 JS 예산, 결정 6).
// - useLiveSale: 예매 버튼 상태가 오픈 뒤 진입(queue)일 때만 대기 상태 파일 구간 0을 문서마다 한 번 받고, 다시 보일 때 보낸 지 30초가 지났으면 한 번 더 받는다
// - useSaleEligibility: 회원 팬이고 끝나지 않은 PRESALE 조각이 있을 때만 팬별 판매 자격을 문서마다 한 번 받는다(페이지 보관에서 돌아오면 다시)
// - useDeniedMarker: 대기실이 명단 밖으로 돌려보낸 주소 조각(#sale-eligibility-required)을 읽어 알림을 켜고 조각만 지운다
// 시계는 효과 안에서만 읽는다(그리는 중에 읽으면 ISR 항목이 저장되지 않는다, ui/no-render-clock.test.mjs).
import { useEffect, useState } from 'react';
import { ORIGINS } from '@/shared/config/origins';
import { browserClock } from '@/shared/lib/clock';
import type { LiveSale } from '../model/live-sale';
import { deniedUntilMs, isDeniedHash, type DetailSalePhase, type FanEligibilityState } from '../model/sale';

type LiveStore = { get(): LiveSale; listen(l: () => void): () => void; start(): void; onVisible(): void };
type EligibilityStore = { get(): FanEligibilityState; subscribe(l: () => void): () => void; refreshIfStarted(): Promise<void> };

/** 회차마다 문서에 하나(여러 부품이 같은 값을 본다) */
const liveStores = new Map<string, Promise<LiveStore>>();
const eligibilityStores = new Map<string, Promise<EligibilityStore>>();

function liveStore(eventId: string): Promise<LiveStore> {
  let p = liveStores.get(eventId);
  if (!p) {
    p = Promise.all([import('../model/live-sale-store'), import('../model/live-sale')]).then(([{ createLiveSaleStore }, { liveSaleUrl, LIVE_SALE_FETCH_INIT }]) => {
      const store = createLiveSaleStore({
        // 쿠키·사용자 머리·캐시 버스터 없이 브라우저 HTTP 캐시만 건너뛴다(docs/frontend.md §5.9). 본문을 읽지 못하면 모양 틀림(unknown)
        fetchFile: async () => {
          const r = await fetch(liveSaleUrl(ORIGINS.queueFiles, eventId), LIVE_SALE_FETCH_INIT);
          const body: unknown = r.status === 200 ? await r.json().catch(() => null) : null;
          return { status: r.status, body };
        },
        now: () => browserClock().now(),
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') store.onVisible();
      });
      return store;
    });
    liveStores.set(eventId, p);
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

/** 등급별 실시간 판매 상태. active(오픈 뒤 진입)가 아니면 받지 않고 뼈대 값이다(오픈 전 배지는 상태 파일을 쓰지 않는다) */
export function useLiveSale(eventId: string, active: boolean): LiveSale {
  const [live, setLive] = useState<LiveSale>({ status: 'loading' });
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let off: (() => void) | undefined;
    liveStore(eventId).then(
      (s) => {
        if (!alive) return;
        off = s.listen(() => setLive(s.get()));
        s.start();
        setLive(s.get());
      },
      // 받기 코드를 가져오지 못하면 실패와 같다(고정 글 '판매 중')
      () => {
        if (alive) setLive({ status: 'unknown' });
      },
    );
    return () => {
      alive = false;
      off?.();
    };
  }, [eventId, active]);
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

/** setTimeout이 받는 가장 긴 기다림(약 24.8일). 그보다 멀면 문서 동안 켜 둔다 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * 명단 밖 알림(ADR-0272 결정 4). 처음 그린 뒤 주소 조각이 정확히 #sale-eligibility-required이면 켜고 history.replaceState로 조각만 지운다
 * (새로고침하면 다시 팬 자격으로 고른다). 지금이 든 공개 조각이 끝나면 끄고, 조각을 모르면 문서 동안 켜 둔다
 */
export function useDeniedMarker(phases: DetailSalePhase[]): boolean {
  const [denied, setDenied] = useState(false);
  // 처음 그린 뒤 한 번만 읽는다(조각은 지우므로 다시 읽어도 없다)
  useEffect(() => {
    if (!isDeniedHash(window.location.hash)) return;
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, '', `${pathname}${search}`);
    setDenied(true);
  }, []);
  useEffect(() => {
    if (!denied) return;
    const now = browserClock().now();
    const until = deniedUntilMs(phases, now);
    if (until === undefined || until - now > MAX_TIMER_MS) return;
    const t = setTimeout(() => setDenied(false), Math.max(until - now, 0));
    return () => clearTimeout(t);
  }, [denied, phases]);
  return denied;
}
