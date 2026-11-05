'use client';
// 홈의 개인 값(찜한 공연 줄, 오픈 알림 종 토글 상태, 오프라인, d5 §5.1 ③·① '비로그인'·'오프라인', ADR-0199 결정 3, BUILD_ORDER HOT-300).
// 홈 피드는 개인 값을 싣지 않는다. 서버는 쿠키로 로그인 여부를 정하지 않고, 화면 스크립트가 같은 사이트 요청으로 확인한다
// (docs/frontend.md §2.5 '알림·외부 링크 착지 규칙'). 팬 요청이 401이면 토큰을 한 번 갱신하고 다시 보내며(§4.1 '401'), 그래도 401이면 비로그인이다.
// 찜 목록과 알림 상태는 따로 받는다(한쪽 서버가 없거나 실패해도 다른 쪽은 보인다). 알림 상태를 받기 전·못 받았으면 종 토글은 누를 수 없다
// (모르는 상태에서 켜면 이미 있던 신청의 밤 푸시 설정을 덮어쓴다). 팬 API 주소가 없으면(개발 서버에서 넣지 않았을 때) 비로그인처럼 둔다.
// api-client(실행부·작업 서술 표·호출 함수)는 늦게 가져온다(첫 화면 JS 예산, §5.8).
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { alertFailureText, OpenAlertProvider, OpenAlertToggle } from '@/features/open-alert';
import { isUnauthorizedError as isUnauthorized } from '@/shared/api/refresh';
import { ORIGINS } from '@/shared/config/origins';
import { cx } from '@/shared/lib/cx';
import { PicturePoster } from '@/shared/ui/PicturePoster';
import { likeSubText, statusBadge, toCard, type HomeCard } from '../model/feed';

type Status = 'loading' | 'guest' | 'ready';

interface PersonalValue {
  status: Status;
  wishes: HomeCard[];
  /** 알림 상태를 받았는가(받기 전·못 받았으면 종 토글은 누를 수 없다) */
  alertsKnown: boolean;
  /** 오픈 알림을 신청한 회차 */
  alerts: ReadonlySet<string>;
  /** 오픈 알림 켜기·끄기. 성공하면 true, 실패하면 보일 문구 */
  setAlert: (eventId: string, on: boolean) => Promise<true | string>;
}

const PersonalContext = createContext<PersonalValue>({ status: 'loading', wishes: [], alertsKnown: false, alerts: new Set(), setAlert: async () => '' });

export function usePersonal(): PersonalValue {
  return useContext(PersonalContext);
}

/** 홈 카드가 한 번에 묻는 회차 수 상한(openapi listSubscriptions eventIds 최대 50) */
const MAX_EVENT_IDS = 50;

/** api-client와 그 시작을 늦게 가져온다 */
async function loadApi() {
  const [identity, api] = await Promise.all([import('@peaket/api-client/endpoints/identity'), import('@/shared/api')]);
  api.ensureBrowserApi();
  return { ...identity, withFanRefresh: api.withFanRefresh };
}

export function HomePersonalProvider({ alertEventIds, children }: { alertEventIds: readonly string[]; children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [wishes, setWishes] = useState<HomeCard[]>([]);
  const [alerts, setAlerts] = useState<ReadonlySet<string>>(new Set());
  const [alertsKnown, setAlertsKnown] = useState(false);
  const key = alertEventIds.join(',');
  const ids = useMemo(() => [...new Set(key ? key.split(',') : [])].slice(0, MAX_EVENT_IDS), [key]);

  useEffect(() => {
    let live = true;
    if (!ORIGINS.api) {
      setStatus('guest');
      return;
    }
    const api = loadApi();
    api
      .then(({ withFanRefresh, listWishes }) => withFanRefresh(() => listWishes({ limit: 20 })))
      .then((w) => {
        if (!live) return;
        const now = new Date();
        setWishes((w.data.items ?? []).flatMap((c) => toCard(c, now) ?? []));
        setStatus('ready');
      })
      .catch((e: unknown) => {
        // 401(갱신 뒤에도)은 비로그인이다. 그 밖의 실패는 찜한 공연 줄만 숨긴다
        if (live) setStatus(isUnauthorized(e) ? 'guest' : 'ready');
      });
    if (ids.length > 0) {
      api
        .then(({ withFanRefresh, listSubscriptions }) => withFanRefresh(() => listSubscriptions({ eventIds: ids.join(',') })))
        .then((s) => {
          if (!live) return;
          setAlerts(new Set((s.data.items ?? []).flatMap((x) => (x.eventId && x.open ? [x.eventId] : []))));
          setAlertsKnown(true);
        })
        .catch((e: unknown) => {
          if (live && isUnauthorized(e)) setStatus('guest');
        });
    }
    return () => {
      live = false;
    };
  }, [ids]);

  const setAlert = useCallback(async (eventId: string, on: boolean): Promise<true | string> => {
    try {
      const { withFanRefresh, createEventSubscription, deleteEventSubscriptions } = await loadApi();
      await withFanRefresh<unknown>(() => (on ? createEventSubscription(eventId, { kind: 'OPEN' }) : deleteEventSubscriptions(eventId, { kind: 'OPEN' })));
      setAlerts((prev) => {
        const next = new Set(prev);
        if (on) next.add(eventId);
        else next.delete(eventId);
        return next;
      });
      return true;
    } catch (e) {
      if (isUnauthorized(e)) setStatus('guest');
      return alertFailureText(e, on);
    }
  }, []);

  return <PersonalContext.Provider value={{ status, wishes, alertsKnown, alerts, setAlert }}>{children}</PersonalContext.Provider>;
}

const subscribeOnline = (cb: () => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
};

/** 연결이 끊겼는가(서버가 그릴 때와 첫 그리기는 연결된 것으로 본다) */
function useOffline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => !navigator.onLine,
    () => false,
  );
}

