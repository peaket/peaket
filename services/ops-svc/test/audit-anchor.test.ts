// 감사 공개 앵커: 서명한 머클 체크포인트의 게시 작업과 공개 읽기 경로(BAT-360 OPS-280, ADR-0348, ADR-0075, control-tower §7·§14 C-T38·C-T41).
// BAT-465의 Ed25519 API 서명은 ADR-0348 결정 4로 없앴다. 이 파일은 새 꼴을 본다:
//   API 프로세스는 서명 키가 없다(수동 체크포인트는 다음 작업 실행 전까지 서명 칸이 비어 있다, 결정 1).
//   게시 작업(AuditCheckpointPublisher, jobs/audit-anchor.ts의 한 실행)이 서명(ECDSA P-256, DER base64) → 대기 증명(OpenTimestamps) → 두 자리 게시를 한다(결정 4~6).
// 기대값은 정본 식으로 따로 만든다: 잎·루트(결정 2), 파일 자리 transparency/v1/checkpoints/<번호 10자리>.json·.sig·.ots(결정 6), 증명 파일 머리(결정 5, ots.ts 머리 주석 = 파일 꼴 정본 자리).
// 저장소·체인·게시 자리·캘린더는 제품 메모리 짝 가짜(MemoryAuditPublishStore·MemoryAuditChain·MemoryAuditPublicStore·MemoryOpenTimestampsCalendar, 각 포트 구현)다.
import 'reflect-metadata';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  AuditCheckpointPublisher,
  AuditCheckpointService,
  MemoryAuditChain,
  MemoryAuditCheckpointStore,
  MemoryAuditPublicStore,
  MemoryAuditPublishStore,
  MemoryOpenTimestampsCalendar,
  ephemeralCheckpointSigner,
  type AuditAnchorLog,
  type CheckpointSigner,
  type ClosedOnsaleSource,
} from '../src/modules/audit/index.js';
import { FakeIdentity, quiet } from './support.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 2026-11-24 00:10:00.000 KST(= 11-23 15:10 UTC). 일 체크포인트가 그날 처음 생길 수 있는 때(결정 9) */
const DAY1_DUE = Date.parse('2026-11-24T00:10:00.000+09:00');
const DAY2_DUE = Date.parse('2026-11-25T00:10:00.000+09:00');
const CAL_A = 'https://cal-a.audit-test.invalid';
const CAL_B = 'https://cal-b.audit-test.invalid';
const OTS_MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');

const sha = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
/** 정본 식(ADR-0348 결정 2)의 루트: 시험이 따로 계산한다 */
const expectedRoot = (entries: readonly { seq: number; hash: string; leafSalt?: string }[]): string => {
  const leaves = entries.map((e) => {
    const seq = Buffer.alloc(8);
    seq.writeBigUInt64BE(BigInt(e.seq));
    return sha(Buffer.from([0x00]), Buffer.from('PEAKET-audit-leaf-v1', 'ascii'), seq, Buffer.from(e.hash, 'hex'), Buffer.from(e.leafSalt!, 'hex'));
  });
  const mth = (l: readonly Buffer[]): Buffer => {
    if (l.length === 1) return l[0]!;
    let k = 1;
    while (k * 2 < l.length) k *= 2;
    return sha(Buffer.from([0x01]), mth(l.slice(0, k)), mth(l.slice(k)));
  };
  return mth(leaves).toString('hex');
};
const file = (no: number, ext: string): string => `transparency/v1/checkpoints/${String(no).padStart(10, '0')}.${ext}`;

async function appendRecords(chain: MemoryAuditChain, n: number, atMs: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await chain.append({ recordType: 'COMMAND_CREATED', recordId: crypto.randomUUID(), payload: { i, reason: `앵커 시험 ${i}` }, nowMs: atMs + i });
}

