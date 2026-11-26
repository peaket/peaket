// F-06-4 구현 리뷰 IR-05: HOLDER 사본 비우기가 메모리 저장소·시험 대역에만 있지 않은지
// 운영 Redis 저장소와 gRPC 경계에서 사유 범주·잠금·우선 구매·이의 창·제한 끝을 저장/반환하지 않는지 본다.
import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import { describe, expect, test } from 'vitest';
import { RedisFraudAppealViewStore, supportGrpcHandlers } from '../src/modules/support/index.js';
import type { FraudAppealViewRow } from '../src/modules/support/index.js';

const accountId = '0194f064-0000-7000-8000-000000000021';
const caseId = '0194f064-0000-7000-8000-000000000121';
const eventId = '0194f064-0000-7000-8000-000000000321';

const holder = (): FraudAppealViewRow => ({
  accountId,
  caseId,
  eventId,
  party: 'HOLDER',
  reasonCategories: ['MACRO_BOT'],
  dueAtMs: Date.parse('2026-11-28T01:00:00.000Z'),
  heldTicketIds: ['0194f064-0000-7000-8000-000000000221'],
  excludedTicketIds: [],
  lockedTicketIds: ['0194f064-0000-7000-8000-000000000222'],
  state: 'OPEN',
  version: 1,
  objectionDueAtMs: Date.parse('2026-12-20T01:00:00.000Z'),
  objectionStatus: 'SUBMITTED',
  objectionNote: '이의합니다',
  cancelledTicketIds: ['0194f064-0000-7000-8000-000000000223'],
  restrictedUntilMs: Date.parse('2027-11-26T01:00:00.000Z'),
  lockExpiresAtMs: Date.parse('2026-12-10T01:00:00.000Z'),
  lockActive: true,
  priorityPurchases: [{ grantId: '0194f064-0000-7000-8000-000000000224', seatLabel: 'A-1', price: 1000, expiresAtMs: Date.parse('2026-11-30T01:00:00.000Z'), status: 'OFFERED' }],
  actionResult: { cancelledTicketIds: ['x'], restrictedUntil: null },
});

const fakeRedis = () => {
  const hashes = new Map<string, Map<string, string>>();
  const command = async (args: string[]): Promise<unknown> => {
    const [op, key, field, value] = args;
    if (op === 'EVAL') {
      const h = hashes.get(args[3]!) ?? new Map<string, string>();
      h.set(args[4]!, args[6]!);
      hashes.set(args[3]!, h);
      return 1;
    }
    if (op === 'HSET') {
      const h = hashes.get(key!) ?? new Map<string, string>();
      h.set(field!, value!);
      hashes.set(key!, h);
      return 1;
    }
    if (op === 'HGET') return hashes.get(key!)?.get(field!) ?? null;
    if (op === 'HVALS') return [...(hashes.get(key!)?.values() ?? [])];
    return null;
  };
  return { command };
};

describe('IR-05 HOLDER 사본 비우기', () => {
  test('운영 Redis 저장소는 HOLDER의 사유 범주·잠금·우선 구매·이의 창·제한 끝을 저장하지 않는다', async () => {
    const store = new RedisFraudAppealViewStore(fakeRedis());
    await store.apply(holder());
    expect(await store.get(accountId, caseId)).toMatchObject({
      party: 'HOLDER',
      heldTicketIds: ['0194f064-0000-7000-8000-000000000221'],
      reasonCategories: [],
      lockedTicketIds: [],
      priorityPurchases: [],
      objectionDueAtMs: null,
      objectionStatus: 'NONE',
      objectionNote: null,
      restrictedUntilMs: null,
      lockExpiresAtMs: null,
      lockActive: false,
      actionResult: null,
    });
  });

  test('gRPC 경계는 HOLDER 요청을 비운 뒤 저장소에 넘긴다', async () => {
    let applied: FraudAppealViewRow | undefined;
    const handlers = supportGrpcHandlers({
      restrictionViews: { apply: async () => ({ changed: true }), get: async () => undefined, list: async () => [], clear: async () => undefined },
      fraudViews: {
        apply: async (i) => { applied = i; return { changed: true }; },
        get: async () => undefined,
        list: async () => [],
        clear: async () => undefined,
      },
    });
    const md = new grpc.Metadata();
    md.set('x-peaket-caller', 'ops-svc');
    const req = {
      account_id: accountId,
      case_id: caseId,
      event_id: eventId,
      party: 'HOLDER',
      reason_categories: ['MACRO_BOT'],
      due_at: { seconds: Math.floor(Date.parse('2026-11-28T01:00:00.000Z') / 1000), nanos: 0 },
      held_ticket_ids: ['0194f064-0000-7000-8000-000000000221'],
      locked_ticket_ids: ['0194f064-0000-7000-8000-000000000222'],
      priority_purchases: [{ grant_id: '0194f064-0000-7000-8000-000000000224', seat_label: 'A-1', price: 1000, expires_at: { seconds: 1, nanos: 0 }, status: 'OFFERED' }],
      objection_due_at: { seconds: Math.floor(Date.parse('2026-12-20T01:00:00.000Z') / 1000), nanos: 0 },
      restricted_until: { seconds: Math.floor(Date.parse('2027-11-26T01:00:00.000Z') / 1000), nanos: 0 },
      lock_expires_at: { seconds: Math.floor(Date.parse('2026-12-10T01:00:00.000Z') / 1000), nanos: 0 },
      lock_active: true,
      state: 'FRAUD_APPEAL_VIEW_STATE_OPEN',
      version: 1,
    };
    await new Promise<void>((resolve, reject) => {
      const handler = handlers.SetFraudAppealView as unknown as (c: unknown, cb: (e: unknown) => void) => void;
      handler({ request: req, metadata: md }, (e) => (e ? reject(e) : resolve()));
    });
    expect(applied).toMatchObject({
      party: 'HOLDER',
      reasonCategories: [],
      lockedTicketIds: [],
      priorityPurchases: [],
      objectionDueAtMs: null,
      restrictedUntilMs: null,
      lockExpiresAtMs: null,
      lockActive: false,
      actionResult: null,
    });
  });

  test('IR-14 Redis 사본 apply는 읽기-쓰기를 한 원자 명령(EVAL)으로 한다', async () => {
    const commands: string[][] = [];
    const redis = {
      async command(args: string[]) {
        commands.push(args);
        if (args[0] === 'EVAL') return 1;
        return null;
      },
    };
    const store = new RedisFraudAppealViewStore(redis);
    await expect(store.apply({ ...holder(), party: 'PAYER', state: 'OPEN', version: 2 })).resolves.toEqual({ changed: true });
    expect(commands).toHaveLength(1);
    expect(commands[0]![0]).toBe('EVAL');
  });
});
