// 라벨 반영·키 회전 이음·그림자 판 통합 시험의 공용 준비: 실제 Valkey와 실제 gRPC 서버(TrustService·TrustLabelService)로 trust-svc 한 조각을 띄운다.
// 사람 확인은 대역(결과를 시험이 정한다), 판정 기록·라벨은 계약 모양 그대로(JsonTelemetryRecorder) 받아 둔다. 시험 코드가 직접 부르는 명령은 긴 마감을 준다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { createHash } from 'node:crypto';
import { type Clock, createHotRedis, type HotRedis, LogPseudonymizer, systemClock } from '@peaket/platform';
import { startGrpcServer } from '../src/grpc-server.js';
import { deviceRefsFromEnv } from '../src/modules/scoring/adapters/device-refs.js';
import { JsonTelemetryRecorder } from '../src/modules/scoring/adapters/json-telemetry-recorder.js';
import { LogBlockListChange, LogVerdictRecorder } from '../src/modules/scoring/adapters/prom-trust-signals.js';
import { RedisFeatureStore } from '../src/modules/scoring/adapters/redis-feature-store.js';
import { RedisLabelStore } from '../src/modules/scoring/adapters/redis-label-store.js';
import { ApplyLabel } from '../src/modules/scoring/application/apply-label.js';
import { ScoreRisk } from '../src/modules/scoring/application/score-risk.js';
import type { DeviceRefs, TrustSignals } from '../src/modules/scoring/domain/ports.js';
import { parseRuleSet, type RuleSet } from '../src/modules/scoring/domain/rules.js';
import type { Scorer } from '../src/modules/scoring/domain/scorers.js';
import type { NetClass } from '../src/modules/scoring/domain/types.js';
import { trustLabelServiceHandlers, trustPackage, trustServiceHandlers } from '../src/modules/scoring/inbound/trust.grpc.js';
import { recordingHuman, recordingSignals, SYNTHETIC_RULES_JSON } from '../test/support.js';

export const DAY = 86_400_000;
/** 시험 코드가 직접 부르는 명령의 마감(제품 코드의 100ms와 다르다) */
export const slow = (key: string) => ({ key, deadlineMs: 5_000 });
/** 시험 라벨 키(합성 값) */
export const KEY_V1 = Buffer.alloc(32, 9);
export const KEY_V2 = Buffer.alloc(32, 21);
/** 형식에 맞는 기기 식별값(base64url 22자) */
export const dev = (name: string) => `D${name.replace(/[^A-Za-z0-9]/g, '').padEnd(21, '0').slice(0, 21)}`;
/** 판 하나(v1)의 기기 가명 */
export const devicesV1 = deviceRefsFromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: KEY_V1.toString('base64') }, systemClock).refs;
/** 시험 로그 가명 키(합성 값). 보안 로그 줄의 처리자 accountRef를 시험이 같은 식으로 만든다 */
export const PSEUDONYMS = new LogPseudonymizer(Buffer.alloc(32, 7));
/** 정본의 칸 이름 식(라벨 ID의 SHA-256 앞 32자, docs/data.md §3 tr:lbl·tr:blkv)을 시험이 따로 계산한다 */
export const sha32 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 32);
/** 라벨 칸(건 ID·pid·출처) */
export const lid = (sourceRef: string, pid: string, source: string) => sha32(`${sourceRef}|${pid}|${source}`);

type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;
const clientPkg = grpc.loadPackageDefinition(protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true })) as unknown as {
  peaket: { trust: { v1: { TrustService: grpc.ServiceClientConstructor; TrustLabelService: grpc.ServiceClientConstructor } } };
};

export interface Offered {
  topic: string;
  key: string | null;
  value: Record<string, unknown>;
}

export interface LabelWorldOptions {
  /** 서비스가 붙을 Redis 주소(장애 주입 중계를 끼울 때). 없으면 url */
  serviceUrl?: string;
  /** 서비스의 Redis를 감싼다(늦추기·실패 주입) */
  wrap?: (r: HotRedis) => HotRedis;
  clock?: Clock;
  devices?: DeviceRefs;
  rules?: RuleSet;
  signals?: TrustSignals;
  scorers?: readonly Scorer[];
  netClass?: (asn: number) => NetClass;
  /** 보안 로그 줄을 받을 로거(실제 플랫폼 로거를 끼운다). 없으면 칸을 모은다 */
  securityLogger?: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void };
}

