// export 모듈 조립. 명단 원천은 shop의 merch_order·merch_order_item이다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK, DATABASE } from '@peaket/platform';
import { AttendeeExports } from './application/attendee-exports.js';
import type { ActorNameResolver, AttendeeExportStore, AttendeeSource, BookersReauth, PartnerEventLookup } from './domain/ports.js';
import { ATTENDEE_EXPORT_STORE, ATTENDEE_SOURCE, BOOKERS_REAUTH, PARTNER_EVENT_LOOKUP } from './domain/ports.js';
import { DrizzleAttendeeExportStore } from './adapters/db/drizzle-export-store.js';
import { MemoryAttendeeExportStore } from './adapters/memory-export-store.js';
import { GrpcAdminAccountNames, JwksBookersReauth, MemoryActorNames, UnavailableBookersReauth } from './adapters/sources.js';
import { DrizzleMerchOrderStore, DrizzlePartnerEventDirectory, MemoryMerchOrderStore, MemoryPartnerEventDirectory, type MerchOrderStore } from '../shop/index.js';
import { PartnerAttendeeExportController } from './inbound/partner-attendee-export.controller.js';

export const EXPORT_PARTNER_DATABASE = Symbol.for('peaket.export.partner-database');
export const EXPORT_ACTOR_NAMES = Symbol.for('peaket.export.actor-names');

export interface MemoryExportWiring {
  store?: AttendeeExportStore;
  source?: AttendeeSource;
  events?: PartnerEventLookup;
  reauth?: BookersReauth;
  actors?: ActorNameResolver;
}

export interface DatabaseExportWiring {
  database: Database;
  partnerDatabase: Database;
  /** identity 관리 키. 없으면 재인증 경로가 항상 403이다(개발·시험) */
  jwks?: { url: string; issuer: string };
  /** identity gRPC 주소. 없으면 표시 이름은 역할 이름으로 남는다 */
  identityGrpc?: string;
}

class MerchAttendeeSource implements AttendeeSource {
  constructor(private readonly store: MerchOrderStore) {}
  list(promoterId: string, eventId: string, limit: number, cursor?: string) {
    return this.store.listAttendees(promoterId, eventId, limit, cursor);
  }
  count(promoterId: string, eventId: string) {
    return this.store.countAttendees(promoterId, eventId);
  }
}

@Module({})
export class ExportModule {
  static register(o: { storage: 'memory'; wiring?: MemoryExportWiring } | ({ storage: 'database' } & DatabaseExportWiring)): DynamicModule {
    if (o.storage === 'database') {
      const providers: Provider[] = [
        { provide: EXPORT_PARTNER_DATABASE, useValue: o.partnerDatabase },
        { provide: ATTENDEE_EXPORT_STORE, useFactory: (db: Database) => new DrizzleAttendeeExportStore(db), inject: [EXPORT_PARTNER_DATABASE] },
        {
          provide: ATTENDEE_SOURCE,
          useFactory: (partner: Database, app: Database) => new MerchAttendeeSource(new DrizzleMerchOrderStore(partner, app)),
          inject: [EXPORT_PARTNER_DATABASE, DATABASE],
        },
        { provide: PARTNER_EVENT_LOOKUP, useFactory: (db: Database) => new DrizzlePartnerEventDirectory(db), inject: [DATABASE] },
        { provide: BOOKERS_REAUTH, useValue: o.jwks ? new JwksBookersReauth({ jwksUrl: o.jwks.url, issuer: o.jwks.issuer }) : new UnavailableBookersReauth() },
        { provide: EXPORT_ACTOR_NAMES, useValue: o.identityGrpc ? new GrpcAdminAccountNames(o.identityGrpc) : undefined },
        {
          provide: AttendeeExports,
          useFactory: (store: AttendeeExportStore, source: AttendeeSource, events: PartnerEventLookup, reauth: BookersReauth, actors: ActorNameResolver | undefined, clock: Clock) =>
            new AttendeeExports({ store, attendees: source, events, reauth, actors: actors ?? { displayName: async () => undefined }, clock }),
          inject: [ATTENDEE_EXPORT_STORE, ATTENDEE_SOURCE, PARTNER_EVENT_LOOKUP, BOOKERS_REAUTH, EXPORT_ACTOR_NAMES, CLOCK],
        },
      ];
      return { module: ExportModule, controllers: [PartnerAttendeeExportController], providers };
    }
    return {
      module: ExportModule,
      controllers: [PartnerAttendeeExportController],
      providers: [
        { provide: ATTENDEE_EXPORT_STORE, useValue: o.wiring?.store ?? new MemoryAttendeeExportStore() },
        { provide: ATTENDEE_SOURCE, useValue: o.wiring?.source ?? new MerchAttendeeSource(new MemoryMerchOrderStore()) },
        { provide: PARTNER_EVENT_LOOKUP, useValue: o.wiring?.events ?? new MemoryPartnerEventDirectory() },
        { provide: BOOKERS_REAUTH, useValue: o.wiring?.reauth ?? new UnavailableBookersReauth() },
        { provide: EXPORT_ACTOR_NAMES, useValue: o.wiring?.actors ?? new MemoryActorNames() },
        {
          provide: AttendeeExports,
          useFactory: (store: AttendeeExportStore, source: AttendeeSource, events: PartnerEventLookup, reauth: BookersReauth, actors: ActorNameResolver, clock: Clock) =>
            new AttendeeExports({ store, attendees: source, events, reauth, actors, clock }),
          inject: [ATTENDEE_EXPORT_STORE, ATTENDEE_SOURCE, PARTNER_EVENT_LOOKUP, BOOKERS_REAUTH, EXPORT_ACTOR_NAMES, CLOCK],
        },
      ],
    };
  }
}
