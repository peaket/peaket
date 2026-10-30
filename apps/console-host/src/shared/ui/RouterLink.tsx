// @peaket/ds 부품의 renderLink에 React Router Link를 넣는다. 다른 앱 주소(http…)와 같은 화면 안 #앵커는 보통 링크로 둔다.
import { Link } from 'react-router';
import type { RenderLinkProps } from '@peaket/ds/ConsoleShell';

export function renderRouterLink({ href, children, ...rest }: RenderLinkProps) {
  if (/^(https?:)?\/\//.test(href) || href.startsWith('#')) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}
