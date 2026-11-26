// ops-svc 팬 조회 원천 시작 조립(F-06-5). 원천 서비스 내부 읽기 경로는 합성 때 맞춘다(계획 §9).
// staging·prod는 네 원천 주소가 없으면 변수 이름을 말하며 던진다. local·ci·demo는 비어 있으면 undefined다.
import { randomUUID } from 'node:crypto';
import type { AdminDataAccessRow, AdminDataAccessStore, FanLookupWiring } from './modules/fan-lookup/index.js';

const REQUIRED_IN = new Set(['staging', 'prod', 'production']);
const value = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

class MemoryAccess implements AdminDataAccessStore {
  readonly stored: AdminDataAccessRow[] = [];
  async append(row: AdminDataAccessRow): Promise<void> {
    this.stored.push(row);
  }
}

/** 아직 실제 원천 경로가 없는 단계의 자리. 부르면 503으로 이어진다 */
const unconfigured = (what: string) => ({ async list(): Promise<never> { throw new Error(`${what} 원천을 아직 연결하지 않았다`); } });
const unconfiguredProfile = {
  async get(): Promise<undefined> { return undefined; },
  async resolve(): Promise<undefined> { return undefined; },
};

export type FanLookupPorts = FanLookupWiring & { close(): void };

export function fanLookupPortsFromEnv(env: Record<string, string | undefined>): FanLookupPorts {
  const peaketEnv = value(env, 'PEAKET_ENV') ?? 'local';
  const names = ['PEAKET_IDENTITY_HTTP_URL', 'PEAKET_PURCHASE_HTTP_URL', 'PEAKET_TICKET_HTTP_URL', 'PEAKET_QUEUE_HTTP_URL'] as const;
  if (REQUIRED_IN.has(peaketEnv)) for (const name of names) if (!value(env, name)) throw new Error(`${name}이 없다(${peaketEnv}에서 팬 조회 원천을 읽어야 시작한다)`);
  const any = names.some((n) => value(env, n));
  if (!any) return { close() {} };
  const access = new MemoryAccess();
  return {
    profile: unconfiguredProfile,
    orders: { ...unconfigured('주문'), async unmask() { return { error: 'not-found' as const }; } },
    tickets: unconfigured('티켓'),
    transfers: unconfigured('양도'),
    queueEntries: { async list() { return { items: [], nextCursor: null }; } },
    access,
    now: () => Date.now(),
    close() {},
  };
}
