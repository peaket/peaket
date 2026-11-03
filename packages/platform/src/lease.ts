// 쿠버네티스 Lease로 리더 하나 뽑기(openspec 변경 add-idempotency-and-outbox 결정 10, ADR-0116 결정 2).
// - Lease 12초·갱신 한도 8초·다시 시도 2초 [가정]: 리더가 멈추면 늦어도 약 14초 뒤 다른 복제가 잡는다(정본 '15초 안')
// - 갱신 한도가 Lease보다 짧아, 갱신하지 못한 리더는 남이 잡기 전에 스스로 내려온다
// - 남의 Lease가 끝났는지는 상대가 적은 시각이 아니라 그 기록이 바뀐 것을 본 내 단조 시계로 센다(노드 사이 시계 차이, client-go와 같은 방식)
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import type { Clock } from './clock.js';
import { realSleep, type LeaderState } from './outbox-relay.js';

export const LEASE_DEFAULTS = { leaseDurationMs: 12_000, renewDeadlineMs: 8_000, retryPeriodMs: 2_000 } as const;

export interface LeaseSpec {
  holderIdentity: string | null;
  leaseDurationSeconds: number;
  /** RFC 3339, 마이크로초 여섯 자리(쿠버네티스 MicroTime) */
  acquireTime: string | null;
  renewTime: string | null;
  leaseTransitions: number;
}

export interface LeaseRecord extends LeaseSpec {
  resourceVersion: string;
}

/** Lease 하나를 읽고 만들고 고치는 포트. 만들기·고치기에서 겨루어 지면(409) 'conflict' */
export interface LeaseApi {
  get(): Promise<LeaseRecord | undefined>;
  create(spec: LeaseSpec): Promise<LeaseRecord | 'conflict'>;
  update(spec: LeaseSpec, resourceVersion: string): Promise<LeaseRecord | 'conflict'>;
}

/** 쿠버네티스 MicroTime 꼴(밀리초 뒤에 0 세 자리를 붙인다) */
const microTime = (ms: number): string => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');

export interface LeaseElectorOptions {
  api: LeaseApi;
  /** 보유자 이름(파드 이름) */
  identity: string;
  clock: Clock;
  leaseDurationMs?: number;
  renewDeadlineMs?: number;
  retryPeriodMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onChange?: (leader: boolean) => void;
}

export class LeaseElector implements LeaderState {
  private readonly o: Required<Omit<LeaseElectorOptions, 'onChange'>> & Pick<LeaseElectorOptions, 'onChange'>;
  private leader = false;
  private lastRenewAt = Number.NEGATIVE_INFINITY;
  private observed?: { resourceVersion: string; at: number };
  private current?: LeaseRecord;
  private stopper?: AbortController;
  private loop?: Promise<void>;

  constructor(o: LeaseElectorOptions) {
    this.o = { ...LEASE_DEFAULTS, sleep: realSleep, ...o };
    if (!(this.o.renewDeadlineMs < this.o.leaseDurationMs)) throw new RangeError('갱신 한도는 Lease 기간보다 짧아야 한다');
  }

  /**
   * 리더 세대(펜싱 토큰, ADR-0056 결정 1): 보유자가 바뀔 때 1 오르는 leaseTransitions + 1. 처음 만든 Lease의 첫 리더가 1이다(명세 queue.qnt `acquire`).
   * 갱신하는 동안 그대로이고, 리더가 아니면(갱신 한도를 넘겼으면) 없다
   */
  generation(): number | undefined {
    return this.isLeader() && this.current ? this.current.leaseTransitions + 1 : undefined;
  }

  /** 리더이고 갱신 한도 안에 갱신했으면 true(반복이 멈춰도 한도를 넘기면 false) */
  isLeader(): boolean {
    return this.leader && this.o.clock.monotonicMs() - this.lastRenewAt < this.o.renewDeadlineMs;
  }

  private setLeader(v: boolean): void {
    if (this.leader === v) return;
    this.leader = v;
    this.o.onChange?.(v);
  }

  private observe(rec: LeaseRecord, now: number): void {
    if (!this.observed || this.observed.resourceVersion !== rec.resourceVersion) this.observed = { resourceVersion: rec.resourceVersion, at: now };
    this.current = rec;
  }

  private async tryAcquireOrRenew(now: number): Promise<boolean> {
    const { api, identity, clock } = this.o;
    const wall = microTime(clock.now());
    const duration = Math.ceil(this.o.leaseDurationMs / 1000);
    const rec = await api.get();
    if (!rec) {
      const r = await api.create({ holderIdentity: identity, leaseDurationSeconds: duration, acquireTime: wall, renewTime: wall, leaseTransitions: 0 });
      if (r === 'conflict') return false;
      this.observe(r, now);
      return true;
    }
    this.observe(rec, now);
    const mine = rec.holderIdentity === identity;
    if (rec.holderIdentity && !mine && this.observed!.at + rec.leaseDurationSeconds * 1000 > now) return false;
    const r = await api.update(
      {
        holderIdentity: identity,
        leaseDurationSeconds: duration,
        acquireTime: mine ? rec.acquireTime : wall,
        renewTime: wall,
        leaseTransitions: mine ? rec.leaseTransitions : rec.leaseTransitions + 1,
      },
      rec.resourceVersion,
    );
    if (r === 'conflict') return false;
    this.observe(r, now);
    return true;
  }

