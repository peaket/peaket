// 받는 층: TrustLabelService(trust.proto)의 모양을 유스케이스 입력으로 바꾸고, 응답·오류를 계약대로 돌려준다(docs/features/bot-defense.md §9 '첫 구현').
// 저장소가 끼는 규칙은 실제 Valkey 통합 시험(test-int/apply-label.int.test.ts)이 본다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { TrustError } from '../src/modules/scoring/application/trust-error.js';
import { labelEventKey, type LabelRequest, type LabelResult } from '../src/modules/scoring/domain/labels.js';
import { trustLabelServiceHandlers, trustPackage } from '../src/modules/scoring/inbound/trust.grpc.js';

const seen: LabelRequest[] = [];
let next: () => Promise<LabelResult> = async () => ({ changed: true, blockList: 'ADDED' });
let srv: { port: number; close(): Promise<void> };
type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;
let client: grpc.Client & { ApplyLabel: Unary };
const errors: unknown[] = [];

beforeAll(async () => {
  srv = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      {
        definition: trustPackage().TrustLabelService.service,
        handlers: trustLabelServiceHandlers(
          {
            run: (i) => {
              seen.push(i);
              return next();
            },
          },
          (_m, e) => void errors.push(e),
        ),
      },
    ],
  });
  const pkg = grpc.loadPackageDefinition(protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true })) as unknown as { peaket: { trust: { v1: { TrustLabelService: grpc.ServiceClientConstructor } } } };
  client = new pkg.peaket.trust.v1.TrustLabelService(`127.0.0.1:${srv.port}`, grpc.credentials.createInsecure()) as unknown as grpc.Client & { ApplyLabel: Unary };
});

afterAll(async () => {
  client.close();
  await srv.close();
});

const call = (req: object) =>
  new Promise<Record<string, unknown>>((res, rej) => {
    client.ApplyLabel(req, new grpc.Metadata(), { deadline: Date.now() + 2_000 }, (e, v) => (e ? rej(e) : res(v ?? {})));
  });

describe('ApplyLabel 받는 층', () => {
  test('B-T27③_계약의enum·칸을입력으로바꾼다_보내지않은enum은없음이고_계약에없는번호는UNKNOWN이다', async () => {
    seen.length = 0;
    const key = '0190f3a1-7c2e-7a00-8000-0000000000aa';
    await call({ source_ref: 'rev-1', source_version: 3, source: 'LABEL_SOURCE_SAMPLE_REVIEW', label: 'LABEL_HUMAN', event_id: 'ev-1', pid: 'pid-1', queue_entry_id: 'qe-1', acted_by: 'ops-1', review_batch: 'REVIEW_BATCH_SHADOW_CHALLENGED', applied_verdict: 'VERDICT_CHALLENGE', verdict_event_key: key });
    expect(seen[0]).toEqual({ sourceRef: 'rev-1', sourceVersion: 3, source: 'SAMPLE_REVIEW', label: 'HUMAN', eventId: 'ev-1', pid: 'pid-1', queueEntryId: 'qe-1', actedBy: 'ops-1', deviceRef: '', reviewBatch: 'SHADOW_CHALLENGED', appliedVerdict: 'CHALLENGE', verdictEventKey: key });
    await call({ source: 'LABEL_SOURCE_FRAUD_APPEAL_ACCEPTED', label: 'LABEL_BOT', device_ref: 'k1.x', applied_verdict: 'VERDICT_BLOCK' });
    expect(seen[1]).toMatchObject({ source: 'FRAUD_APPEAL_ACCEPTED', label: 'BOT', deviceRef: 'k1.x', sourceVersion: 0, reviewBatch: undefined, appliedVerdict: 'BLOCK', verdictEventKey: '' });
    await call({ source: 6, review_batch: 9, label: 'LABEL_UNSPECIFIED' });
    expect(seen[2]).toMatchObject({ source: 'UNKNOWN', reviewBatch: 'UNKNOWN', label: undefined });
  });

  test('응답은changed와block_list이고_결과종류를계약의이름으로싣는다', async () => {
    for (const blockList of ['NONE', 'ADDED', 'REMOVED', 'DEVICE_NOT_FOUND'] as const) {
      next = async () => ({ changed: blockList !== 'NONE', blockList });
      expect(await call({})).toEqual({ changed: blockList !== 'NONE', block_list: `BLOCK_LIST_CHANGE_${blockList}` });
    }
  });

  test('B-T27②③⑥_업무오류는상태코드로_예상못한오류는고정문구INTERNAL이다', async () => {
    for (const code of ['INVALID_ARGUMENT', 'ALREADY_EXISTS', 'UNAVAILABLE'] as const) {
      next = async () => {
        throw new TrustError(code, '고정 문구');
      };
      await expect(call({})).rejects.toMatchObject({ code: grpc.status[code], details: '고정 문구' });
    }
    next = async () => {
      throw new Error('pid-secret이 든 내부 문구');
    };
    await expect(call({})).rejects.toMatchObject({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
    expect(errors).toHaveLength(1);
  });
});

describe('라벨의 사건 키', () => {
  test('B-T27⑥_사건키는(건ID·pid·출처·판)으로정해져같은판은같고_하나라도다르면다르며_UUID판8모양이다', () => {
    const base = { sourceRef: 'rev-1', pid: 'pid-1', source: 'SAMPLE_REVIEW' as const, sourceVersion: 1 };
    const k = labelEventKey(base);
    expect(labelEventKey({ ...base })).toBe(k);
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const other of [{ sourceRef: 'rev-2' }, { pid: 'pid-2' }, { source: 'APPEAL_ACCEPTED' as const }, { sourceVersion: 2 }]) expect(labelEventKey({ ...base, ...other })).not.toBe(k);
  });
});
