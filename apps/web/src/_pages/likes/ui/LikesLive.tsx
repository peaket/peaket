'use client';
// SCR-054 관심 공연 탭의 실서버 목록(F-05-8, GAT-260). 목업은 API 주소가 없는 퍼블리싱 빌드에만 남긴다.
// - 목록은 브라우저가 같은 사이트 요청으로 `GET /v1/wishes`를 부른다(401이면 한 번 갱신). 401이 끝나면 로그인 안내다.
// - 실서버 모드에는 목업 카드 fallback·목업 배지를 쓰지 않는다(IR-06). 첫 그리기·로딩·빈·오류를 실제 값으로 그린다.
// - 찜 해제·다시 찜은 온라인이면 바로 저장하고, 오프라인이면 `peaket.wishQueue`에 마지막 동작만 남긴다.
// - online·화면 복귀에 대기열을 다시 보낸다. 204만 지우고, 401은 멈추며 4xx·5xx·끊김은 지우지 않고 남긴다(FE-T37·IR-07).
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  flushWishQueue,
  queueWish,
  readStoredWishQueue,
  writeStoredWishQueue,
  type WishAction,
} from '@/features/wish-queue';
import { isUnauthorizedError } from '@/shared/api/refresh';
import { ORIGINS } from '@/shared/config/origins';
import { serverLikeCards, type LiveCard } from '../model/lists';
import { liveLikesBadge, type LikesScreen } from '../model/live';
import { LikesTabs } from './LikesClient';
import { LikeCardList, LikesEmpty } from './LikeCardList';

async function loadApi() {
  const [identity, api] = await Promise.all([import('@peaket/api-client/endpoints/identity'), import('@/shared/api')]);
  api.ensureBrowserApi();
  return { ...identity, withFanRefresh: api.withFanRefresh };
}

export function LikesLive({
  initialTab,
  initialOffline,
  alertsPanel,
  alertsBadge,
}: {
  initialTab: 'likes' | 'alerts';
  initialOffline?: boolean;
  alertsPanel: ReactNode;
  alertsBadge?: number;
}) {
  // 실서버 모드의 첫 그리기는 빈 목록이다. 목업 카드 fallback을 쓰지 않는다(IR-06)
  const [cards, setCards] = useState<LiveCard[]>([]);
  const [screen, setScreen] = useState<LikesScreen>(ORIGINS.api ? 'loading' : 'ready');
  const [offline, setOffline] = useState(Boolean(initialOffline));
  const [pendingIds, setPendingIds] = useState<string[]>(() => readStoredWishQueue().map((x) => x.productionId));
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    if (!ORIGINS.api) return;
    try {
      const { withFanRefresh, listWishes } = await loadApi();
      const r = await withFanRefresh(() => listWishes({ limit: 100 }));
      if (!mounted.current) return;
      const stored = readStoredWishQueue();
      setPendingIds(stored.map((x) => x.productionId));
      const next = serverLikeCards(r.data.items ?? [], stored.map((x) => x.productionId));
      setCards(next);
      setScreen('ready');
    } catch (e) {
      if (!mounted.current) return;
      if (isUnauthorizedError(e)) setScreen('guest');
      else setScreen('error');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const send = useCallback(async (productionId: string, action: WishAction): Promise<true | string> => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const q = queueWish(readStoredWishQueue(), productionId, action, Date.now());
      writeStoredWishQueue(q);
      setPendingIds(q.map((x) => x.productionId));
      setOffline(true);
      return true;
    }
    try {
      const { withFanRefresh, putProductionWish, deleteProductionWish } = await loadApi();
      await withFanRefresh<unknown>(() => (action === 'PUT' ? putProductionWish(productionId) : deleteProductionWish(productionId)));
      const q = readStoredWishQueue().filter((x) => x.productionId !== productionId);
      writeStoredWishQueue(q);
      setPendingIds(q.map((x) => x.productionId));
      return true;
    } catch (e) {
      if (isUnauthorizedError(e)) setScreen('guest');
      return action === 'PUT' ? '찜하지 못했습니다. 잠시 뒤 다시 해 주세요' : '찜을 해제하지 못했습니다. 잠시 뒤 다시 해 주세요';
    }
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    if (!ORIGINS.api || readStoredWishQueue().length === 0) return;
    const r = await flushWishQueue({
      read: readStoredWishQueue,
      write: writeStoredWishQueue,
      send: async (item) => {
        try {
          const { withFanRefresh, putProductionWish, deleteProductionWish } = await loadApi();
          await withFanRefresh<unknown>(() => (item.action === 'PUT' ? putProductionWish(item.productionId) : deleteProductionWish(item.productionId)));
          return 204;
        } catch (e) {
          if (isUnauthorizedError(e)) return 401;
          const status = (e as { status?: unknown }).status;
          return typeof status === 'number' && status >= 400 ? status : 503;
        }
      },
    });
    if (r.needsLogin) setScreen('guest');
    setPendingIds(readStoredWishQueue().map((x) => x.productionId));
    setOffline(typeof navigator !== 'undefined' ? !navigator.onLine : false);
    if (r.sent > 0) await load();
  }, [load]);

  useEffect(() => {
    const onOnline = () => {
      setOffline(false);
      void flush();
    };
    const onOffline = () => setOffline(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void flush();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [flush]);

  const likesPanel =
    screen === 'guest' ? (
      <div className="state" style={{ padding: '56px 16px' }}>
        <span className="state-icon">
          <i className="ic ic-heart" aria-hidden="true" />
        </span>
        <h2 className="t-lg">로그인하면 찜한 공연을 볼 수 있습니다</h2>
        <Link className="btn btn-secondary" href="/login">
          로그인
        </Link>
      </div>
    ) : screen === 'error' ? (
      <div className="state" style={{ padding: '56px 16px' }}>
        <h2 className="t-lg">찜한 공연을 불러오지 못했습니다</h2>
        <button className="btn btn-secondary" type="button" onClick={() => void load()}>
          다시 시도
        </button>
      </div>
    ) : screen === 'loading' ? (
      <div className="state" aria-busy="true" style={{ padding: '56px 16px' }}>
        <span className="state-icon">
          <i className="ic ic-heart" aria-hidden="true" />
        </span>
        <h2 className="t-lg">찜한 공연을 불러오는 중입니다</h2>
      </div>
    ) : cards.length === 0 ? (
      <LikesEmpty />
    ) : (
      <LikeCardList
        cards={cards.map((c) => ({ ...c, pending: pendingIds.includes(c.id) }))}
        offline={offline}
        pendingCount={pendingIds.length}
        onToggle={(id, next) => send(id, next ? 'PUT' : 'DELETE')}
      />
    );

  return (
    <LikesTabs initial={initialTab} likesBadge={liveLikesBadge(screen, cards)} alertsBadge={alertsBadge} likesPanel={likesPanel} alertsPanel={alertsPanel} />
  );
}
