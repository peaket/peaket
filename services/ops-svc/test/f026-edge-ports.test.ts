// F-02-6(동결 로컬) 엣지·WAF·CDN 포트 계약 시험. 구현 전 트리에서는 새 모듈이 없어 실행 전에 실패한다.
// 구현이 끝나면 이 파일이 포트·가짜의 계약(명령 4 WAF 전송·손으로 풀기·ASN 만료, 명령 6 진입 Degraded,
// S3 사본 고정·매진 정적 응답의 실행기/되돌리기 경로)을 고정한다.
// 정본: docs/features/control-tower.md §3 명령 4·6, §5 'AWS WAF API'·'CDN 설정 API', §14 C-T44 ⑥,
// docs/features/queue-admission.md §4·§9, ADR-0078 결정 2, ADR-0223 결정 1·8·9, ADR-0234 결정 5, ADR-0349 결정 9·10.
// 실제 AWS 호출은 미실행·[가정]이다. 이 파일은 처리량·인원·K1/K2/K7 수치를 새로 주장하지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { EdgeCommandExecutor } from '../src/modules/commands/application/edge-command-executor.js';
import { MemoryCdnEdgeSettings } from '../src/modules/commands/adapters/memory-cdn-edge-settings.js';
import { MemoryEntryMode } from '../src/modules/commands/adapters/memory-entry-mode.js';
import { MemoryWafBlocks } from '../src/modules/commands/adapters/memory-waf-blocks.js';
import {
  ComputeDryRun,
  ExecuteCommand,
  MaintainCommands,
  MemoryAuditChain,
  MemoryCommandStore,
  RevertCommand,
  type Command,
  type CommandType,
} from '../src/modules/commands/index.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const HOUR = 60 * 60_000;
const REQUESTER = '0193a000-0000-7000-8000-0000000000f1';
const ACTOR = { accountId: REQUESTER, sessionId: '', role: 'commander' };
const NEXT = { execute: async () => ({ status: 'FAILED' as const, error: 'next-not-called' }) };
const expiry = (ms: number) => new Date(ms).toISOString();

/** 한 저장소·가짜 WAF·가짜 엣지 저장소·가짜 CloudFront를 함께 쓰는 시험 틀 */
function harness() {
  const audit = new MemoryAuditChain();
  const store = new MemoryCommandStore(audit);
  const waf = new MemoryWafBlocks();
  const entryMode = new MemoryEntryMode();
  const cdn = new MemoryCdnEdgeSettings();
  const edge = new EdgeCommandExecutor({ waf, entryMode, cdn, next: NEXT, nowMs: () => NOW });
  const execution = new ExecuteCommand(store, edge);
  const create = (type: CommandType, params: Record<string, unknown>): Promise<Command> =>
    store.create({
      commandId: randomUUID(),
      type,
      reason: '동결 로컬 F-02-6 포트 계약 시험',
      params,
      requestedBy: REQUESTER,
      requestedRole: 'commander',
      nowMs: NOW,
      approvalMode: 'ONE',
    });
  const acked = async (command: Command, nowMs = NOW): Promise<Command> => {
    const out = await execution.run(command, ACTOR, nowMs);
    expect(out.state).toBe('ACKED');
    return out;
  };
  return { audit, store, waf, entryMode, cdn, edge, execution, create, acked };
}