  /** 한 번 잡거나 갱신한다(반복이 2초마다 부른다) */
  async step(): Promise<void> {
    const now = this.o.clock.monotonicMs();
    let ok = false;
    try {
      ok = await this.tryAcquireOrRenew(now);
    } catch {
      ok = false;
    }
    if (ok) {
      this.lastRenewAt = now;
      this.setLeader(true);
      return;
    }
    if (!this.leader) return;
    const lost = !!this.current?.holderIdentity && this.current.holderIdentity !== this.o.identity;
    if (lost || now - this.lastRenewAt >= this.o.renewDeadlineMs) this.setLeader(false);
  }

  /** 리더면 Lease를 놓는다(보유자를 비우고 기간 1초) */
  async release(): Promise<void> {
    const was = this.leader;
    this.setLeader(false);
    if (!was || !this.current || this.current.holderIdentity !== this.o.identity) return;
    try {
      // 본문 spec에는 Lease 칸만 싣는다(판 번호는 메타데이터로 따로 간다)
      const { resourceVersion, ...spec } = this.current;
      await this.o.api.update({ ...spec, holderIdentity: null, leaseDurationSeconds: 1, renewTime: microTime(this.o.clock.now()) }, resourceVersion);
    } catch {
      // 놓지 못하면 Lease 기간이 지나 저절로 풀린다
    }
  }

