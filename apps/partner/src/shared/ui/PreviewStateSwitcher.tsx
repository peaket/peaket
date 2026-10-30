'use client';
// 화면 오른쪽 아래의 상태 고르기(개발용). 운영 빌드에서는 그리지 않는다. 데이터를 잇는 단계에서 걷어 낸다(ADR-0170).
import { StateSwitcher } from '@peaket/ds/Preview';
import { renderNextLink } from './link';

export interface PreviewStateSwitcherProps {
  path: string;
  states: readonly string[];
  current: string;
  keep?: Record<string, string | undefined>;
}

export function PreviewStateSwitcher({ path, states, current, keep }: PreviewStateSwitcherProps) {
  if (process.env.NODE_ENV === 'production') return null;
  return <StateSwitcher path={path} states={states} current={current} keep={keep ?? {}} renderLink={renderNextLink} />;
}
