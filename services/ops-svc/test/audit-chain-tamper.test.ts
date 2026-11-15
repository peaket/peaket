// B3-H03·OPS-04 감사 체인 검증 계약(R-614, control-tower §7, ADR-0075, ops 0012).
// 저장된 해시만 다시 모으면 원본 행 변조를 잡지 못한다. 체인 항목은 정규화 기록(record_json)과 직전 해시를
// 함께 남기고, 검증은 기록으로 해시를 다시 계산하며 경계까지 연쇄를 확인해야 한다.
// 체크포인트는 저장소가 createWithAudit를 제공하면 그 포트로만 쓰고, 실패하면 행·체인 기록 모두 롤백한다.
import { describe, expect, test } from 'vitest';
import {
  AuditCheckpointService,
  MemoryAuditChain,
  MemoryAuditCheckpointStore,
  auditHash,
  ephemeralAuditAnchorSigner,
  type AuditCheckpointStore,
  type AuditRecord,
} from '../src/modules/audit/index.js';
import * as auditModule from '../src/modules/audit/audit.js';
import * as checkpointModule from '../src/modules/audit/checkpoint.js';

const NOW = Date.parse('2026-11-14T09:00:00.000Z');
const ID1 = '0193b000-0000-7000-8000-000000000001';
const ID2 = '0193b000-0000-7000-8000-000000000002';
const RECORD1: AuditRecord = { recordType: 'A', recordId: ID1, payload: { b: 'x', a: 1 }, nowMs: NOW };
const RECORD2: AuditRecord = { recordType: 'B', recordId: ID2, payload: { n: 2 }, nowMs: NOW + 1 };

const fixture = () => {
  const chain = new MemoryAuditChain();
  const store = new MemoryAuditCheckpointStore();
  const service = new AuditCheckpointService(store, chain, () => NOW, ephemeralAuditAnchorSigner('test-key'));
  return { chain, store, service };
};

describe('B3-H03 감사 체인 원본 기록 검증', () => {
  test('체인 항목은 정규화 기록과 직전 해시를 남기고 같은 값으로 해시를 다시 계산한다', async () => {
    const chain = new MemoryAuditChain();
    await chain.append(RECORD1);
    await chain.append(RECORD2);
    const [first, second] = chain.entries;
    expect(first!.record).toEqual(RECORD1);
    expect(first!.prevHash).toBe('');
    expect(second!.record).toEqual(RECORD2);
    expect(second!.prevHash).toBe(first!.hash);
    expect(auditHash(second!.prevHash, second!.record)).toBe(second!.hash);

    // 정규화 JSON은 키 순서가 고정돼 저장·재계산이 같은 문자열을 만든다.
    expect(auditModule.canonicalAuditRecord(RECORD1)).toBe(
      '{"at":"2026-11-14T09:00:00.000Z","payload":{"a":1,"b":"x"},"recordId":"0193b000-0000-7000-8000-000000000001","recordType":"A"}',
    );
    const roundTrip = checkpointModule.auditRecordFromJson(JSON.parse(auditModule.canonicalAuditRecord(RECORD1)));
    expect(roundTrip).toEqual(RECORD1);
    expect(auditHash('', roundTrip!)).toBe(auditHash('', RECORD1));
  });

  test('원본 기록(record_json)을 바꾸면 체크포인트 검증이 실패한다', async () => {
    const f = fixture();
    await f.chain.append(RECORD1);
    await f.chain.append(RECORD2);
    const cp = await f.service.create({ reason: '원본 변조 시험', actorRef: 'ops-1' });
    expect(await f.service.verify(cp.checkpointId)).toMatchObject({ valid: true, rootValid: true });

    const entry = f.chain.entries[1] as { record?: AuditRecord };
    if (!entry.record) throw new Error('체인 항목에 정규화 기록(record_json)이 없다');
    entry.record.payload.n = 999;
    // 저장된 record_sha256은 그대로여도 원본 기록으로 다시 계산한 해시가 달라 검증은 실패해야 한다.
    expect(await f.service.verify(cp.checkpointId)).toMatchObject({ valid: false, rootValid: false });
  });

  test('직전 해시 연쇄가 끊기면 체크포인트 검증이 실패한다', async () => {
    const f = fixture();
    await f.chain.append(RECORD1);
    await f.chain.append(RECORD2);
    const cp = await f.service.create({ reason: '연쇄 시험', actorRef: 'ops-1' });
    (f.chain.entries[1] as { prevHash: string }).prevHash = 'f'.repeat(64);
    expect(await f.service.verify(cp.checkpointId)).toMatchObject({ valid: false, rootValid: false });
  });

  test('record_json이 없는 0012 이전 행은 검증이 실패한다', async () => {
    const f = fixture();
    await f.chain.append(RECORD1);
    const cp = await f.service.create({ reason: '옛 행 시험', actorRef: 'ops-1' });
    (f.chain.entries[0] as { record?: AuditRecord }).record = undefined;
    expect(await f.service.verify(cp.checkpointId)).toMatchObject({ valid: false, rootValid: false });
  });
});