/** 게시 작업 한 벌. 시험마다 새로 만든다 */
function harness(o: { calendars?: MemoryOpenTimestampsCalendar[]; signer?: CheckpointSigner; closed?: ClosedOnsaleSource } = {}) {
  const chain = new MemoryAuditChain();
  const store = new MemoryAuditPublishStore();
  const pub = new MemoryAuditPublicStore('public');
  const anchor = new MemoryAuditPublicStore('anchor');
  const calendars = o.calendars ?? [new MemoryOpenTimestampsCalendar(CAL_A)];
  const signer = o.signer ?? ephemeralCheckpointSigner('anchor-test-key-7');
  const logs: { level: string; fields: Record<string, unknown> }[] = [];
  const log: AuditAnchorLog = (level, fields) => logs.push({ level, fields });
  const publisher = new AuditCheckpointPublisher({ store, chain, signer, calendars, targets: [pub, anchor], ...(o.closed ? { closed: o.closed } : {}), log });
  return { chain, store, pub, anchor, calendars, signer, logs, publisher };
}

/** 공개키 목록의 PEM으로 서명을 확인한다(밖의 확인자 절차) */
const verifyWithPublished = (target: MemoryAuditPublicStore, no: number): boolean => {
  const keys = JSON.parse(target.objects.get('transparency/v1/public-keys.json')!.toString('utf8')) as { keys: { publicKeyPem: string }[] };
  const json = target.objects.get(file(no, 'json'))!;
  const sig = Buffer.from(target.objects.get(file(no, 'sig'))!.toString('utf8'), 'base64');
  return keys.keys.some((k) => verify('sha256', json, { key: createPublicKey(k.publicKeyPem), dsaEncoding: 'der' }, sig));
};

