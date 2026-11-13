// ticket 모듈 공개 파일(단위·계약 시험과 서비스 조립이 쓴다).
export * from './domain/ticket.js';
export * from './domain/ports.js';
export { TicketService, type TicketServiceDeps } from './application/ticket-service.js';
export { MemoryTicketStore } from './adapters/memory-ticket-store.js';
export { DrizzleTicketStore, type DrizzleTicketStoreOptions } from './adapters/db/drizzle-ticket-store.js';
export { ticketPackage, ticketServiceHandlers, type TicketGrpcUseCases, type TicketPackage } from './inbound/ticket.grpc.js';
