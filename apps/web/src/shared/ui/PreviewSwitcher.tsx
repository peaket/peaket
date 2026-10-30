'use client';
// 퍼블리싱 상태 고르기 패널(ds StateSwitcher + Next.js Link). 개발 서버에서만 보인다. 데이터 연결 단계에서 걷어 낸다(ADR-0170).
import Link from 'next/link';
import { StateSwitcher, type StateSwitcherProps } from '@peaket/ds/Preview';

export function PreviewSwitcher(props: Omit<StateSwitcherProps, 'renderLink'>) {
  if (process.env.NODE_ENV === 'production') return null;
  return <StateSwitcher {...props} renderLink={(p) => <Link {...p} scroll={false} />} />;
}