describe('C-T38 ① 게시 작업 한 실행(ADR-0348 결정 1·4·5·6·11)', () => {
  test('C-T38 ① 일 체크포인트가 두 자리에 같은 JSON·서명·대기 증명을 남기고, 공개키로 확인되며 감사 체인에는 기록을 더하지 않는다', async () => {
    const h = harness();
    await appendRecords(h.chain, 5, DAY1_DUE - HOUR);
    const run = await h.publisher.run(DAY1_DUE);
    expect(run).toMatchObject({ created: [{ no: 1, kind: 'DAILY' }], signed: 1, stamped: 1, published: 1, mismatches: [], conflicts: [] });
    // 작업 역할은 체인을 쓰지 못한다: 작업이 만든 체크포인트는 체인 기록을 더하지 않는다(결정 11)
    expect(h.chain.entries).toHaveLength(5);
    const row = (await h.store.findByNo(1))!;
    expect(row).toMatchObject({ kind: 'DAILY', no: 1, fromSeq: 1, toSeq: 5, leafCount: 5, prevCheckpointHash: '', otsState: 'PENDING', publishedAtMs: DAY1_DUE });
    // 체크포인트 JSON: 저장한 바이트 그대로 게시하고, 루트는 정본 식으로 따로 계산한 값이다
    const body = JSON.parse(row.checkpointJson!) as Record<string, unknown>;
    expect(body).toEqual({ v: 'PEAKET-checkpoint-v1', no: 1, firstSeq: 1, lastSeq: 5, leafCount: 5, merkleRoot: expectedRoot(h.chain.entries), prevCheckpointHash: '', createdAt: '2026-11-23T15:10:00.000Z' });
    expect(row.checkpointHash).toBe(sha(Buffer.from(row.checkpointJson!, 'utf8')).toString('hex'));
    for (const ext of ['json', 'sig', 'ots']) {
      expect(h.pub.objects.get(file(1, ext))).toBeInstanceOf(Buffer);
      expect(h.pub.objects.get(file(1, ext))!.equals(h.anchor.objects.get(file(1, ext))!)).toBe(true);
    }
    expect(h.pub.objects.get(file(1, 'json'))!.toString('utf8')).toBe(row.checkpointJson);
    expect(verifyWithPublished(h.pub, 1)).toBe(true);
    const keys = JSON.parse(h.anchor.objects.get('transparency/v1/public-keys.json')!.toString('utf8')) as { version: number; keys: { keyId: string; alg: string }[] };
    expect(keys).toMatchObject({ version: 1, keys: [{ keyId: 'anchor-test-key-7', alg: 'ECDSA_P256_SHA256' }] });
    // 증명 파일: 머리 31바이트 ‖ 판 1 ‖ SHA-256 연산(0x08) ‖ 대상 = 체크포인트 해시(결정 5)
    const ots = h.pub.objects.get(file(1, 'ots'))!;
    expect(ots.subarray(0, 31).equals(OTS_MAGIC)).toBe(true);
    expect([ots[31], ots[32]]).toEqual([0x01, 0x08]);
    expect(ots.subarray(33, 65).toString('hex')).toBe(row.checkpointHash);
    // 캘린더는 체크포인트 해시를 모른다(16바이트 난수를 덧붙여 SHA-256한 값만 받는다)
    const cal = h.calendars[0]!;
    expect(cal.submitted).toHaveLength(1);
    expect(cal.submitted[0]!.length).toBe(32);
    expect(cal.submitted[0]!.toString('hex')).not.toBe(row.checkpointHash);
    const index = JSON.parse(h.pub.objects.get('transparency/v1/index.json')!.toString('utf8')) as unknown;
    expect(index).toEqual({ version: 1, checkpoints: [{ no: 1, checkpointHash: row.checkpointHash, json: file(1, 'json'), sig: file(1, 'sig'), ots: file(1, 'ots') }] });
  });

  test('B3 일 체크포인트는 그날 00:10 KST 정각 실행에 만들고 − 1ms에는 없으며, 같은 날 다시 돌면 만들지 않고 다음 날은 직전 해시로 잇는다', async () => {
    const h = harness();
    await appendRecords(h.chain, 3, DAY1_DUE - HOUR);
    expect((await h.publisher.run(DAY1_DUE - 1)).created).toEqual([]);
    expect(h.store.entries).toHaveLength(0);
    expect((await h.publisher.run(DAY1_DUE)).created).toEqual([{ no: 1, kind: 'DAILY' }]);
    await appendRecords(h.chain, 2, DAY1_DUE + HOUR);
    // 같은 날 낮(14:10 KST)에는 새 기록이 있어도 일 체크포인트를 또 만들지 않는다
    expect((await h.publisher.run(DAY1_DUE + 14 * HOUR)).created).toEqual([]);
    expect((await h.publisher.run(DAY2_DUE - 1)).created).toEqual([]);
    expect((await h.publisher.run(DAY2_DUE)).created).toEqual([{ no: 2, kind: 'DAILY' }]);
    const [one, two] = [(await h.store.findByNo(1))!, (await h.store.findByNo(2))!];
    expect(two).toMatchObject({ fromSeq: 4, toSeq: 5, leafCount: 2, prevCheckpointHash: one.checkpointHash });
    expect(JSON.parse(two.checkpointJson!)).toMatchObject({ no: 2, firstSeq: 4, lastSeq: 5, prevCheckpointHash: one.checkpointHash, createdAt: '2026-11-24T15:10:00.000Z' });
  });

  test('B3 새 기록이 없으면 일 체크포인트를 만들지 않고(빈 트리 없음) 기록이 생긴 다음 실행에서 만든다', async () => {
    const h = harness();
    expect((await h.publisher.run(DAY1_DUE)).created).toEqual([]);
    await appendRecords(h.chain, 1, DAY1_DUE + MINUTE);
    expect((await h.publisher.run(DAY1_DUE + 5 * MINUTE)).created).toEqual([{ no: 1, kind: 'DAILY' }]);
  });

  test('B3 회차 마감: 같은 실행에서 끝난 회차 둘을 체크포인트 하나로 묶고, 다음 실행에서 다시 묶지 않는다. 목록을 못 읽으면 회차 마감만 미루고 일 체크포인트는 만든다', async () => {
    const e1 = '0193c111-0000-7000-8000-0000000000a1';
    const e2 = '0193c111-0000-7000-8000-0000000000a2';
    // 판매 시작 + 60분이 지난 회차 둘(core-svc GET /internal/v1/events/onsale-closed가 주는 꼴)
    const closedAt = DAY1_DUE + 2 * HOUR;
    let down = false;
    const asked: [number, number][] = [];
    const closed: ClosedOnsaleSource = {
      async closedBetween(fromMs, toMs) {
        asked.push([fromMs, toMs]);
        if (down) throw new Error('core-svc 503');
        return [
          { eventId: e2, closedAtMs: closedAt },
          { eventId: e1, closedAtMs: closedAt - MINUTE },
        ].filter((e) => e.closedAtMs >= fromMs && e.closedAtMs < toMs);
      },
    };
    const h = harness({ closed });
    await appendRecords(h.chain, 2, DAY1_DUE - HOUR);
    expect((await h.publisher.run(DAY1_DUE)).created).toEqual([{ no: 1, kind: 'DAILY' }]);
    await appendRecords(h.chain, 3, closedAt - 30 * MINUTE);
    // 마감 + 10분 안의 실행(결정 9): 둘을 한 체크포인트로
    const run = await h.publisher.run(closedAt + 5 * MINUTE);
    expect(run.created).toEqual([{ no: 2, kind: 'EVENT_CLOSE' }]);
    const two = (await h.store.findByNo(2))!;
    expect(JSON.parse(two.checkpointJson!)).toMatchObject({ no: 2, firstSeq: 3, lastSeq: 5, closedEvents: [e1, e2] });
    expect(JSON.parse(two.checkpointJson!)).not.toHaveProperty('accessLogDayAnchor');
    await appendRecords(h.chain, 1, closedAt + 6 * MINUTE);
    expect((await h.publisher.run(closedAt + 10 * MINUTE)).created).toEqual([]);
    // 다음 날: 목록이 멈춰도 일 체크포인트는 만든다
    down = true;
    const next = await h.publisher.run(DAY2_DUE);
    expect(next.created).toEqual([{ no: 3, kind: 'DAILY' }]);
    expect(next.errors.some((e) => e.startsWith('closed-events:'))).toBe(true);
    expect(asked.every(([from, to]) => to - from <= 24 * HOUR)).toBe(true);
  });

  test('B2 명령 실행 앞뒤 체크포인트(EXECUTION)는 번호·JSON·서명·게시가 없고, 공개 체크포인트의 구간과 직전 해시는 그것을 건너뛴다', async () => {
    const h = harness();
    const service = new AuditCheckpointService(h.store, h.chain, () => DAY1_DUE - 3 * HOUR);
    await appendRecords(h.chain, 2, DAY1_DUE - 5 * HOUR);
    const manual = await service.create({ reason: '수동 점검', actorRef: 'commander' });
    expect(manual).toMatchObject({ kind: 'MANUAL', no: 1, fromSeq: 1, toSeq: 2 });
    expect(manual.signature).toBeUndefined();
    await appendRecords(h.chain, 2, DAY1_DUE - 2 * HOUR);
    const exec = await service.create({ reason: '명령 실행 앞', actorRef: 'system', kind: 'EXECUTION' });
    expect(exec.kind).toBe('EXECUTION');
    expect(exec.no).toBeUndefined();
    expect(exec.checkpointJson).toBeUndefined();
    await appendRecords(h.chain, 1, DAY1_DUE - HOUR);
    const run = await h.publisher.run(DAY1_DUE);
    // 수동(1)은 이 실행이 서명·게시하고, 일(2)은 수동 뒤 기록부터 덮는다(EXECUTION과 그 감사 기록 포함)
    expect(run).toMatchObject({ created: [{ no: 2, kind: 'DAILY' }], signed: 2, published: 2 });
    const daily = (await h.store.findByNo(2))!;
    expect(daily).toMatchObject({ fromSeq: manual.toSeq + 1, toSeq: h.chain.entries.length, prevCheckpointHash: manual.checkpointHash });
    const execAfter = h.store.entries.find((c) => c.checkpointId === exec.checkpointId)!;
    expect(execAfter.signature).toBeUndefined();
    expect(execAfter.publishedAtMs).toBeUndefined();
    expect([...h.pub.objects.keys()].filter((k) => k.startsWith('transparency/v1/checkpoints/')).sort()).toEqual([file(1, 'json'), file(1, 'ots'), file(1, 'sig'), file(2, 'json'), file(2, 'ots'), file(2, 'sig')]);
    expect(await service.verify(exec.checkpointId)).toMatchObject({ valid: true, legacy: false, signed: false, kind: 'EXECUTION' });
    expect(await service.verify(daily.checkpointId)).toMatchObject({ valid: true, signed: true, signatureValid: true, anchorValid: true, no: 2 });
  });
});

