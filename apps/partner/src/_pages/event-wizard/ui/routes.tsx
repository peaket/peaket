// app/ 경로 파일이 다시 내보내는 위저드 페이지 셋
import { routes } from '@/shared/config/routes';
import type { RouteProps } from '@/shared/lib/preview';
import { EventWizardPage } from './EventWizardPage';

export async function NewEventPage({ searchParams }: RouteProps) {
  return <EventWizardPage mode="new" path={routes.eventNew()} searchParams={await searchParams} />;
}

export async function EditEventPage({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  return <EventWizardPage mode="edit" eventId={id} path={routes.eventTab(id, 'edit')} searchParams={await searchParams} />;
}

export async function SaleReviewPage({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  return <EventWizardPage mode="sale-review" eventId={id} path={routes.eventSaleReview(id)} searchParams={await searchParams} />;
}
