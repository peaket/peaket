// 화면·상태 목록(`/preview`, 개발 서버에서만). 서버·클라이언트 컴포넌트 어디서나 쓴다.
import { renderLinkOrAnchor, type RenderLink } from '../../lib/link';
import { previewHref, type PreviewScreen } from './preview';

export interface PreviewCatalogProps {
  appName: string;
  screens: readonly PreviewScreen[];
  /** 다른 앱의 화면 목록 */
  otherApps?: readonly { name: string; href: string }[];
  renderLink?: RenderLink;
}

export function PreviewCatalog({ appName, screens, otherApps, renderLink }: PreviewCatalogProps) {
  const link = (href: string, children: React.ReactNode, external?: boolean) =>
    external ? <a href={href}>{children}</a> : renderLinkOrAnchor(renderLink, { href, children });
  return (
    <main className="page-main" id="main" style={{ maxWidth: 1040, margin: '0 auto', padding: '24px 16px 56px', gap: 24 }}>
      <header className="col" style={{ gap: 8 }}>
        <h1 className="t-xl fw-b">{appName} 화면 목록</h1>
        <p className="t-sm muted">
          디자인 캔버스를 옮긴 퍼블리싱 화면입니다. 데이터는 목업이고, 상태는 주소의 <code>?state=</code>로 고릅니다(개발 서버에서만 보입니다).
        </p>
        {otherApps && otherApps.length > 0 && (
          <nav aria-label="다른 앱 화면 목록" className="row wrap" style={{ gap: 8 }}>
            {otherApps.map((a) => (
              <a key={a.href} className="chip" href={a.href}>
                {a.name}
              </a>
            ))}
          </nav>
        )}
      </header>
      <div style={{ overflowX: 'auto' }}>
        <table className="table" style={{ width: '100%' }}>
          <caption className="sr-only">{appName} 화면과 상태</caption>
          <thead>
            <tr>
              <th scope="col">SCR</th>
              <th scope="col">화면</th>
              <th scope="col">경로</th>
              <th scope="col">상태</th>
            </tr>
          </thead>
          <tbody>
            {screens.map((s) => (
              <tr key={`${s.id}-${s.path}`}>
                <td className="t-sm num">{s.id}</td>
                <td className="t-sm fw-b">{link(s.path, s.name, s.external)}</td>
                <td className="t-xs muted">
                  <code>{s.path}</code>
                  {s.note ? <div>{s.note}</div> : null}
                </td>
                <td className="t-xs">
                  {s.states.length === 0 ? (
                    <span className="muted">퍼블리싱 예정</span>
                  ) : (
                    <ul className="row wrap" style={{ gap: 4 }}>
                      {s.states.map((st) => (
                        <li key={st}>{link(previewHref(s.path, st), <span className="chip chip-sm">{st}</span>, s.external)}</li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