describe('C-T41 공개 캘린더 장애(ADR-0348 결정 5, ADR-0075)', () => {
  test('C-T41 캘린더를 모두 막아도 체크포인트·서명은 남고 게시하지 않으며, 캘린더가 돌아온 다음 실행에서 다시 찍어 게시한다', async () => {
    const a = new MemoryOpenTimestampsCalendar(CAL_A);
    const b = new MemoryOpenTimestampsCalendar(CAL_B);
    a.fail = true;
    b.fail = true;
    const h = harness({ calendars: [a, b] });
    await appendRecords(h.chain, 4, DAY1_DUE - HOUR);
    const down = await h.publisher.run(DAY1_DUE);
    expect(down).toMatchObject({ created: [{ no: 1, kind: 'DAILY' }], signed: 1, stamped: 0, published: 0 });
    expect(down.errors).toContain('ots:all-failed:1');
    const row = (await h.store.findByNo(1))!;
    expect(row.signature).toEqual(expect.any(String));
    expect(row.otsState).toBeUndefined();
    expect(row.publishedAtMs).toBeUndefined();
    expect(h.pub.objects.size).toBe(0);
    expect(h.anchor.objects.size).toBe(0);
    // 한 번 더 막힌 채 돌아도 행을 지우거나 다시 만들지 않는다
    const again = await h.publisher.run(DAY1_DUE + 5 * MINUTE);
    expect(again).toMatchObject({ created: [], signed: 0, stamped: 0, published: 0 });
    expect(h.store.entries).toHaveLength(1);
    a.fail = false;
    b.fail = false;
    const back = await h.publisher.run(DAY1_DUE + 10 * MINUTE);
    expect(back).toMatchObject({ created: [], signed: 0, stamped: 1, published: 1, errors: [] });
    expect((await h.store.findByNo(1))!).toMatchObject({ otsState: 'PENDING', signature: row.signature });
    expect(verifyWithPublished(h.anchor, 1)).toBe(true);
  });

  test('B5 캘린더 하나라도 받으면 PENDING이고 증명 파일에는 받은 캘린더의 대기 증명만 있다', async () => {
    const a = new MemoryOpenTimestampsCalendar(CAL_A);
    const b = new MemoryOpenTimestampsCalendar(CAL_B);
    a.fail = true;
    const h = harness({ calendars: [a, b] });
    await appendRecords(h.chain, 2, DAY1_DUE - HOUR);
    const run = await h.publisher.run(DAY1_DUE);
    expect(run).toMatchObject({ stamped: 1, published: 1 });
    const ots = h.pub.objects.get(file(1, 'ots'))!;
    expect(ots.includes(Buffer.from(CAL_B, 'utf8'))).toBe(true);
    expect(ots.includes(Buffer.from(CAL_A, 'utf8'))).toBe(false);
    expect(ots.includes(Buffer.from('83dfe30d2ef90c8e', 'hex'))).toBe(true);
    expect(b.submitted).toHaveLength(1);
  });

  test('B5 대기 증명은 1시간 뒤 다시 받아 비트코인 증명이 붙으면 COMPLETE·.complete.ots를 두 자리에 쓰고 .ots는 덮지 않는다(1시간 − 1ms에는 다시 받지 않는다)', async () => {
    const cal = new MemoryOpenTimestampsCalendar(CAL_A);
    const h = harness({ calendars: [cal] });
    await appendRecords(h.chain, 3, DAY1_DUE - HOUR);
    await h.publisher.run(DAY1_DUE);
    const pending = Buffer.from(h.pub.objects.get(file(1, 'ots'))!);
    cal.complete(912_345);
    expect((await h.publisher.run(DAY1_DUE + HOUR - 1)).completed).toBe(0);
    expect(h.pub.objects.has(file(1, 'complete.ots'))).toBe(false);
    const done = await h.publisher.run(DAY1_DUE + HOUR);
    expect(done.completed).toBe(1);
    expect((await h.store.findByNo(1))!.otsState).toBe('COMPLETE');
    const complete = h.pub.objects.get(file(1, 'complete.ots'))!;
    expect(complete.equals(h.anchor.objects.get(file(1, 'complete.ots'))!)).toBe(true);
    expect(complete.includes(Buffer.from('0588960d73d71901', 'hex'))).toBe(true);
    expect(complete.subarray(33, 65).toString('hex')).toBe((await h.store.findByNo(1))!.checkpointHash);
    expect(h.pub.objects.get(file(1, 'ots'))!.equals(pending)).toBe(true);
    const index = JSON.parse(h.pub.objects.get('transparency/v1/index.json')!.toString('utf8')) as { checkpoints: { completeOts?: string }[] };
    expect(index.checkpoints[0]!.completeOts).toBe(file(1, 'complete.ots'));
    // 완료 뒤에는 다시 받지 않는다
    expect((await h.publisher.run(DAY1_DUE + 3 * HOUR)).completed).toBe(0);
  });
});

