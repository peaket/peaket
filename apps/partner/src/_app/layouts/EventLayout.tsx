// 공연 문맥(/events/[id]/…) 레이아웃: 없는 공연이나 다른 테넌트 공연은 404(d5 §6 머리글, FR-068). 문맥 머리·탭은 각 화면이 widgets/event-context로 그린다.
// 소문자 UUID 공연 ID는 실제 공연이라 들인다. 있는지·이 파트너 것인지는 화면이 부르는 API의 404가 정한다(공연 개요 읽기 HOT-260 전, ADR-0264 결정 2).
// 목업 ID는 지금처럼 목업 자료로 본다.
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getProduction } from '@/entities/production';

const PRODUCTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function EventLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!PRODUCTION_ID.test(id) && !getProduction(id)) notFound();
  return <>{children}</>;
}
