// 검증 묶음 내보내기 HTTP 경계(BAT-360 OPS-280, ADR-0348 결정 8, control-tower §14 C-T39, openapi createOpsAuditVerificationBundle).
// 정본 값: commander만(viewer·operator 403), 본문 {seq, reason}·사유 1~2,000자(꼴이 틀리면 400), seq가 구간 밖이면 422 seq-not-in-checkpoint,
// 서명 전·내부(EXECUTION)·옛 행은 409 checkpoint-not-ready, 내보내기는 감사 기록 AUDIT_BUNDLE_EXPORTED(seq·사유)로 남고 그 기록을 남기지 못하면 묶음을 주지 않는다.
// 받은 묶음은 이 시험이 피켓 코드 없이 따로 확인한다: 기록 해시 = SHA-256(UTF-8(prevHash 16진) ‖ UTF-8(recordJson)) → 잎(결정 2) → 포함 증명(RFC 9162 §2.1.3.2)
// → 체크포인트 JSON의 merkleRoot → ECDSA P-256 서명 → 증명 파일의 대상 해시(bundle.ts 머리 주석 = 묶음 꼴 정본 자리).
import 'reflect-metadata';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  AuditCheckpointPublisher,
  MemoryAuditChain,
  MemoryAuditPublicStore,
  MemoryAuditPublishStore,
  MemoryOpenTimestampsCalendar,
  ephemeralCheckpointSigner,
  type AuditRecord,
} from '../src/modules/audit/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-24T11:20:00.000+09:00');
const sha = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

interface Bundle {
  version: number;
  checkpoint: { no: number; checkpointId: string; json: string; checkpointHash: string; signature: string; keyId: string; signatureAlg: string; publicKeyPem: string; otsProof: string | null };
  record: { seq: number; recordJson: string; prevHash: string; recordSha256: string; leafSalt: string };
  inclusionProof: { leafIndex: number; treeSize: number; path: string[] };
}

