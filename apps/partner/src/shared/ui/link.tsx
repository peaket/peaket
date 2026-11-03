// ds 부품의 renderLink 자리에 Next.js Link를 넣는다. 함수는 서버 부품 → 클라이언트 부품으로 넘기지 못하므로,
// 클라이언트 ds 부품(PartnerShell·StateSwitcher)에는 'use client' 파일 안에서 이 함수를 넘긴다.
import Link from 'next/link';
import type { PreviewCatalogProps } from '@peaket/ds/Preview';

export type RenderLinkProps = Parameters<NonNullable<PreviewCatalogProps['renderLink']>>[0];

export function renderNextLink(props: RenderLinkProps) {
  return <Link {...props} />;
}