describe('F026-WAF 명령 4 WAF 포트', () => {
  test('F026-WAF ① 명령 4 CIDR·ASN을 WAF 포트에 넣고 ACKED가 되며 expiresAt이 명령 행에 남는다', async () => {
    const h = harness();
    const command = await h.create('BLOCK_ASN_IP', {
      cidrs: ['198.51.100.0/24', '2001:db8:1::/48'],
      asns: [64512, 64513],
      expiresAt: expiry(NOW + HOUR),
    });
    const out = await h.execution.run(command, ACTOR, NOW);
    expect(out.state).toBe('ACKED');
    expect(out.expiresAtMs).toBe(NOW + HOUR);
    expect(await h.waf.remaining(command.commandId)).toEqual({
      cidrs: ['198.51.100.0/24', '2001:db8:1::/48'],
      asns: [64512, 64513],
    });
    // 같은 명령을 다시 넣어도 목록이 늘지 않는다(멱등)
    await h.waf.apply(command.commandId, { cidrs: ['198.51.100.0/24'], asns: [64512], expiresAtMs: NOW + HOUR });
    expect((await h.waf.remaining(command.commandId)).cidrs).toEqual(['198.51.100.0/24', '2001:db8:1::/48']);
  });

  test('F026-WAF ② WAF 실패는 waf-unavailable:cidr·:asn으로 갈리고 부분 성공 뒤 재시도가 그 부분을 보존한다', async () => {
    // CIDR 쪽 실패는 아무것도 더하지 않는다
    const cidrFail = harness();
    const cidrCommand = await cidrFail.create('BLOCK_ASN_IP', { cidrs: ['198.51.100.0/24'], asns: [], expiresAt: expiry(NOW + HOUR) });
    cidrFail.waf.failApplyPart = 'cidr';
    const cidrOut = await cidrFail.execution.run(cidrCommand, ACTOR, NOW);
    expect(cidrOut.state).toBe('FAILED');
    expect(cidrOut.lastError).toBe('waf-unavailable:cidr');
    expect(await cidrFail.waf.remaining(cidrCommand.commandId)).toEqual({ cidrs: [], asns: [] });

    // ASN 쪽 실패는 CIDR을 먼저 더한 뒤 실패한다(부분 성공)
    const asnFail = harness();
    const asnCommand = await asnFail.create('BLOCK_ASN_IP', { cidrs: ['198.51.100.0/24'], asns: [64512], expiresAt: expiry(NOW + HOUR) });
    asnFail.waf.failApplyPart = 'asn';
    const asnOut = await asnFail.execution.run(asnCommand, ACTOR, NOW);
    expect(asnOut.state).toBe('FAILED');
    expect(asnOut.lastError).toBe('waf-unavailable:asn');
    expect(await asnFail.waf.remaining(asnCommand.commandId)).toEqual({ cidrs: ['198.51.100.0/24'], asns: [] });

    // 다시 하기(T11): 같은 명령·같은 목록, CIDR은 그대로 두고 ASN만 더한다
    asnFail.waf.failApplyPart = undefined;
    const current = await asnFail.store.find(asnCommand.commandId);
    expect(current).toBeDefined();
    const retried = await asnFail.execution.run(current!, ACTOR, NOW + 1);
    expect(retried.state).toBe('ACKED');
    expect(await asnFail.waf.remaining(asnCommand.commandId)).toEqual({ cidrs: ['198.51.100.0/24'], asns: [64512] });
  });

  test('F026-WAF ③ 손으로 풀기는 RevertCommand·EdgeCommandExecutor를 지나 다른 살아 있는 명령 4가 막는 대역·ASN을 남긴다', async () => {
    const h = harness();
    const a = await h.create('BLOCK_ASN_IP', { cidrs: ['198.51.100.0/24'], asns: [64512], expiresAt: expiry(NOW + HOUR) });
    const b = await h.create('BLOCK_ASN_IP', { cidrs: ['198.51.100.0/24'], asns: [64512], expiresAt: expiry(NOW + HOUR) });
    await h.acked(a);
    await h.acked(b);
    const reverted = await new RevertCommand(h.store, h.edge).execute({ commandId: a.commandId, reason: '손으로 풀기', actor: ACTOR, nowMs: NOW + 1 });
    expect(reverted.pending).toBe(false);
    expect(reverted.command.state).toBe('REVERTED');
    expect((await h.store.find(b.commandId))!.state).toBe('ACKED');
    expect(await h.waf.remaining(a.commandId)).toEqual({ cidrs: [], asns: [] });
    expect(await h.waf.remaining(b.commandId)).toEqual({ cidrs: ['198.51.100.0/24'], asns: [64512] });
  });

  test('F026-WAF ⑧ 정비 바퀴는 만료 명령의 ASN을 WAF에서 빼고, 공유돼도 superseded로 AUTO_EXPIRED다', async () => {
    const h = harness();
    // A는 만료, B는 아직 살아 있고 같은 ASN을 막는다
    const a = await h.create('BLOCK_ASN_IP', { cidrs: [], asns: [64512], expiresAt: expiry(NOW - 1) });
    const b = await h.create('BLOCK_ASN_IP', { cidrs: [], asns: [64512], expiresAt: expiry(NOW + HOUR) });
    await h.acked(a, NOW - 2);
    await h.acked(b, NOW - 2);

    const maintain = new MaintainCommands(h.store, new ComputeDryRun(), {}, { waf: h.waf, blockIpSets: { read: async () => [] } });
    expect(await maintain.expireBlocks(NOW)).toBe(1);

    // A는 공유 ASN이라 WAF 목록에는 남지만, 그 소유는 B다. A는 superseded로 만료된다
    expect((await h.store.find(a.commandId))!.state).toBe('AUTO_EXPIRED');
    expect((await h.store.find(b.commandId))!.state).toBe('ACKED');
    expect(await h.waf.remaining(a.commandId)).toEqual({ cidrs: [], asns: [] });
    expect(await h.waf.remaining(b.commandId)).toEqual({ cidrs: [], asns: [64512] });

    // C는 겹치는 명령이 없어 WAF에서 빠지고 waf-removed로 만료된다
    const c = await h.create('BLOCK_ASN_IP', { cidrs: [], asns: [64513], expiresAt: expiry(NOW - 1) });
    await h.acked(c, NOW - 1);
    expect(await maintain.expireBlocks(NOW)).toBe(1);
    expect((await h.store.find(c.commandId))!.state).toBe('AUTO_EXPIRED');
    expect(await h.waf.remaining(c.commandId)).toEqual({ cidrs: [], asns: [] });
  });
});

