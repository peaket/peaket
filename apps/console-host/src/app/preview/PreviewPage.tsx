// 화면·상태 목록(개발 서버에서만). 모든 페이지의 상태 목록을 모으므로 pages보다 위인 app 층에 둔다(FSD 층 의존)
// 관제 화면 목록(/preview). 개발 서버에서만 경로가 있다(router.tsx, 운영 빌드에서는 없는 주소).
import { PreviewCatalog } from '@peaket/ds/Preview';
import { ROLES } from '@/entities/operator';
import { OTHER_APPS, SCREENS } from './screens';
import { useBodyTheme } from '@/shared/lib/theme';
import { useDocumentTitle } from '@/shared/lib/title';
import { renderRouterLink } from '@/shared/ui/RouterLink';

export function Page() {
  useDocumentTitle('화면 목록');
  useBodyTheme('dark');
  return (
    <>
      <PreviewCatalog appName="관제 콘솔" screens={SCREENS} otherApps={OTHER_APPS} renderLink={renderRouterLink} />
      <aside className="col" aria-labelledby="pv-role" style={{ maxWidth: 1040, margin: '0 auto', padding: '0 16px 56px', gap: 8 }}>
        <h2 className="t-md fw-b" id="pv-role">
          역할 바꿔 보기
        </h2>
        <p className="t-sm muted">주소에 ?role=을 붙이면 위 상태 바·왼쪽 내비가 그 역할로 바뀌고, 다른 화면으로 옮겨도 남습니다(d5 §3.3 역할별 메뉴 표).</p>
        <ul className="row wrap" style={{ gap: 6 }}>
          {ROLES.map((r) => (
            <li key={r}>
              <a className="chip chip-sm" href={`/dashboard?role=${r}`}>
                {r}
              </a>
            </li>
          ))}
          <li>
            <a className="chip chip-sm" href="/dashboard?theme=light">
              라이트로 보기
            </a>
          </li>
        </ul>
      </aside>
    </>
  );
}