describe('OPS-04 체크포인트 원자성 포트', () => {
  const storeWith = (over: { create?: AuditCheckpointStore['create']; createWithAudit?: AuditCheckpointStore['createWithAudit'] }) => {
    const base = new MemoryAuditCheckpointStore();
    const store: AuditCheckpointStore = {
      create: over.create ?? ((input) => base.create(input)),
      list: (limit) => base.list(limit),
      find: (checkpointId) => base.find(checkpointId),
      head: () => base.head(),
      findPrevious: (fromSeq) => base.findPrevious(fromSeq),
      ...(over.createWithAudit ? { createWithAudit: over.createWithAudit } : {}),
    };
    return { base, store };
  };

  test('createWithAudit가 있으면 체크포인트 행과 체인 기록을 그 포트 하나로만 쓴다', async () => {
    const chain = new MemoryAuditChain();
    await chain.append(RECORD1);
    const seen: AuditRecord[] = [];
    let atomicCalls = 0;
    const { base, store } = storeWith({
      create: async () => {
        throw new Error('createWithAudit가 있는데 비원자 create를 불렀다');
      },
      createWithAudit: async (input, record) => {
        atomicCalls += 1;
        seen.push(record);
        const cp = await base.create(input);
        await chain.append(record);
        return cp;
      },
    });
    const service = new AuditCheckpointService(store, chain, () => NOW, ephemeralAuditAnchorSigner('k'));
    const cp = await service.create({ reason: '원자 시험', actorRef: 'ops-1' });

    expect(atomicCalls).toBe(1);
    expect(seen.map((r) => r.recordType)).toEqual(['AUDIT_CHECKPOINT_CREATED']);
    expect(seen[0]!.payload).toMatchObject({
      fromSeq: 1,
      toSeq: 1,
      rootHash: cp.rootHash,
      prevCheckpointHash: '',
      anchorRef: `local:${cp.checkpointId}`,
      signature: cp.signature,
      keyId: 'k',
    });
    expect(base.entries).toHaveLength(1);
    expect(chain.entries.filter((e) => e.recordType === 'AUDIT_CHECKPOINT_CREATED')).toHaveLength(1);
  });

  test('createWithAudit가 실패하면 체크포인트 행도 체인 기록도 남지 않는다', async () => {
    const chain = new MemoryAuditChain();
    await chain.append(RECORD1);
    const { base, store } = storeWith({
      createWithAudit: async () => {
        throw new Error('injected audit failure');
      },
    });
    const service = new AuditCheckpointService(store, chain, () => NOW, ephemeralAuditAnchorSigner('k'));
    await expect(service.create({ reason: '롤백 시험', actorRef: 'ops-1' })).rejects.toThrow('injected audit failure');
    expect(base.entries).toHaveLength(0);
    expect(chain.entries.filter((e) => e.recordType === 'AUDIT_CHECKPOINT_CREATED')).toHaveLength(0);
  });
});
