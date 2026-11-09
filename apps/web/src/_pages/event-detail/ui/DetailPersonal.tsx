'use client';
// 공연 상세의 개인 값(찜·오픈 알림, d5 §5.2 ⑥·⑫ '정적 셸 위에 … 알림·찜 토글을 클라이언트 영역으로 얹는다', BUILD_ORDER HOT-311).
// 상세 응답(공개 캐시)은 개인 값을 싣지 않는다. 화면 스크립트가 같은 사이트 요청으로 받는다(docs/frontend.md §2.5).
// - 찜 상태: `GET /v1/wishes?productionIds=`(찜한 것만), 알림 상태: `GET /v1/subscriptions?eventIds=`. 401(갱신 뒤에도)이면 비로그인이다.
// - 상태를 받기 전·못 받았으면 토글을 누를 수 없다(모르는 상태에서 켜면 이미 있던 신청을 덮어쓴다, HOT-300과 같다).
// - 알림 상태 응답(캐시하지 않음)의 Date로 서버 시각 보정 표본을 더한다(docs/frontend.md §3.3 '그 밖의 화면').
// - 본인확인·예매 제한·선예매 같은 다른 개인 상태는 HOT-321·340이 얹는다. api-client는 늦게 가져온다(첫 화면 JS 예산, §5.8).
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { alertFailureText, OpenAlertProvider } from '@/features/open-alert';
import { isRefreshUnavailableError, isUnauthorizedError as isUnauthorized } from '@/shared/api/refresh';
import { ORIGINS } from '@/shared/config/origins';
import { browserClock } from '@/shared/lib/clock';

type Status = 'loading' | 'guest' | 'ready';

interface PersonalValue {
  status: Status;
  alertKnown: boolean;
  alertOn: boolean;
  setAlert: (on: boolean) => Promise<true | string>;
  wishKnown: boolean;
  wished: boolean;
  setWish: (on: boolean) => Promise<true | string>;
}

const PersonalContext = createContext<PersonalValue>({
  status: 'loading',
  alertKnown: false,
  alertOn: false,
  setAlert: async () => '',
  wishKnown: false,
  wished: false,
  setWish: async () => '',
});

export function useDetailPersonal(): PersonalValue {
  return useContext(PersonalContext);
}

async function loadApi() {
  const [identity, api] = await Promise.all([import('@peaket/api-client/endpoints/identity'), import('@/shared/api')]);
  api.ensureBrowserApi();
  return { ...identity, withFanRefresh: api.withFanRefresh };
}

export function DetailPersonalProvider({ eventId, productionId, loginHref, children }: { eventId: string; productionId: string; loginHref: string; children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [alertKnown, setAlertKnown] = useState(false);
  const [alertOn, setAlertOn] = useState(false);
  const [wishKnown, setWishKnown] = useState(false);
  const [wished, setWished] = useState(false);

  useEffect(() => {
    let live = true;
    if (!ORIGINS.api) {
      setStatus('guest');
      return;
    }
    const api = loadApi();
    // 첫 조회는 '다시 불러오기' 상태가 없어, 갱신이 일시 장애로 끝나도 예전처럼 비로그인 모양으로 둔다(버튼이 '불러오는 중'에 묶이지 않게)
    const guest = (e: unknown) => {
      if (live && (isUnauthorized(e) || isRefreshUnavailableError(e))) setStatus('guest');
    };
    api
      .then(({ withFanRefresh, listSubscriptions }) => {
        const sent = performance.now();
        return withFanRefresh(() => listSubscriptions({ eventIds: eventId })).then((s) => ({ s, sent, received: performance.now() }));
      })
      .then(({ s, sent, received }) => {
        if (!live) return;
        browserClock().addDateHeader(s.headers.get('date'), sent, received);
        setAlertOn((s.data.items ?? []).some((x) => x.eventId === eventId && x.open));
        setAlertKnown(true);
        setStatus('ready');
      })
      .catch(guest);
    api
      .then(({ withFanRefresh, listWishes }) => withFanRefresh(() => listWishes({ productionIds: productionId })))
      .then((w) => {
        if (!live) return;
        setWished((w.data.items ?? []).some((c) => c.productionId === productionId));
        setWishKnown(true);
        setStatus('ready');
      })
      .catch(guest);
    return () => {
      live = false;
    };
  }, [eventId, productionId]);

  const setAlert = useCallback(
    async (on: boolean): Promise<true | string> => {
      try {
        const { withFanRefresh, createEventSubscription, deleteEventSubscriptions } = await loadApi();
        await withFanRefresh<unknown>(() => (on ? createEventSubscription(eventId, { kind: 'OPEN' }) : deleteEventSubscriptions(eventId, { kind: 'OPEN' })));
        setAlertOn(on);
        return true;
      } catch (e) {
        if (isUnauthorized(e)) setStatus('guest');
        return alertFailureText(e, on);
      }
    },
    [eventId],
  );

  const setWish = useCallback(
    async (on: boolean): Promise<true | string> => {
      try {
        const { withFanRefresh, putProductionWish, deleteProductionWish } = await loadApi();
        await withFanRefresh<unknown>(() => (on ? putProductionWish(productionId) : deleteProductionWish(productionId)));
        setWished(on);
        return true;
      } catch (e) {
        if (isUnauthorized(e)) setStatus('guest');
        return on ? '찜하지 못했습니다. 잠시 뒤 다시 해 주세요' : '찜을 해제하지 못했습니다. 잠시 뒤 다시 해 주세요';
      }
    },
    [productionId],
  );

  return (
    <PersonalContext.Provider value={{ status, alertKnown, alertOn, setAlert, wishKnown, wished, setWish }}>
      <OpenAlertProvider guest={status === 'guest'} loginHref={loginHref}>
        {children}
      </OpenAlertProvider>
    </PersonalContext.Provider>
  );
}