describe('F026-ENTRY·F026-CDN 명령 6 포트', () => {
  test('F026-ENTRY ⑤ ENTRY_DEGRADED 실행은 mode:entry에 on과 expireAtMs를 쓰고 되돌리기는 on=false를 쓴다', async () => {
    const h = harness();
    const command = await h.create('DEGRADED_MODE', { mode: 'ENTRY_DEGRADED', expiresAt: expiry(NOW + HOUR) });
    const out = await h.execution.run(command, ACTOR, NOW);
    expect(out.state).toBe('ACKED');
    expect(h.entryMode.value).toEqual({ on: true, expireAtMs: NOW + HOUR });
    const reverted = await h.edge.revert(out, ACTOR);
    expect(reverted.status).toBe('ACKED');
    expect(h.entryMode.value).toEqual({ on: false, expireAtMs: NOW });
  });

  test('F026-CDN ① STATE_MIRROR_FIXED는 queue-files 원본을 S3 사본으로 고정하고 되돌리기는 원본 그룹으로 돌린다', async () => {
    const h = harness();
    const command = await h.create('DEGRADED_MODE', { mode: 'STATE_MIRROR_FIXED' });
    const before = await h.cdn.read();
    expect(before.queueFilesOrigin).toBe('ORIGIN_GROUP');
    const out = await h.execution.run(command, ACTOR, NOW);
    expect(out.state).toBe('ACKED');
    expect((await h.cdn.read()).queueFilesOrigin).toBe('S3_FALLBACK');
    const reverted = await h.edge.revert(out, ACTOR);
    expect(reverted.status).toBe('ACKED');
    expect((await h.cdn.read()).queueFilesOrigin).toBe('ORIGIN_GROUP');
  });

  test('F026-CDN ② SOLD_OUT_STATIC은 queue 진입 응답을 정적 매진으로 바꾸고 되돌리기는 원본으로 돌린다', async () => {
    const h = harness();
    const command = await h.create('DEGRADED_MODE', { mode: 'SOLD_OUT_STATIC' });
    expect((await h.cdn.read()).queueEntryResponse).toBe('ORIGIN');
    const out = await h.execution.run(command, ACTOR, NOW);
    expect(out.state).toBe('ACKED');
    expect((await h.cdn.read()).queueEntryResponse).toBe('SOLD_OUT_STATIC');
    const reverted = await h.edge.revert(out, ACTOR);
    expect(reverted.status).toBe('ACKED');
    expect((await h.cdn.read()).queueEntryResponse).toBe('ORIGIN');
  });

  test('F026-CDN ③ 매진 정적 응답을 켜고 끄면 queue 배포의 진입 응답 모드가 바뀌고 S3 고정과 독립이다', async () => {
    const cdn = new MemoryCdnEdgeSettings();
    await cdn.apply({ soldOutStatic: true });
    expect((await cdn.read()).queueEntryResponse).toBe('SOLD_OUT_STATIC');
    // S3 고정을 켜고 끄어도 매진 정적 응답은 그대로다
    await cdn.apply({ stateMirrorFixed: true });
    expect((await cdn.read()).queueEntryResponse).toBe('SOLD_OUT_STATIC');
    await cdn.apply({ stateMirrorFixed: false });
    expect((await cdn.read()).queueEntryResponse).toBe('SOLD_OUT_STATIC');
    await cdn.apply({ soldOutStatic: false });
    expect((await cdn.read()).queueEntryResponse).toBe('ORIGIN');
  });

  test('F026-CDN ④ 두 명령을 모두 켠 뒤 하나만 RevertCommand로 되돌려도 다른 스위치가 남는다', async () => {
    const h = harness();
    const mirror = await h.create('DEGRADED_MODE', { mode: 'STATE_MIRROR_FIXED' });
    const soldOut = await h.create('DEGRADED_MODE', { mode: 'SOLD_OUT_STATIC' });
    await h.acked(mirror);
    await h.acked(soldOut);
    expect(await h.cdn.read()).toMatchObject({ queueFilesOrigin: 'S3_FALLBACK', queueEntryResponse: 'SOLD_OUT_STATIC' });

    // S3 고정만 되돌린다
    const offMirror = await new RevertCommand(h.store, h.edge).execute({ commandId: mirror.commandId, reason: 'S3 사본 고정 해제', actor: ACTOR, nowMs: NOW + 1 });
    expect(offMirror.command.state).toBe('REVERTED');
    expect(await h.cdn.read()).toMatchObject({ queueFilesOrigin: 'ORIGIN_GROUP', queueEntryResponse: 'SOLD_OUT_STATIC' });
    expect((await h.store.find(soldOut.commandId))!.state).toBe('ACKED');

    // 이어서 매진 정적만 되돌린다
    const offSoldOut = await new RevertCommand(h.store, h.edge).execute({ commandId: soldOut.commandId, reason: '매진 정적 해제', actor: ACTOR, nowMs: NOW + 2 });
    expect(offSoldOut.command.state).toBe('REVERTED');
    expect(await h.cdn.read()).toMatchObject({ queueFilesOrigin: 'ORIGIN_GROUP', queueEntryResponse: 'ORIGIN' });
  });
});

