// 예매자 명단 내부 HTTP 모듈(A2-03). purchase DB의 결제 완료 주문·SOLD 좌석만 읽는다.
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, INTERNAL_TOKEN, InternalTokenGuard } from '@peaket/platform';
import { DrizzleAttendeeReader } from './adapters/db/drizzle-attendee-reader.js';
import { ATTENDEE_READER, AttendeeExportController } from './inbound/attendee-export.controller.js';

@Module({})
export class AttendeeExportModule {
  static register(o: { database: Database; labels?: { resolve(eventId: string, seatIds: readonly string[]): Promise<readonly (string | undefined)[]> } }): DynamicModule {
    return {
      module: AttendeeExportModule,
      controllers: [AttendeeExportController],
      providers: [
        { provide: ATTENDEE_READER, useValue: new DrizzleAttendeeReader(o.database, o.labels) },
        { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
        InternalTokenGuard,
      ],
    };
  }
}
