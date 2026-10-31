// SCR-069 포렌식 리플레이 1단계 데모(d5 §7.17, docs/features/forensic-replay.md §2). 관제 셸 없이 자체 머리를 둔 한 페이지다.
// 디자인 캔버스 보드 SCR-069-d(데스크톱 1280 이상)·t(태블릿 768~1279)·m(휴대폰)을 배치마다 그대로 옮겼다. 데이터는 보드의 합성 예시다.
// 상태는 ?state=(보드 state 열거값), 테마는 다크가 처음 값이고 ?theme=light로 라이트를 본다(보드 루트가 pk dark).
// 데이터 원천은 ?source=조사|연구로 고른다(없으면 합성, d5 §7.17·OpenSpec add-fraud-investigation-screens 결정 7). 원천마다 상태 목록이 다르다(lib/source.ts).
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { resolvePreviewState, StateSwitcher } from '@peaket/ds/Preview';
import { useLayout } from './lib/layout';
import { DEFAULT_STATE, parseSource, SOURCES, sourceParam, sourceSearch, statesFor, type Source } from './lib/source';
import { goState, useSearch } from './lib/url';
import { ReplayProvider, type ReplayControls, type Speed } from './screen/controls';

// 배치마다 보드를 따로 받는다(휴대폰이 데스크톱 그림을 받지 않게)
const VIEWS = {
  desktop: lazy(() => import('./screen/view-d')),
  tablet: lazy(() => import('./screen/view-t')),
  phone: lazy(() => import('./screen/view-m')),
};

export function App() {
  const search = useSearch();
  const { layout, xl } = useLayout();
  const source = parseSource(search);
  // 휴대폰 보드(SCR-069-m)는 자리가 없는 상태(후보 고름·복사 방식 등)를 빼고 그 상태는 기본 상태 '재생'으로 그린다
  const boardStates = statesFor(source, layout);
  const state = resolvePreviewState(search, boardStates, DEFAULT_STATE);
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
          <View state={state} close={close} source={source} />
        </Suspense>
      </div>
      {import.meta.env.DEV ? (
        <>
          {/* 이 데모는 다크가 처음 값이라 baseTheme을 준다(테마 링크가 라이트로 보기·다크로 보기를 바르게 고른다) */}
          <StateSwitcher path="/" states={boardStates} current={state} baseTheme="dark" keep={{ theme: theme === 'light' ? 'light' : undefined, source: sourceParam(source) }} />
          <DevSourceLinks search={search} current={source} />
        </>
      ) : null}
    </ReplayProvider>
  );
}

/** 원천 바꿔 보기(개발용). 정본은 연 길이 원천을 정하고 화면 안에서 바꾸지 못하므로(CMP-082) 운영 묶음에는 없다 */
function DevSourceLinks({ search, current }: { search: string; current: Source }) {
  return (
    <nav aria-label="원천 바꿔 보기 · 개발용" className="row" style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 2147483000, gap: 6 }}>
      {SOURCES.map((s) => (
        <a key={s} className="chip chip-sm" href={sourceSearch(search, s) || '/'} aria-current={s === current ? 'true' : undefined} style={s === current ? { fontWeight: 700 } : undefined}>
          {s === current ? '● ' : ''}
          {sourceParam(s) ?? '합성'}
        </a>
      ))}
    </nav>
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