const OFFLINE_ID = 'home-offline';

/**
 * 오픈 알림 토글의 문맥과 오프라인 띠: 비로그인이면 누를 때 로그인으로, 오프라인이면 띠를 띄우고 토글을 비활성으로 둔다
 * (d5 §5.1 '오프라인'. 셸 전체의 오프라인 띠는 셸 단계가 정하고, 그 전까지 홈은 본문 위에 띄운다)
 */
export function HomeOpenAlertProvider({ children }: { children: ReactNode }) {
  const { status } = usePersonal();
  const offline = useOffline();
  return (
    <OpenAlertProvider guest={status === 'guest'} loginHref="/login?next=%2F" {...(offline ? { offlineReasonId: OFFLINE_ID } : {})}>
      {offline ? (
        <p id={OFFLINE_ID} role="status" className="row t-sm mx-auto w-full max-w-[1280px] px-4 py-2 md:px-6 lg:px-8" style={{ gap: 6, background: 'var(--surface-muted)' }}>
          <i className="ic ic-wifi-off ic-16" aria-hidden="true" />
          인터넷 연결이 끊겼습니다. 연결되면 알림을 바꿀 수 있습니다
        </p>
      ) : null}
      {children}
    </OpenAlertProvider>
  );
}

/** 오픈 예정 카드의 종 토글: 신청 상태는 서버 값(listSubscriptions), 누르면 신청·끄기를 보낸다. 상태를 받기 전에는 누를 수 없다 */
export function HomeAlertToggle({ title, eventId, className }: { title: string; eventId: string; className?: string }) {
  const { status, alertsKnown, alerts, setAlert } = usePersonal();
  return (
    <OpenAlertToggle
      title={title}
      pressed={alerts.has(eventId)}
      onToggle={(next) => setAlert(eventId, next)}
      disabled={status !== 'guest' && !alertsKnown}
      {...(className ? { className } : {})}
    />
  );
}

/**
 * ③ 찜한 공연(로그인한 경우만, CMP-072 compact). 비로그인·받는 중·찜 0개면 줄을 그리지 않는다(d5 §5.1 '비로그인'·'섹션 비어 있음').
 * 받는 중에 뼈대를 그리지 않는 것은, 비로그인이면 곧 사라질 뼈대가 아래 섹션을 밀어 내지 않게 하려는 것이다 [가정]
 */
export function LikesSection({ sectionClass, railClass, headClass }: { sectionClass: string; railClass: string; headClass: string }) {
  const { status, wishes } = usePersonal();
  if (status !== 'ready' || wishes.length === 0) return null;
  const item = 'flex-none w-[256px] md:w-[280px] lg:w-[calc((100%-48px)/4)]';
  return (
    <section className={cx(sectionClass, 'gap-3 md:gap-3.5 lg:gap-4')} aria-labelledby="h-like">
      <div className={cx('section-title', headClass)}>
        <h2 id="h-like" className="lg:text-[22px] lg:leading-[30px]">
          찜한 공연
        </h2>
        <Link className="link-more" href="/my/likes">
          전체보기
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      </div>
      <ul className={cx(railClass, 'lg:gap-4')}>
        {wishes.map((c) => {
          const b = statusBadge(c);
          return (
            <li key={c.id} className={item}>
              <Link className="card row h-full" href={c.href} style={{ gap: 12, padding: 12, color: 'inherit' }}>
                <PicturePoster src={c.posterUrl} alt={c.posterAlt} width={300} height={400} sizes="56px" style={{ width: 56, flex: 'none', borderRadius: 'var(--r-sm)' }} />
                <div className="col grow" style={{ gap: 4 }}>
                  <h3 className="t-sm fw-b ellipsis">{c.title}</h3>
                  <p className="t-xs muted">{likeSubText(c)}</p>
                  <div className="row">
                    <span className={b.cls}>{b.text}</span>
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