describe('B6·B7 게시 자리와 어긋남(ADR-0348 결정 6·10)', () => {
  test('B6 두 자리 가운데 하나라도 못 쓰면 게시 시각을 적지 않고 다음 실행에서 두 자리에 같은 바이트로 게시한다', async () => {
    const h = harness();
    await appendRecords(h.chain, 2, DAY1_DUE - HOUR);
    h.anchor.failNext = 1;
    const first = await h.publisher.run(DAY1_DUE);
    expect(first.published).toBe(0);
    expect(first.errors.some((e) => e.startsWith('publish:'))).toBe(true);
    expect((await h.store.findByNo(1))!.publishedAtMs).toBeUndefined();
    const second = await h.publisher.run(DAY1_DUE + 5 * MINUTE);
    expect(second.published).toBe(1);
    expect((await h.store.findByNo(1))!.publishedAtMs).toBe(DAY1_DUE + 5 * MINUTE);
    for (const ext of ['json', 'sig', 'ots']) expect(h.pub.objects.get(file(1, ext))!.equals(h.anchor.objects.get(file(1, ext))!)).toBe(true);
  });

  test('B6 같은 이름에 다른 바이트가 이미 있으면 덮지 않고 SEV2로 멈추며 게시 시각을 적지 않는다', async () => {
    const h = harness();
    await appendRecords(h.chain, 2, DAY1_DUE - HOUR);
    const planted = Buffer.from('{"v":"PEAKET-checkpoint-v1","no":1}', 'utf8');
    await h.anchor.putOnce(file(1, 'json'), planted);
    const run = await h.publisher.run(DAY1_DUE);
    expect(run.published).toBe(0);
    expect(run.conflicts).toEqual([file(1, 'json')]);
    expect(h.anchor.objects.get(file(1, 'json'))!.equals(planted)).toBe(true);
    expect((await h.store.findByNo(1))!.publishedAtMs).toBeUndefined();
    expect(h.logs).toContainEqual({ level: 'error', fields: expect.objectContaining({ event: 'audit-public-file-conflict', severity: 'SEV2', key: file(1, 'json'), target: 'anchor' }) });
  });

  test('B7 체인을 다시 모은 루트가 저장된 체크포인트와 다르면 서명·게시하지 않고 SEV2를 남기며 그 뒤 번호도 멈춘다', async () => {
    let keyDown = true;
    const real = ephemeralCheckpointSigner('anchor-b7');
    const signer: CheckpointSigner = {
      keyId: real.keyId,
      alg: real.alg,
      publicKeySpki: async () => {
        if (keyDown) throw new Error('KMS 503');
        return real.publicKeySpki();
      },
      sign: (m) => real.sign(m),
    };
    const h = harness({ signer });
    await appendRecords(h.chain, 3, DAY1_DUE - HOUR);
    const r1 = await h.publisher.run(DAY1_DUE);
    expect(r1).toMatchObject({ created: [{ no: 1, kind: 'DAILY' }], signed: 0 });
    expect(r1.errors.some((e) => e.startsWith('signing-key:'))).toBe(true);
    await appendRecords(h.chain, 2, DAY1_DUE + HOUR);
    await h.publisher.run(DAY2_DUE);
    expect((await h.store.findByNo(2))!).toMatchObject({ fromSeq: 4, toSeq: 5 });
    // 기록 2의 해시를 바꾼다(저장된 1번 루트와 다시 모은 루트가 어긋난다)
    (h.chain.entries[1] as { hash: string }).hash = 'ab'.repeat(32);
    keyDown = false;
    const r3 = await h.publisher.run(DAY2_DUE + 5 * MINUTE);
    expect(r3).toMatchObject({ signed: 0, stamped: 0, published: 0, mismatches: [1] });
    expect((await h.store.findByNo(1))!.signature).toBeUndefined();
    expect((await h.store.findByNo(2))!.signature).toBeUndefined();
    expect(h.pub.objects.size).toBe(0);
    expect(h.logs).toContainEqual({ level: 'error', fields: expect.objectContaining({ event: 'audit-checkpoint-mismatch', severity: 'SEV2', no: 1 }) });
  });
});