/** 피켓 코드 없이 묶음을 확인한다. 어디서 어긋났는지 돌려준다 */
function checkBundle(b: Bundle): 'ok' | 'record' | 'inclusion' | 'signature' | 'ots' {
  if (sha(Buffer.from(b.record.prevHash, 'utf8'), Buffer.from(b.record.recordJson, 'utf8')).toString('hex') !== b.record.recordSha256) return 'record';
  const seq = Buffer.alloc(8);
  seq.writeBigUInt64BE(BigInt(b.record.seq));
  let r = sha(Buffer.from([0x00]), Buffer.from('PEAKET-audit-leaf-v1', 'ascii'), seq, Buffer.from(b.record.recordSha256, 'hex'), Buffer.from(b.record.leafSalt, 'hex'));
  // RFC 9162 §2.1.3.2
  let fn = b.inclusionProof.leafIndex;
  let sn = b.inclusionProof.treeSize - 1;
  for (const hex of b.inclusionProof.path) {
    const p = Buffer.from(hex, 'hex');
    if (sn === 0) return 'inclusion';
    if (fn % 2 === 1 || fn === sn) {
      r = sha(Buffer.from([0x01]), p, r);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else r = sha(Buffer.from([0x01]), r, p);
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  const body = JSON.parse(b.checkpoint.json) as { merkleRoot: string; firstSeq: number; leafCount: number };
  if (sn !== 0 || r.toString('hex') !== body.merkleRoot || b.inclusionProof.leafIndex !== b.record.seq - body.firstSeq || b.inclusionProof.treeSize !== body.leafCount) return 'inclusion';
  if (!verify('sha256', Buffer.from(b.checkpoint.json, 'utf8'), { key: createPublicKey(b.checkpoint.publicKeyPem), dsaEncoding: 'der' }, Buffer.from(b.checkpoint.signature, 'base64'))) return 'signature';
  if (sha(Buffer.from(b.checkpoint.json, 'utf8')).toString('hex') !== b.checkpoint.checkpointHash) return 'signature';
  if (b.checkpoint.otsProof === null || Buffer.from(b.checkpoint.otsProof, 'base64').subarray(33, 65).toString('hex') !== b.checkpoint.checkpointHash) return 'ots';
  return 'ok';
}

/** append가 AUDIT_BUNDLE_EXPORTED에서만 실패할 수 있는 체인(감사 저장소 장애 흉내, AuditChain 포트 구현) */
class FlakyChain extends MemoryAuditChain {
  failExport = false;
  override async append(input: AuditRecord): Promise<void> {
    if (this.failExport && input.recordType === 'AUDIT_BUNDLE_EXPORTED') throw new Error('audit store down');
    return super.append(input);
  }
}

describe('C-T39 검증 묶음으로 기록 하나 확인(ADR-0348 결정 8)', () => {
  const identity = new FakeIdentity();
  const chain = new FlakyChain();
  const store = new MemoryAuditPublishStore();
  const pub = new MemoryAuditPublicStore('public');
  let svc: Awaited<ReturnType<typeof createService>>;
  let published: { checkpointId: string; fromSeq: number; toSeq: number };
  let unsigned: { checkpointId: string; fromSeq: number };

  const bundle = (checkpointId: string, body: unknown, who: Record<string, string>) =>
    svc.http.inject({ method: 'POST', url: `/v1/ops/audit-checkpoints/${checkpointId}/verification-bundles`, headers: { ...who, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  const exported = () => chain.entries.filter((e) => e.recordType === 'AUDIT_BUNDLE_EXPORTED');

  beforeAll(async () => {
    svc = await createService({
      name: 'ops-svc-bundle',
      module: AppModule.register({ memory: true, nowMs: NOW, auditCheckpoints: store, auditChain: chain }),
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: NOW }),
      logDestination: quiet(),
      adminAuthz: identity,
    });
    // 기록 8개(seq 1~8)를 둔 뒤 수동 체크포인트 1번을 만들고 게시 작업으로 서명·게시한다
    for (let i = 0; i < 8; i += 1) await chain.append({ recordType: 'COMMAND_CREATED', recordId: crypto.randomUUID(), payload: { reason: `묶음 기록 ${i}`, i }, nowMs: NOW - 60_000 + i });
    const created = await svc.http.inject({ method: 'POST', url: '/v1/ops/audit-checkpoints', headers: { ...identity.ops('commander'), 'content-type': 'application/json' }, payload: JSON.stringify({ reason: '묶음 시험' }) });
    published = JSON.parse(created.payload) as typeof published;
    // 일 체크포인트가 이미 지난 낮이라 이 실행은 수동 체크포인트 뒤 기록(AUDIT_CHECKPOINT_CREATED)을 덮는 일 체크포인트도 만들어 서명한다
    await new AuditCheckpointPublisher({ store, chain, signer: ephemeralCheckpointSigner('bundle-key-5'), calendars: [new MemoryOpenTimestampsCalendar()], targets: [pub, new MemoryAuditPublicStore('anchor')] }).run(NOW);
    // 서명 전 행: 기록을 더하고 수동 체크포인트를 하나 더 만든다(게시 작업을 다시 돌리지 않는다)
    await chain.append({ recordType: 'COMMAND_CREATED', recordId: crypto.randomUUID(), payload: { reason: '서명 전' }, nowMs: NOW + 1 });
    const second = await svc.http.inject({ method: 'POST', url: '/v1/ops/audit-checkpoints', headers: { ...identity.ops('commander'), 'content-type': 'application/json' }, payload: JSON.stringify({ reason: '서명 전 체크포인트' }) });
    unsigned = JSON.parse(second.payload) as typeof unsigned;
  });
  afterAll(async () => {
    await svc?.close();
  });

  test('C-T39 commander가 받은 묶음은 기록 8개 트리의 첫·가운데·끝 잎마다 피켓 코드 없이 통과하고, 내보내기는 seq·사유와 함께 감사 기록에 하나씩 남는다', async () => {
    expect(published).toMatchObject({ fromSeq: 1, toSeq: 8 });
    const before = exported().length;
    for (const seq of [1, 4, 8]) {
      const res = await bundle(published.checkpointId, { seq, reason: `분쟁 대응 ${seq}` }, identity.ops('commander'));
      expect(res.statusCode).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const b = JSON.parse(res.payload) as Bundle;
      expect(b).toMatchObject({ version: 1, checkpoint: { no: 1, checkpointId: published.checkpointId, keyId: 'bundle-key-5', signatureAlg: 'ECDSA_P256_SHA256' }, record: { seq }, inclusionProof: { leafIndex: seq - 1, treeSize: 8 } });
      expect(b.inclusionProof.path).toHaveLength(3);
      expect(checkBundle(b)).toBe('ok');
      // 묶음의 체크포인트 JSON은 공개 파일과 같은 바이트다
      expect(b.checkpoint.json).toBe(pub.objects.get('transparency/v1/checkpoints/0000000001.json')!.toString('utf8'));
    }
    const rows = exported().slice(before);
    expect(rows.map((e) => e.record!.payload)).toEqual([1, 4, 8].map((seq) => expect.objectContaining({ checkpointId: published.checkpointId, no: 1, seq, reason: `분쟁 대응 ${seq}` })));
  });

  test('C-T39 기록 정규화 값의 한 글자를 바꾸거나 다른 기록의 잎 솔트를 넣으면 확인이 실패한다', async () => {
    const res = await bundle(published.checkpointId, { seq: 5, reason: '변조 시험' }, identity.ops('commander'));
    const b = JSON.parse(res.payload) as Bundle;
    expect(checkBundle(b)).toBe('ok');
    const i = b.record.recordJson.indexOf('묶음 기록 4');
    expect(i).toBeGreaterThan(0);
    const oneChar = { ...b, record: { ...b.record, recordJson: `${b.record.recordJson.slice(0, i)}묶음 기록 9${b.record.recordJson.slice(i + '묶음 기록 4'.length)}` } };
    expect(checkBundle(oneChar)).toBe('record');
    // 기록 해시까지 다시 맞춰도 포함 증명이 실패한다
    const rehashed = { ...oneChar, record: { ...oneChar.record, recordSha256: sha(Buffer.from(oneChar.record.prevHash, 'utf8'), Buffer.from(oneChar.record.recordJson, 'utf8')).toString('hex') } };
    expect(checkBundle(rehashed)).toBe('inclusion');
    const other = JSON.parse((await bundle(published.checkpointId, { seq: 2, reason: '다른 솔트' }, identity.ops('commander'))).payload) as Bundle;
    expect(other.record.leafSalt).not.toBe(b.record.leafSalt);
    expect(checkBundle({ ...b, record: { ...b.record, leafSalt: other.record.leafSalt } })).toBe('inclusion');
  });

  test('C-T39 viewer·operator는 403이고 감사 기록이 남지 않는다(잎 솔트가 실리는 외부 제공 자료)', async () => {
    const before = exported().length;
    for (const role of ['viewer', 'operator'] as const) {
      const res = await bundle(published.checkpointId, { seq: 1, reason: '권한 시험' }, identity.ops(role));
      expect(res.statusCode).toBe(403);
      expect(res.payload).not.toContain('leafSalt');
    }
    expect(exported().length).toBe(before);
  });

  test('B10 사유 없음·빈 사유·2,001자·양방향 제어 문자는 400, 2,000자는 받는다. 구간 밖 seq는 422, 서명 전 행은 409, 없는 체크포인트는 404', async () => {
    const commander = identity.ops('commander');
    const before = exported().length;
    expect((await bundle(published.checkpointId, { seq: 1 }, commander)).statusCode).toBe(400);
    expect((await bundle(published.checkpointId, { seq: 1, reason: '' }, commander)).statusCode).toBe(400);
    expect((await bundle(published.checkpointId, { seq: 1, reason: '가'.repeat(2001) }, commander)).statusCode).toBe(400);
    expect((await bundle(published.checkpointId, { seq: 1, reason: '사유‮뒤집기' }, commander)).statusCode).toBe(400);
    expect((await bundle(published.checkpointId, { seq: 1, reason: '사유', extra: 1 }, commander)).statusCode).toBe(400);
    expect(exported().length).toBe(before);
    expect((await bundle(published.checkpointId, { seq: 1, reason: '가'.repeat(2000) }, commander)).statusCode).toBe(201);
    for (const seq of [0, published.toSeq + 1]) {
      const r = await bundle(published.checkpointId, { seq, reason: '구간 밖' }, commander);
      if (seq === 0) expect(r.statusCode).toBe(400);
      else {
        expect(r.statusCode).toBe(422);
        expect(JSON.parse(r.payload).type).toMatch(/seq-not-in-checkpoint$/);
      }
    }
    const notReady = await bundle(unsigned.checkpointId, { seq: unsigned.fromSeq, reason: '서명 전' }, commander);
    expect(notReady.statusCode).toBe(409);
    expect(JSON.parse(notReady.payload).type).toMatch(/checkpoint-not-ready$/);
    expect((await bundle(crypto.randomUUID(), { seq: 1, reason: '없음' }, commander)).statusCode).toBe(404);
    expect(exported().length).toBe(before + 1);
  });

  test('B10 내보내기 감사 기록을 남기지 못하면 묶음(잎 솔트)을 주지 않는다', async () => {
    chain.failExport = true;
    try {
      const res = await bundle(published.checkpointId, { seq: 3, reason: '감사 저장 장애' }, identity.ops('commander'));
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.payload).not.toContain('leafSalt');
      expect(res.payload).not.toContain('recordJson');
    } finally {
      chain.failExport = false;
    }
  });
});
