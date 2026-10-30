// SCR-069 포렌식 리플레이 1단계 데모(d5 §7.17, docs/features/forensic-replay.md §2). 관제 셸 없이 자체 머리를 둔 한 페이지다.
// 디자인 캔버스 보드 SCR-069-d(데스크톱 1280 이상)·t(태블릿 768~1279)·m(휴대폰)을 배치마다 그대로 옮겼다. 데이터는 보드의 합성 예시다.
// 상태는 ?state=(보드 state 열거값), 테마는 다크가 처음 값이고 ?theme=light로 라이트를 본다(보드 루트가 pk dark).
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { resolvePreviewState, StateSwitcher } from '@peaket/ds/Preview';
import { useLayout } from './lib/layout';
import { goState, useSearch } from './lib/url';
import { ReplayProvider, type ReplayControls, type Speed } from './screen/controls';

// 배치마다 보드를 따로 받는다(휴대폰이 데스크톱 그림을 받지 않게)
const VIEWS = {
  desktop: lazy(() => import('./screen/view-d')),
  tablet: lazy(() => import('./screen/view-t')),
  phone: lazy(() => import('./screen/view-m')),
};

/** 데스크톱·태블릿 보드의 상태 13개(휴대폰 보드 8개는 이 안에 든다) */
const STATES = [
  '재생',
  '후보 고름',
  '만드는 중',
  '파일 거절',
  '복사 방식',
  '그래픽 대체',
  '돌릴 수 없음',
  '사건 일부 버림',
  '일시정지',
  '시나리오 고르기',
  '스포츠 플레이오프 오픈',
  '사람 흉내 봇 · 후보 고름',
  '권한 없음(2단계)',
] as const;
type State = (typeof STATES)[number];
const DEFAULT: State = '재생';

/**
 * 휴대폰 보드(SCR-069-m)의 상태 8개. 나머지 다섯(봇 후보·파일 거절·복사 방식·그래픽 대체·사람 흉내 봇)은 휴대폰 보드에 자리가 없어
 * 휴대폰에서는 가장 가까운 상태 '재생'으로 그리고, 상태 고르기 패널에도 이 여덟만 보인다.
 */
const PHONE_STATES: readonly State[] = ['재생', '만드는 중', '돌릴 수 없음', '사건 일부 버림', '일시정지', '시나리오 고르기', '스포츠 플레이오프 오픈', '권한 없음(2단계)'];

export function App() {
  const search = useSearch();
  const { layout, xl } = useLayout();
  const requested = resolvePreviewState(search, STATES, DEFAULT);
  const boardStates = layout === 'phone' ? PHONE_STATES : STATES;
  const state: State = boardStates.includes(requested) ? requested : DEFAULT;
  const theme = new URLSearchParams(search).get('theme') === 'light' ? 'light' : 'dark';
  useEffect(() => {
    document.body.classList.add('pk');
    document.body.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const [speed, setSpeed] = useState<Speed>('×1');
  const close = useCallback(() => goState(undefined), []);
  const ctl = useMemo<ReplayControls>(
    () => ({
      play: () => goState(undefined),
      pause: () => goState('일시정지'),
      speed,
      setSpeed,
      togglePick: () => goState(state === '시나리오 고르기' ? undefined : '시나리오 고르기'),
      regenerate: () => goState('만드는 중'),
    }),
    [speed, state],
  );

  // 바깥 틀은 보드 루트(pk dark, 세로 flex, 바닥 색)와 같다. 데스크톱 오른쪽 패널은 xl 460(보드), lg 1280~1439에서는 400으로 줄인다(d5 §7.17 lg)
  const rootStyle = {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    background: 'var(--surface-basement)',
    position: 'relative',
    '--fx-panel': xl ? '460px' : '400px',
  } as CSSProperties;

  const View = VIEWS[layout];

  return (
    <ReplayProvider value={ctl}>
      <div style={rootStyle}>
        <SkipToMain />
        <Suspense
          fallback={
            <p className="t-sm muted" role="status" style={{ padding: 20 }}>
              화면을 불러오는 중입니다…
            </p>
          }
        >
          <View state={state} close={close} />
        </Suspense>
      </div>
      {import.meta.env.DEV ? (
        <>
          <StateSwitcher path="/" states={boardStates} current={state} keep={{ theme: theme === 'light' ? 'light' : undefined }} />
          {theme === 'dark' ? (
            // ds 상태 고르기 패널의 테마 링크는 라이트가 처음 값인 앱 기준이라, 다크가 처음 값인 이 데모는 라이트 링크를 따로 둔다(개발용)
            <a className="chip chip-sm" href={`?${new URLSearchParams({ ...(state !== DEFAULT ? { state } : {}), theme: 'light' }).toString()}`} style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 2147483000 }}>
              라이트로 보기 · 개발용
            </a>
          ) : null}
        </>
      ) : null}
    </ReplayProvider>
  );
}

/** 본문 바로가기(보드의 sr-only 링크). 초점을 받으면 보이게 한다(WCAG 2.4.1·2.4.7) */
function SkipToMain() {
  const [shown, setShown] = useState(false);
  return (
    <a
      className={shown ? 'btn btn-primary btn-sm' : 'sr-only'}
      href="#main"
      style={shown ? { position: 'absolute', left: 8, top: 8, zIndex: 200 } : undefined}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
    >
      본문 바로가기
    </a>
  );
}
