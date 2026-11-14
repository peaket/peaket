// 우선 구매 모듈의 공개 면.
export { PriorityModule, PRIORITY_GRANTS, PRIORITY_CANCELLED_TICKETS, PRIORITY_SEAT_HOLDS, PRIORITY_SEAT_CANDIDATES, PRIORITY_SEAT_MAP, type PriorityModuleDeps } from './priority.module.js';
export { GrantPriorityPurchase, PriorityGrantNotFound, PriorityStoreUnavailable, type GrantPriorityPurchaseInput, type GrantPriorityPurchaseResult } from './application/grant-priority-purchase.js';
export { WithdrawPriorityGrant } from './application/withdraw-priority-grant.js';
export { MemoryPriorityGrantStore } from './adapters/memory-priority-grant-store.js';
export { DrizzleCancelledTickets } from './adapters/db/drizzle-cancelled-tickets.js';
export { DrizzlePriorityGrantStore } from './adapters/db/drizzle-priority-grant-store.js';
export { SeatMapPriorityCandidates } from './adapters/seat-map-priority-candidates.js';
export { PRIORITY_GRANT_KINDS, PRIORITY_GRANT_STATUSES, PRIORITY_GRANT_TTL_MS, priorityGrantUsable, type CancelledTicketView, type NewPriorityGrant, type PriorityGrant, type PriorityGrantKind, type PriorityGrantResult, type PriorityGrantStatus } from './domain/priority-grant.js';
export type { CancelledTickets, PriorityGrantLogger, PriorityGrantStore, PrioritySeatCandidates, PrioritySeatHolds } from './domain/ports.js';
export { PriorityGrantController } from './inbound/priority-grant.controller.js';
