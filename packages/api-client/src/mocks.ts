// MSW 2 처리기 모음(orval 생성물, src/gen/endpoints/*/*.msw.ts). 시험과 개발 화면만 가져온다: 운영 묶음에는 넣지 않는다(FE-T21, docs/frontend.md §2.2)
import { getCatalogMock } from './gen/endpoints/catalog/catalog.msw';
import { getIdentityMock } from './gen/endpoints/identity/identity.msw';
import { getInvestigationsMock } from './gen/endpoints/investigations/investigations.msw';
import { getOpsMock } from './gen/endpoints/ops/ops.msw';
import { getOrdersMock } from './gen/endpoints/orders/orders.msw';
import { getPartnerMock } from './gen/endpoints/partner/partner.msw';
import { getQueueMock } from './gen/endpoints/queue/queue.msw';
import { getReviewsMock } from './gen/endpoints/reviews/reviews.msw';
import { getScannerMock } from './gen/endpoints/scanner/scanner.msw';
import { getSeatsMock } from './gen/endpoints/seats/seats.msw';
import { getShopMock } from './gen/endpoints/shop/shop.msw';
import { getSupportMock } from './gen/endpoints/support/support.msw';
import { getTicketsMock } from './gen/endpoints/tickets/tickets.msw';
import { getWebhooksMock } from './gen/endpoints/webhooks/webhooks.msw';

/** 모든 작업의 MSW 처리기(faker 값). setupServer(...allMockHandlers()) 꼴로 쓴다 */
export const allMockHandlers = () => [
  ...getCatalogMock(),
  ...getIdentityMock(),
  ...getInvestigationsMock(),
  ...getOpsMock(),
  ...getOrdersMock(),
  ...getPartnerMock(),
  ...getQueueMock(),
  ...getReviewsMock(),
  ...getScannerMock(),
  ...getSeatsMock(),
  ...getShopMock(),
  ...getSupportMock(),
  ...getTicketsMock(),
  ...getWebhooksMock(),
];

export { getCatalogMock };
export { getIdentityMock };
export { getInvestigationsMock };
export { getOpsMock };
export { getOrdersMock };
export { getPartnerMock };
export { getQueueMock };
export { getReviewsMock };
export { getScannerMock };
export { getSeatsMock };
export { getShopMock };
export { getSupportMock };
export { getTicketsMock };
export { getWebhooksMock };
