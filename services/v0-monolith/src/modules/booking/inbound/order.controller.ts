// 받는 층: 주문 v0 HTTP(docs/features/payment.md §13 동작 1~3). 사람은 게이트웨이가 넘긴 계정·pid로만 고른다.
import { Controller, ForbiddenException, Get, Header, HttpCode, Post } from '@nestjs/common';
import { ContractBody, ContractParams, CurrentPrincipal, type Principal, Roles, requestLog } from '@peaket/platform';
import { z } from 'zod';
import { BookingService, type Requester } from '../application/booking-service.js';
import { PAYMENT_KEY_PATTERN } from '../domain/booking.js';

const CreateBody = z.object({ holdId: z.uuid() }).strict();
type CreateBody = z.output<typeof CreateBody>;
const OrderParams = z.object({ orderId: z.uuid() }).strict();
type OrderParams = z.output<typeof OrderParams>;
const PayBody = z.object({ paymentKey: z.string().regex(PAYMENT_KEY_PATTERN), amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
type PayBody = z.output<typeof PayBody>;

function requester(me: Principal): Requester {
  // ticket:buy는 본인확인을 마친 계정이라 pid가 있어야 한다. 없으면 게이트웨이 신원 머리가 덜 왔다
  if (!me.pid) throw new ForbiddenException();
  return { accountId: me.accountId, pid: me.pid };
}

/** 인증이 필요한 경로는 Cache-Control: no-store다(docs/api/guidelines.md §9). 주문 보기·확정 응답에는 티켓 코드가 실린다 */
const NO_STORE = 'no-store';

/** 주문은 v0에만 있어 /v0/ 아래에 둔다(/v1/은 openapi 계약의 경로만) */
@Controller('v0/orders')
export class OrderController {
  constructor(private readonly booking: BookingService) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', NO_STORE)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  async create(@ContractBody(CreateBody) body: CreateBody, @CurrentPrincipal() me: Principal) {
    requestLog().set({ queuePhase: 'purchase' });
    return this.booking.create(requester(me), body.holdId);
  }

  @Get(':orderId')
  @Header('Cache-Control', NO_STORE)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  async view(@ContractParams(OrderParams) p: OrderParams, @CurrentPrincipal() me: Principal) {
    requestLog().set({ queuePhase: 'purchase' });
    return this.booking.view(requester(me), p.orderId);
  }

  @Post(':orderId/payment')
  @HttpCode(200)
  @Header('Cache-Control', NO_STORE)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  async pay(@ContractParams(OrderParams) p: OrderParams, @ContractBody(PayBody) body: PayBody, @CurrentPrincipal() me: Principal) {
    requestLog().set({ queuePhase: 'purchase' });
    return this.booking.pay(requester(me), p.orderId, body);
  }
}
