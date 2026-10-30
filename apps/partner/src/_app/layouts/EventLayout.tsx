// 공연 문맥(/events/[id]/…) 레이아웃: 없는 공연이나 다른 테넌트 공연은 404(d5 §6 머리글, FR-068). 문맥 머리·탭은 각 화면이 widgets/event-context로 그린다.
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getProduction } from '@/entities/production';

export default async function EventLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProduction(id)) notFound();
  return <>{children}</>;
}