describe('OPS-04 수동 체크포인트(ADR-0348 결정 1·11)', () => {
  test('OPS-04 createWithAudit는 같은 구간을 한 번만 만들고 AUDIT_CHECKPOINT_CREATED를 함께 남기며, API는 서명하지 않는다', async () => {
    const chain = new MemoryAuditChain();
    class AtomicStore extends MemoryAuditCheckpointStore {
      async createWithAudit(input: Parameters<MemoryAuditCheckpointStore['create']>[0], record: Parameters<MemoryAuditChain['append']>[0]) {
        const existing = this.entries.find((c) => c.fromSeq === input.fromSeq && c.no !== undefined);
        if (existing) return existing;
        const cp = await this.create(input);
        await chain.append(record);
        return cp;
      }
    }
    const store = new AtomicStore();
    const service = new AuditCheckpointService(store, chain, () => DAY1_DUE);
    await chain.append({ recordType: 'COMMAND_CREATED', recordId: crypto.randomUUID(), payload: { a: 1 }, nowMs: DAY1_DUE });
    const [a, b] = await Promise.all([service.create({ reason: 'x', actorRef: 'commander' }), service.create({ reason: 'y', actorRef: 'commander' })]);
    expect(a.checkpointId).toBe(b.checkpointId);
    expect(store.entries.filter((c) => c.fromSeq === a.fromSeq)).toHaveLength(1);
    expect(chain.entries.filter((e) => e.recordType === 'AUDIT_CHECKPOINT_CREATED')).toHaveLength(1);
    expect(a).toMatchObject({ kind: 'MANUAL', no: 1 });
    expect(a.signature).toBeUndefined();
    expect(a.keyId).toBeUndefined();
  });
});