export async function labelWorld(url: string, o: LabelWorldOptions = {}) {
  const direct = await createHotRedis({ url });
  const serviceRedis = await createHotRedis({ url: o.serviceUrl ?? url });
  const svc = o.wrap ? o.wrap(serviceRedis) : serviceRedis;
  const clock = o.clock ?? systemClock;
  const pending: Promise<unknown>[] = [];
  const human = recordingHuman();
  const signals = o.signals ?? recordingSignals();
  const offered: Offered[] = [];
  const telemetry = new JsonTelemetryRecorder({ offer: (_record, topic, m) => offered.push({ topic, key: m.key, value: JSON.parse(m.value.toString('utf8')) as Record<string, unknown> }) });
  const logLines: Record<string, unknown>[] = [];
  const warnLines: Record<string, unknown>[] = [];
  const securityLog = new LogBlockListChange(o.securityLogger ?? { info: (fields) => void logLines.push(fields), warn: (fields) => void warnLines.push(fields) }, PSEUDONYMS);
  const verdictLog: Record<string, unknown>[] = [];
  const logVerdicts = new LogVerdictRecorder({ info: (fields) => void verdictLog.push(fields) });
  const rules = o.rules ?? parseRuleSet(SYNTHETIC_RULES_JSON);
  const features = new RedisFeatureStore(svc);
  const score = new ScoreRisk({
    rules: { current: () => rules, intensity: () => 'BASE' },
    human,
    features,
    devices: o.devices ?? devicesV1,
    asn: { classify: (asn) => (o.netClass ? o.netClass(asn) : 'OTHER') },
    recorder: {
      record: (r) => {
        logVerdicts.record(r);
        telemetry.record(r);
      },
    },
    behaviors: { behavior: () => undefined },
    signals,
    clock,
    after: (w) => void pending.push(w()),
    ...(o.scorers ? { scorers: o.scorers } : {}),
  });
  const apply = new ApplyLabel({ store: new RedisLabelStore(svc), recorder: telemetry, log: securityLog, signals, devices: o.devices ?? devicesV1, clock });
  const errors: unknown[] = [];
  const pkg = trustPackage();
  const srv = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      { definition: pkg.TrustService.service, handlers: trustServiceHandlers(score, (_m, e) => void errors.push(e)) },
      { definition: pkg.TrustLabelService.service, handlers: trustLabelServiceHandlers(apply, (_m, e) => void errors.push(e)) },
    ],
  });
  const target = `127.0.0.1:${srv.port}`;
  const trustClient = new clientPkg.peaket.trust.v1.TrustService(target, grpc.credentials.createInsecure()) as unknown as grpc.Client & { ScoreRisk: Unary };
  const labelClient = new clientPkg.peaket.trust.v1.TrustLabelService(target, grpc.credentials.createInsecure()) as unknown as grpc.Client & { ApplyLabel: Unary };
  const unary = (f: Unary, req: object) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      f(req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v ?? {})));
    });

  /** 사전 검증(기본)이나 로비 입장 판정. 응답 뒤로 미룬 쓰기를 기다린다. eventKey는 그 판정의 적용 판 판정 기록 사건 키(판정 기록을 냈을 때) */
  const scoreRisk = async (r: Record<string, unknown>) => {
    const before = offered.length;
    const out = await unary(trustClient.ScoreRisk.bind(trustClient), {
      context: 'SCORE_CONTEXT_PREVERIFY',
      lobby_shuffle: 'LOBBY_SHUFFLE_OFF',
      event_id: 'ev-1',
      pid: 'pid-1',
      device_id: dev('one'),
      human_check_token: 'tok',
      journey_id: '0190f3a1-7c2e-7a00-8000-0000000000aa',
      client: { ip: '198.51.100.7', user_agent: 'UA', asn: 64512 },
      ...r,
    });
    await settle();
    const active = offered.slice(before).find((o) => o.value.shadow === false && (o.value.category === 'PASS' || o.value.category === 'CHALLENGED'));
    return { ...out, eventKey: active ? String(active.value.eventKey) : '' };
  };
  /** 라벨 반영. 기본은 표본 검토 BOT(둘째 묶음, 적용 판 CHALLENGE). 표본 검토는 verdict_event_key를 함께 준다 */
  const applyLabel = (r: Record<string, unknown>) =>
    unary(labelClient.ApplyLabel.bind(labelClient), {
      source_ref: 'case-1',
      source_version: 1,
      source: 'LABEL_SOURCE_SAMPLE_REVIEW',
      label: 'LABEL_BOT',
      event_id: 'ev-1',
      pid: 'pid-1',
      acted_by: 'admin-1',
      review_batch: 'REVIEW_BATCH_SHADOW_CHALLENGED',
      applied_verdict: 'VERDICT_CHALLENGE',
      ...r,
    });
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  const cmd = (args: string[]) => direct.command(args, slow(args[1] ?? ''));
  /** Hash 전체(필드 → 값) */
  const hash = async (key: string): Promise<Record<string, string>> => {
    const raw = (await cmd(['HGETALL', key])) as unknown;
    const out: Record<string, string> = {};
    if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
    else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) out[k] = String(v);
    return out;
  };
  /** 패턴에 맞는 키 이름 */
  const keysLike = async (pattern: string): Promise<string[]> => ((await direct.command(['KEYS', pattern], { deadlineMs: 5_000 })) as unknown[]).map(String).sort();
  const pttl = async (key: string) => Number(await cmd(['PTTL', key]));

  return {
    direct,
    serviceRedis,
    human,
    signals,
    offered,
    logLines,
    warnLines,
    verdictLog,
    errors,
    score,
    apply,
    features,
    scoreRisk,
    applyLabel,
    settle,
    cmd,
    hash,
    keysLike,
    pttl,
    close: async () => {
      trustClient.close();
      labelClient.close();
      await srv.close();
      await serviceRedis.close();
      await direct.close();
    },
  };
}

export type LabelWorld = Awaited<ReturnType<typeof labelWorld>>;
