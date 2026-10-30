// 앱 라우터의 링크(Next.js Link, React Router Link)를 넣을 수 있게 하는 공통 타입
import type { ReactNode } from "react";

export interface RenderLinkProps {
  href: string;
  className?: string;
  children: ReactNode;
  "aria-current"?: "page" | "step" | "location" | "true";
  "aria-label"?: string;
  "aria-describedby"?: string;
}

/** 링크를 그리는 함수. 없으면 <a>를 쓴다 */
export type RenderLink = (props: RenderLinkProps) => ReactNode;

export function renderLinkOrAnchor(renderLink: RenderLink | undefined, props: RenderLinkProps): ReactNode {
  if (renderLink) return renderLink(props);
  const { children, ...rest } = props;
  return <a {...rest}>{children}</a>;
}