describe('C-T38 ① 공개 앵커 HTTP(ADR-0348 결정 12)', () => {
  const identity = new FakeIdentity();
  const chain = new MemoryAuditChain();
  const store = new MemoryAuditPublishStore();
  const pub = new MemoryAuditPublicStore('public');
  const anchor = new MemoryAuditPublicStore('anchor');
  const signer = ephemeralCheckpointSigner('http-anchor-key-3');
  let svc: Awaited<ReturnType<typeof createService>>;
  beforeAll(async () => {
    svc = await createService({
      name: 'ops-svc-anchor',
      module: AppModule.register({ memory: true, nowMs: DAY1_DUE - HOUR, auditCheckpoints: store, auditChain: chain }),
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: DAY1_DUE - HOUR }),
      logDestination: quiet(),
      adminAuthz: identity,
    });
  });
  afterAll(async () => {
    await svc?.close();
  });

  test('C-T38 ① 공개 앵커는 세션 없이 읽고, 서명 전에는 빈 서명·빈 공개키, 게시 작업 뒤에는 ECDSA 서명과 그 키 PEM을 주며 그 공개키로 JSON 바이트가 확인된다', async () => {
    const commander = identity.ops('commander');
    const seeded = await svc.http.inject({
      method: 'POST',
      url: '/v1/ops/commands',
      headers: { ...identity.ops('operator'), 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'SCALE_CHANGE', reason: '공개 앵커 씨앗', params: { eventId: crypto.randomUUID(), scale: 'LARGE' } }),
    });
    expect(seeded.statusCode).toBe(201);
    expect((await svc.http.inject({ method: 'POST', url: '/v1/ops/audit-checkpoints', headers: { ...identity.ops('operator'), 'content-type': 'application/json' }, payload: JSON.stringify({ reason: 'x' }) })).statusCode).toBe(403);
    const created = await svc.http.inject({ method: 'POST', url: '/v1/ops/audit-checkpoints', headers: { ...commander, 'content-type': 'application/json' }, payload: JSON.stringify({ reason: '공개 앵커 점검' }) });
    expect(created.statusCode).toBe(201);
    const cp = JSON.parse(created.payload) as { checkpointId: string; no: number; kind: string; signature?: string | null; checkpointHash: string; signatureAlg: string; otsState: string | null; publishedAt: string | null; legacy: boolean };
    expect(cp).toMatchObject({ no: 1, kind: 'MANUAL', signatureAlg: 'ECDSA_P256_SHA256', otsState: null, publishedAt: null, legacy: false });
    expect(cp.signature ?? null).toBeNull();
    const before = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/ops/audit-anchors/${cp.checkpointId}` })).payload) as Record<string, unknown>;
    expect(before).toMatchObject({ signature: null, keyId: null, publicKey: '', algorithm: 'ECDSA_P256_SHA256', checkpointHash: cp.checkpointHash });

    const run = await new AuditCheckpointPublisher({ store, chain, signer, calendars: [new MemoryOpenTimestampsCalendar(CAL_A)], targets: [pub, anchor] }).run(DAY1_DUE - 30 * MINUTE);
    // 그날 00:10 KST가 지났으므로 이 실행은 수동(1) 뒤 기록(AUDIT_CHECKPOINT_CREATED)을 덮는 일 체크포인트(2)도 만든다
    expect(run).toMatchObject({ created: [{ no: 2, kind: 'DAILY' }], signed: 2, published: 2 });
    const res = await svc.http.inject({ method: 'GET', url: `/v1/ops/audit-anchors/${cp.checkpointId}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { signature: string; keyId: string; publicKey: string; checkpointJson: string; algorithm: string; otsState: string; publishedAt: string; no: number };
    expect(body).toMatchObject({ keyId: 'http-anchor-key-3', algorithm: 'ECDSA_P256_SHA256', otsState: 'PENDING', publishedAt: new Date(DAY1_DUE - 30 * MINUTE).toISOString(), no: 1 });
    expect(createPublicKey(body.publicKey).asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(verify('sha256', Buffer.from(body.checkpointJson, 'utf8'), { key: createPublicKey(body.publicKey), dsaEncoding: 'der' }, Buffer.from(body.signature, 'base64'))).toBe(true);
    expect(body.checkpointJson).toBe(pub.objects.get(file(1, 'json'))!.toString('utf8'));
    const ok = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/ops/audit-anchors/${cp.checkpointId}/verification` })).payload) as unknown;
    expect(ok).toMatchObject({ valid: true, rootValid: true, prevValid: true, signatureValid: true, anchorValid: true, signed: true, otsState: 'PENDING', no: 1 });

    // 서명 1바이트를 바꾸면 검증이 서명 어긋남으로 거절한다(M4-02)
    const sig = Buffer.from(body.signature, 'base64');
    sig[sig.length - 3] = sig[sig.length - 3]! ^ 1;
    store.patch(cp.checkpointId, { signature: sig.toString('base64') });
    const bad = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/ops/audit-anchors/${cp.checkpointId}/verification` })).payload) as unknown;
    expect(bad).toMatchObject({ valid: false, rootValid: true, prevValid: true, signatureValid: false });
  });

  test('R584_없는_앵커는_404다', async () => {
    const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/audit-anchors/${crypto.randomUUID()}` });
    expect(r.statusCode).toBe(404);
  });
});
