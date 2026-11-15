// 받는 층: core-svc export가 예매자 명단을 읽는 내부 HTTP(A2-03). 결제 완료·SOLD 좌석만 돌려준다.
import { BadRequestException, Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';

export const ATTENDEE_READER = Symbol('purchase.AttendeeReader');

const QuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100), cursor: z.string().min(1).max(200).optional() }).strict();
const Seat = z.object({ seatLabel: z.string(), tier: z.string() });
const Page = z.object({
  items: z.array(z.object({ orderId: z.uuid(), eventId: z.uuid(), buyerName: z.string(), buyerPhone: z.string(), seats: z.array(Seat), ticketCount: z.number().int() })),
  nextCursor: z.string().nullable(),
  bookingCount: z.number().int(),
  ticketCount: z.number().int(),
});

type PageView = z.output<typeof Page>;
interface AttendeeReader {
  list(eventId: string, limit: number, cursor?: string): Promise<PageView>;
}

@Controller('internal/v1/events')
@Roles(['public'])
@UseGuards(InternalTokenGuard)
export class AttendeeExportController {
  constructor(@Inject(ATTENDEE_READER) private readonly reader: AttendeeReader) {}

  @Get(':eventId/attendees')
  @ContractRouteSchema({ responses: { 200: Page } })
  async list(@Param('eventId') eventId: string, @Query() raw: unknown) {
    const q = QuerySchema.safeParse(raw);
    if (!q.success) throw new BadRequestException('조회 조건이 올바르지 않습니다');
    return this.reader.list(eventId, q.data.limit, q.data.cursor);
  }
}