  start(): void {
    if (this.stopper) return;
    const stopper = new AbortController();
    this.stopper = stopper;
    this.loop = (async () => {
      while (!stopper.signal.aborted) {
        await this.step();
        await this.o.sleep(this.o.retryPeriodMs, stopper.signal);
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopper?.abort();
    await this.loop;
    this.stopper = undefined;
    await this.release();
  }
}

/** 한 프로세스 안의 Lease(로컬 실행·시험). resourceVersion으로 겨루는 것은 API 서버와 같다 */
export function memoryLeaseApi(): LeaseApi {
  let rec: LeaseRecord | undefined;
  let version = 0;
  return {
    async get() {
      return rec ? { ...rec } : undefined;
    },
    async create(spec) {
      if (rec) return 'conflict';
      rec = { ...spec, resourceVersion: String(++version) };
      return { ...rec };
    },
    async update(spec, resourceVersion) {
      if (!rec || rec.resourceVersion !== resourceVersion) return 'conflict';
      rec = { ...spec, resourceVersion: String(++version) };
      return { ...rec };
    },
  };
}

export interface KubernetesLeaseApiOptions {
  /** API 서버 주소(파드 안: https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT) */
  baseUrl: string;
  namespace: string;
  /** Lease 이름(<서비스>-outbox-relay) */
  name: string;
  /** 서비스 계정 토큰. 부를 때마다 다시 읽는다(돌려 바뀐다) */
  token: () => string;
  /** API 서버 CA(https) */
  ca?: Buffer | string;
  /** 부르기 하나의 시간 한도(기본 2초 [가정]) */
  timeoutMs?: number;
}

interface KubeMeta {
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: unknown[];
  finalizers?: string[];
}
interface KubeLease {
  metadata?: KubeMeta;
  spec?: Partial<LeaseSpec>;
}

/** 고치기(PUT, 전체 바꾸기)에 그대로 실어 보낼 메타데이터. 빼면 API 서버가 차트·ArgoCD가 붙인 라벨·주석을 지운다(코드 리뷰 2026-11-01) */
const KEPT_META = ['labels', 'annotations', 'ownerReferences', 'finalizers'] as const;

const toRecord = (l: KubeLease): LeaseRecord => ({
  holderIdentity: l.spec?.holderIdentity ?? null,
  leaseDurationSeconds: l.spec?.leaseDurationSeconds ?? 0,
  acquireTime: l.spec?.acquireTime ?? null,
  renewTime: l.spec?.renewTime ?? null,
  leaseTransitions: l.spec?.leaseTransitions ?? 0,
  resourceVersion: l.metadata?.resourceVersion ?? '',
});

/** coordination.k8s.io/v1 Lease API(파드 안 설정은 inClusterLeaseApi) */
export function kubernetesLeaseApi(o: KubernetesLeaseApiOptions): LeaseApi {
  const collection = `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(o.namespace)}/leases`;
  const item = `${collection}/${encodeURIComponent(o.name)}`;
  const call = (method: string, path: string, body?: unknown) =>
    // API 서버 부르기는 2초마다라 추적을 남기지 않는다
    context.with(suppressTracing(context.active()), () =>
      new Promise<{ status: number; json: KubeLease | undefined }>((resolve, reject) => {
        const url = new URL(path, o.baseUrl);
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${o.token()}` };
        if (payload) headers['content-type'] = 'application/json';
        const mod = url.protocol === 'https:' ? https : http;
        const timeoutMs = o.timeoutMs ?? 2_000;
        // 한 번만 끝낸다. 응답 머리를 받은 뒤 연결이 끊기면 'end'도 요청 오류도 오지 않으므로, 응답의 'close'와
        // 부르기 전체의 시간 한도로도 끝낸다(멈추면 Lease 반복과 stop()이 영원히 기다렸다, 확인 리뷰 2026-11-01)
        let settled = false;
        const finish = (err: Error | undefined, value?: { status: number; json: KubeLease | undefined }) => {
          if (settled) return;
          settled = true;
          clearTimeout(overall);
          if (err) {
            req.destroy();
            reject(err);
          } else resolve(value!);
        };
        const req = mod.request(url, { method, headers, timeout: timeoutMs, ...(url.protocol === 'https:' && o.ca ? { ca: o.ca } : {}) }, (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (raw += c));
          res.on('end', () => {
            try {
              finish(undefined, { status: res.statusCode ?? 0, json: raw ? (JSON.parse(raw) as KubeLease) : undefined });
            } catch (e) {
              finish(e as Error);
            }
          });
          res.on('close', () => {
            if (!res.complete) finish(new Error('Lease API 응답이 도중에 끊겼다'));
          });
        });
        const overall = setTimeout(() => finish(new Error('Lease API 시간 초과')), timeoutMs);
        req.on('timeout', () => finish(new Error('Lease API 시간 초과')));
        req.on('error', (e) => finish(e));
        if (payload) req.write(payload);
        req.end();
      }),
    );
  // 마지막으로 받은 객체의 메타데이터(판별로). 고칠 때 그 판의 라벨·주석·소유자 참조를 그대로 싣는다(client-go LeaseLock과 같다)
  let kept: { resourceVersion: string; meta: Partial<KubeMeta> } | undefined;
  const remember = (l: KubeLease | undefined) => {
    const m = l?.metadata;
    if (!m?.resourceVersion) return;
    const meta: Partial<KubeMeta> = {};
    for (const k of KEPT_META) if (m[k] !== undefined) (meta as Record<string, unknown>)[k] = m[k];
    kept = { resourceVersion: m.resourceVersion, meta };
  };
  const lease = (spec: LeaseSpec, resourceVersion?: string) => ({
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: {
      ...(resourceVersion && kept?.resourceVersion === resourceVersion ? kept.meta : {}),
      name: o.name,
      namespace: o.namespace,
      ...(resourceVersion ? { resourceVersion } : {}),
    },
    spec,
  });
  const fail = (what: string, status: number) => new Error(`Lease ${what} 실패: HTTP ${status}`);
  return {
    async get() {
      const r = await call('GET', item);
      if (r.status === 404) return undefined;
      if (r.status !== 200 || !r.json) throw fail('읽기', r.status);
      remember(r.json);
      return toRecord(r.json);
    },
    async create(spec) {
      const r = await call('POST', collection, lease(spec));
      if (r.status === 409) return 'conflict';
      if ((r.status !== 201 && r.status !== 200) || !r.json) throw fail('만들기', r.status);
      remember(r.json);
      return toRecord(r.json);
    },
    async update(spec, resourceVersion) {
      const r = await call('PUT', item, lease(spec, resourceVersion));
      if (r.status === 409) return 'conflict';
      if (r.status !== 200 || !r.json) throw fail('고치기', r.status);
      remember(r.json);
      return toRecord(r.json);
    },
  };
}

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

/** 파드 안 설정으로 Lease API를 만든다(서비스 계정 토큰·CA·네임스페이스 파일). 실제 클러스터 확인은 BUILD_ORDER FND-110(kind) */
export function inClusterLeaseApi(name: string, env: Record<string, string | undefined> = process.env): LeaseApi {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) throw new Error('KUBERNETES_SERVICE_HOST가 없다(파드 밖)');
  const bracketed = host.includes(':') ? `[${host}]` : host;
  return kubernetesLeaseApi({
    baseUrl: `https://${bracketed}:${port}`,
    namespace: env.POD_NAMESPACE ?? readFileSync(`${SA}/namespace`, 'utf8').trim(),
    name,
    token: () => readFileSync(`${SA}/token`, 'utf8').trim(),
    ca: readFileSync(`${SA}/ca.crt`),
  });
}
