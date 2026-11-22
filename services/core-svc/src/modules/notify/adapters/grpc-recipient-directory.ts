// BAT-455 identity-svc RecipientQueryService.BatchGetRecipients 클라이언트(docs/api/proto/peaket/identity/v1/identity.proto).
// 대량 발송 조각의 받는 사람을 500명까지 묻는다. 이 묶음은 낱건이라 한 명씩 부르지만 같은 계약을 쓴다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { hostPort } from '../../catalog/index.js';
import type { Recipient, RecipientDirectory } from '../domain/fan-notify-ports.js';

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const DEADLINE_MS = 500;
const STATUS: Record<string, Recipient['status']> = {
  RECIPIENT_STATUS_ACTIVE: 'ACTIVE',
  RECIPIENT_STATUS_WITHDRAWAL_PENDING: 'WITHDRAWAL_PENDING',
  RECIPIENT_STATUS_MERGED: 'MERGED',
  RECIPIENT_STATUS_DELETED: 'DELETED',
  RECIPIENT_STATUS_NOT_FOUND: 'NOT_FOUND',
};

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export class GrpcRecipientDirectory implements RecipientDirectory {
  readonly #client: grpc.Client & { BatchGetRecipients: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, unknown> } } }).peaket.identity.v1;
    const { host, port } = hostPort(address, 'PEAKET_IDENTITY_GRPC_URL');
    this.#client = createGrpcClient(pkg.RecipientQueryService as grpc.ServiceClientConstructor, { host, port, profile, dependency: 'identity-svc', timeoutCapMs: DEADLINE_MS }) as unknown as grpc.Client & {
      BatchGetRecipients: Unary;
    };
  }

  async getMany(accountIds: readonly string[], includeEmail: boolean): Promise<Recipient[]> {
    if (accountIds.length === 0) return [];
    if (accountIds.length > 500) throw new Error('받는 사람 묶음은 500명까지입니다');
    const v = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#client.BatchGetRecipients({ account_ids: accountIds, include_email: includeEmail }, new grpc.Metadata(), { deadline: Date.now() + DEADLINE_MS }, (e, res) =>
        e ? reject(new Error(`identity 받는 사람 조회 실패: ${grpc.status[e.code] ?? String(e.code)}`)) : resolve(res ?? {}),
      );
    });
    const rows = Array.isArray(v.recipients) ? (v.recipients as Record<string, unknown>[]) : [];
    return accountIds.map((accountId) => {
      const r = rows.find((x) => x.account_id === accountId);
      if (!r) return { accountId, status: 'NOT_FOUND', verified: false, locale: 'ko', ...(includeEmail ? { email: null } : {}) };
      return {
        accountId,
        status: STATUS[String(r.status)] ?? 'NOT_FOUND',
        verified: r.verified === true,
        locale: typeof r.locale === 'string' && r.locale ? r.locale : 'ko',
        ...(includeEmail ? { email: typeof r.email === 'string' && r.email ? r.email : null } : {}),
      };
    });
  }

  close(): void {
    this.#client.close();
  }
}

export const unavailableRecipients: RecipientDirectory = {
  getMany: async (ids) => ids.map((accountId) => ({ accountId, status: 'NOT_FOUND', verified: false, locale: 'ko', email: null })),
};
