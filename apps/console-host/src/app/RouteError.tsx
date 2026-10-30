// 경로 오류. 화면 덩어리를 받지 못하면 그 화면 자리만 바꾸고 셸(위 상태 바·메뉴·경보 패널)은 그대로 둔다(d5 §3.3, docs/frontend.md §5.7 '화면별 늦게 싣기').
// 모양은 SCR-059 관제 보드(SCR-059-console·-t·-m)의 '화면 불러오기 실패'·'화면 불러오기 실패(새 버전)' 그대로다.
// 배포 식별자(첫 화면 묶음 파일 이름의 contenthash)가 바뀌었으면 "새 버전이 있습니다 [새로고침]" 띠를 함께 보인다.
// 이 부품은 늦게 싣는 화면 덩어리에 넣지 않는다(덩어리를 못 받는 상황에서 그려야 하므로 첫 화면 묶음에 둔다).
// 셸 밖 오류(로그인·화면 목록)는 RootError가 그린다.
import { useEffect, useState } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { useLayout } from '@/shared/lib/layout';
import { useDocumentTitle } from '@/shared/lib/title';
import { useMainStyle } from '@/shared/model/shell';

const reload = () => window.location.reload();

/** 보드의 <main class="cs-main" style> 값(SCR-059 관제 변형) */
const MAIN_STYLE = {
  desktop: { justifyContent: 'center', alignItems: 'center', padding: '40px 20px' },
  tablet: { justifyContent: 'center', alignItems: 'center', padding: '40px 24px' },
  phone: { justifyContent: 'center' },
} as const;

/** 지금 실린 첫 화면 묶음 파일들(운영 빌드는 assets/main.[contenthash].js) */
function entryScripts(doc: Document): string[] {
  return Array.from(doc.querySelectorAll<HTMLScriptElement>('script[src]'))
    .map((s) => new URL(s.getAttribute('src') ?? '', window.location.origin).pathname)
    .filter((p) => p.startsWith('/assets/'))
    .sort();
}

/** 새로 받은 index.html의 첫 화면 묶음이 지금 것과 다르면 새 배포다. 개발 서버는 파일 이름에 해시가 없어 늘 false */
function useDeployChanged(enabled: boolean): boolean {
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const now = entryScripts(document);
    if (now.length === 0) return;
    let alive = true;
    fetch('/', { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((html) => {
        if (!alive || !html) return;
        const next = entryScripts(new DOMParser().parseFromString(html, 'text/html'));
        if (next.length > 0 && next.join('|') !== now.join('|')) setChanged(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled]);
  return changed;
}

export function ScreenError() {
  const err = useRouteError();
  const layout = useLayout();
  const notFound = isRouteErrorResponse(err) && err.status === 404;
  const newVersion = useDeployChanged(!notFound);
  useMainStyle(MAIN_STYLE[layout], `route-error-${layout}`);
  useDocumentTitle(notFound ? '찾을 수 없는 화면' : '화면을 불러오지 못함');
  const phone = layout === 'phone';

  return (
    <div className="col" style={phone ? { width: '100%' } : { width: '100%', maxWidth: 560 }}>
      {notFound ? (
        <section className="card">
          <div className="state" style={{ padding: phone ? '32px 20px' : '48px 32px' }}>
            <span className="state-icon" style={phone ? { width: 56, height: 56 } : undefined}>
              <i className="ic ic-search" aria-hidden="true" />
            </span>
            <h1 className={phone ? 't-lg' : 't-xl'} tabIndex={-1}>
              찾을 수 없습니다
            </h1>
            <p className={phone ? 't-sm muted' : 't-md muted'}>주소를 다시 확인하거나 왼쪽 메뉴에서 찾아 주세요.</p>
            <a className={phone ? 'btn btn-secondary btn-lg btn-block' : 'btn btn-secondary'} href="/dashboard" style={{ marginTop: phone ? 4 : 8 }}>
              <i className="ic ic-home" aria-hidden="true" />
              대시보드로 가기
            </a>
          </div>
        </section>
      ) : (
        <>
          {newVersion ? (
            <div className="banner banner-info" role="status" style={{ alignItems: 'center', marginBottom: 16 }}>
              <i className="ic ic-info" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">새 버전이 있습니다</span>
              </div>
              <button onClick={reload} className="btn btn-primary btn-sm" type="button">
                <i className="ic ic-refresh" aria-hidden="true" />
                새로고침
              </button>
            </div>
          ) : null}
          <section className="card">
            <div className="state" role="alert" style={{ padding: phone ? '32px 20px' : '48px 32px' }}>
              <span className="state-icon is-warning" style={phone ? { width: 56, height: 56 } : undefined}>
                <i className="ic ic-alert" aria-hidden="true" />
              </span>
              <h1 className={phone ? 't-lg' : 't-xl'} tabIndex={-1}>
                화면을 불러오지 못했습니다
              </h1>
              <p className={phone ? 't-sm muted' : 't-md muted'}>위 상태 바와 경보는 그대로 받습니다</p>
              <div
                className={phone ? 'col' : 'row wrap'}
                style={phone ? { gap: 8, width: '100%', marginTop: 4 } : { gap: '12px 20px', justifyContent: 'center', marginTop: 8 }}
              >
                {/* 새 버전이면 주 행동은 띠의 [새로고침]이라 [다시 시도]는 보조 모양이다(보드 '화면 불러오기 실패(새 버전)') */}
                <button
                  onClick={reload}
                  className={['btn', newVersion ? 'btn-secondary' : 'btn-primary', layout === 'desktop' ? '' : 'btn-lg', phone ? 'btn-block' : '']
                    .filter(Boolean)
                    .join(' ')}
                  type="button"
                >
                  <i className="ic ic-refresh" aria-hidden="true" />
                  다시 시도
                </button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export function RootError() {
  return (
    <main className="col" id="main" style={{ minHeight: '100vh', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12, background: 'var(--surface-basement)' }}>
      <h1 className="t-xl">화면을 열지 못했습니다</h1>
      <p className="t-sm muted">잠시 뒤 다시 시도하세요.</p>
      <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
        다시 시도
      </button>
    </main>
  );
}
