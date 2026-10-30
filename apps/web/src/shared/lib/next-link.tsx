// ds 부품의 renderLink에 Next.js Link를 넣는다. 함수라서 서버 컴포넌트 → 클라이언트 컴포넌트로 넘길 수 없다:
// 서버 컴포넌트끼리(RoundPicker·PreviewCatalog 등)나 클라이언트 컴포넌트 안에서만 쓴다.
import Link from 'next/link';
import type { RenderLink } from '@peaket/ds/WebShell';

export const renderNextLink: RenderLink = (props) => <Link {...props} />;