describe('C-T44 ⑥ CloudFront 설정·S3 사본 고정 계약', () => {
  test('C-T44 ⑥ CloudFront 가짜의 원본 그룹은 500·502·503·504·연결 2초·시도 1회이고, S3 사본 고정은 해제 명령 전까지 유지된다', async () => {
    const cdn = new MemoryCdnEdgeSettings();
    expect((await cdn.read()).originGroup).toEqual({ failoverCodes: [500, 502, 503, 504], connectionTimeoutMs: 2_000, attempts: 1 });
    await cdn.apply({ stateMirrorFixed: true });
    // 다른 읽기·다른 스위치가 고정을 풀지 않는다
    await cdn.read();
    await cdn.apply({ soldOutStatic: true });
    expect((await cdn.read()).queueFilesOrigin).toBe('S3_FALLBACK');
    expect((await cdn.read()).queueEntryResponse).toBe('SOLD_OUT_STATIC');
    // 해제 명령(되돌리기)만 원본 그룹으로 돌린다. 매진 정적 응답은 그대로다
    await cdn.apply({ stateMirrorFixed: false });
    expect((await cdn.read()).queueFilesOrigin).toBe('ORIGIN_GROUP');
    expect((await cdn.read()).queueEntryResponse).toBe('SOLD_OUT_STATIC');
  });
});

describe('F026-PORTS 공개 면', () => {
  test('F026-PORTS ① WafBlocks·EntryModeStore·CdnEdgeSettings·Memory* 포트 계약이 공개 면에 있다', async () => {
    const waf = new MemoryWafBlocks();
    const entry = new MemoryEntryMode();
    const cdn = new MemoryCdnEdgeSettings();
    expect(typeof waf.apply).toBe('function');
    expect(typeof waf.release).toBe('function');
    expect(typeof waf.remaining).toBe('function');
    expect(typeof entry.write).toBe('function');
    expect(typeof entry.read).toBe('function');
    expect(typeof cdn.read).toBe('function');
    expect(typeof cdn.apply).toBe('function');
    expect(await entry.read()).toBeUndefined();
  });
});
