// 감사 체크포인트 공개 앵커·Ed25519 서명(BAT-465 R-584) 시험.
// 서명이 체크포인트 값과 맞는지, 값이 바뀌면 서명 검증이 실패하는지, 공개 경로가 세션 없이 앵커와 검증을 주는지 본다.
import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  AuditCheckpointService,
  Ed25519AuditAnchorSigner,
  Ed25519AuditAnchorVerifier,
  MemoryAuditChain,
  MemoryAuditCheckpointStore,
  auditAnchorMessage,
  auditAnchorSignerFromEnv,
  ephemeralAuditAnchorSigner,
} from '../src/modules/audit/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-14T09:00:00.000Z');
const identity = new FakeIdentity();

const fixture = (signer = ephemeralAuditAnchorSigner('test-key')) => {
  const chain = new MemoryAuditChain();
  const store = new MemoryAuditCheckpointStore();
  const service = new AuditCheckpointService(store, chain, () => NOW, signer);
  return { chain, store, service, signer };
};

describe('BAT-465 감사 체크포인트 공개 앵커·서명', () => {
  test('R584_체크포인트는_Ed25519_서명과_앵커_참조를_남기고_검증이_통과한다', async () => {
    const f = fixture();
    await f.chain.append({ recordType: 'COMMAND_CREATED', recordId: crypto.randomUUID(), payload: { a: 1 }, nowMs: NOW });
    const cp = await f.service.create({ reason: '점검', actorRef: 'ops-1' });
    expect(cp.signature).toBeTruthy();
    expect(cp.keyId).toBe('test-key');
    expect(cp.anchorRef).toBe(`local:${cp.checkpointId}`);
    expect(cp.anchoredAtMs).toBe(NOW);
    expect(f.signer.verify({ ...cp, createdAtMs: cp.createdAtMs }, cp.signature!)).toBe(true);
    expect(await f.service.verify(cp.checkpointId)).toMatchObject({ valid: true, rootValid: true, prevValid: true, signatureValid: true, anchorValid: true });
  });

  test('R584_루트가_바뀌면_서명_검증이_실패한다', async () => {
    const f = fixture();
    await f.chain.append({ recordType: 'COMMAND_CREATED', recordId: crypto.randomUUID(), payload: { a: 1 }, nowMs: NOW });
    const cp = await f.service.create({ reason: '점검', actorRef: 'ops-1' });
    const tampered = { ...cp, rootHash: '0'.repeat(64) };
    expect(f.signer.verify(tampered, cp.signature!)).toBe(false);
    expect(auditAnchorMessage(tampered).toString('utf8')).toContain(tampered.rootHash);
  });

  test('R584_환경_값_서명기는_운영에서_키가_없으면_시작하지_않고_local은_임시_키를_쓴다', () => {
    expect(() => auditAnchorSignerFromEnv({ PEAKET_ENV: 'prod' })).toThrow(/PEAKET_AUDIT_ANCHOR_PRIVATE_KEY/);
    const local = auditAnchorSignerFromEnv({ PEAKET_ENV: 'local' });
    expect(local.warning).toBeTruthy();
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const fromPem = auditAnchorSignerFromEnv({ PEAKET_ENV: 'prod', PEAKET_AUDIT_ANCHOR_PRIVATE_KEY: pem, PEAKET_AUDIT_ANCHOR_KEY_ID: 'k1' });
    expect(fromPem.warning).toBeUndefined();
    expect(fromPem.signer).toBeInstanceOf(Ed25519AuditAnchorSigner);
    expect(fromPem.signer.keyId).toBe('k1');
    expect(fromPem.signer.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });
});

describe('BAT-465 공개 앵커 HTTP', () => {
  let svc: Awaited<ReturnType<typeof createService>>;
  const signer = ephemeralAuditAnchorSigner('http-key');
  beforeAll(async () => {
    svc = await createService({
      name: 'ops-svc-anchor',
      module: AppModule.register({ memory: true, nowMs: NOW, signer }),
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: NOW }),
      logDestination: quiet(),
      adminAuthz: identity,
    });
  });
  afterAll(async () => {
    await svc?.close();
  });

  test('R584_공개_앵커와_검증은_세션_없이_읽고_공개키로_확인한다', async () => {
    const commander = identity.ops('commander');
    const operator = identity.ops('operator');
    // 체크포인트가 묶을 감사 기록을 하나 만든다(명령 접수·실행).
    const seeded = await svc.http.inject({
      method: 'POST',
      url: '/v1/ops/commands',
      headers: { ...operator, 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'SCALE_CHANGE', reason: '공개 앵커 씨앗', params: { eventId: crypto.randomUUID(), scale: 'LARGE' } }),
    });
    expect(seeded.statusCode).toBe(201);
    const created = await svc.http.inject({ method: 'POST', url: '/v1/ops/audit-checkpoints', headers: { ...commander, 'content-type': 'application/json' }, payload: JSON.stringify({ reason: '공개 앵커 점검' }) });
    expect(created.statusCode).toBe(201);
    const cp = JSON.parse(created.payload) as { checkpointId: string; rootHash: string; signature: string | null; keyId: string | null; anchorRef: string | null };
    expect(cp.signature).toBeTruthy();
    expect(cp.keyId).toBe('http-key');
    const anchor = await svc.http.inject({ method: 'GET', url: `/v1/ops/audit-anchors/${cp.checkpointId}` });
    expect(anchor.statusCode).toBe(200);
    const body = JSON.parse(anchor.payload) as { fromSeq: number; toSeq: number; rootHash: string; prevCheckpointHash: string; createdAt: string; signature: string; algorithm: string; publicKey: string };
    expect(body).toMatchObject({ rootHash: cp.rootHash, signature: cp.signature, algorithm: 'Ed25519' });
    expect(body.publicKey).toContain('BEGIN PUBLIC KEY');
    // 공개키만으로 서명을 확인한다(감사자 쪽 절차)
    const verified = new Ed25519AuditAnchorVerifier(body.publicKey, 'http-key');
    expect(
      verified.verify(
        { checkpointId: cp.checkpointId, fromSeq: body.fromSeq, toSeq: body.toSeq, rootHash: body.rootHash, prevCheckpointHash: body.prevCheckpointHash, createdAtMs: Date.parse(body.createdAt) },
        body.signature,
      ),
    ).toBe(true);
    const check = await svc.http.inject({ method: 'GET', url: `/v1/ops/audit-anchors/${cp.checkpointId}/verification` });
    expect(check.statusCode).toBe(200);
    expect(JSON.parse(check.payload)).toMatchObject({ valid: true, signatureValid: true, anchorValid: true });
  });

  test('R584_없는_앵커는_404다', async () => {
    const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/audit-anchors/${crypto.randomUUID()}` });
    expect(r.statusCode).toBe(404);
  });
});
