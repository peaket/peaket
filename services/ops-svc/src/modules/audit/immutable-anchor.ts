// 감사 체크포인트의 옛 외부 앵커 경계(BAT-465 잔여, ADR-0171). 늘 503/보류로 막는 껍데기라 부르는 쪽이 없다.
// 공개 체크포인트의 실제 게시·공개 타임스탬프는 게시 작업 audit-anchor(publisher.ts)가 public-store.ts(두 버킷)·ots.ts(캘린더)로 한다(ADR-0348 결정 5·6).
// 이 파일은 옛 계약(시험)을 위해 남기고, API 프로세스와 게시 작업은 이것을 쓰지 않는다.
import { createHash } from 'node:crypto';
import { ProblemError } from '@peaket/platform';

export interface AnchorInput {
  checkpointId: string;
  rootHash: string;
  signature?: string | undefined;
  keyId?: string | undefined;
  createdAtMs: number;
}

export interface AnchorResult {
  ref: string;
  /** 외부 저장소가 없어 로컬 앵커만 남았는가 */
  localOnly: boolean;
}

export interface ImmutableAnchorStore {
  readonly kind: 'S3_OBJECT_LOCK' | 'MEMORY';
  put(input: AnchorInput): Promise<AnchorResult>;
  verify(ref: string): Promise<boolean>;
}

export interface OpenTimestampsAnchor {
  readonly kind: 'OPEN_TIMESTAMPS' | 'MEMORY';
  stamp(input: AnchorInput): Promise<AnchorResult>;
  verify(ref: string): Promise<boolean>;
}

const unavailable = (what: string): never => {
  throw new ProblemError({ type: 'anchor-unavailable', status: 503, title: `${what} 앵커를 지금 쓸 수 없습니다` });
};

/** S3 Object Lock 어댑터. 버킷·리전·자격 증명이 없으면 put·verify 모두 503이다(로컬 앵커는 그대로 남는다). */
export class S3ObjectLockAnchorStore implements ImmutableAnchorStore {
  readonly kind = 'S3_OBJECT_LOCK' as const;
  constructor(private readonly config: { bucket?: string | undefined; region?: string | undefined; endpoint?: string | undefined } = {}) {}
  async put(input: AnchorInput): Promise<AnchorResult> {
    if (!this.config.bucket || !this.config.region) unavailable('S3 Object Lock');
    // AWS SDK를 더하지 않고 계약만 둔다. 실제 PUT·Object Lock 보존은 자격 증명이 있는 배포 단계다.
    void input;
    return unavailable('S3 Object Lock');
  }
  async verify(ref: string): Promise<boolean> {
    void ref;
    return unavailable('S3 Object Lock');
  }
}

/** OpenTimestamps 어댑터. 달력 서버·비트코인 노드가 없으면 stamp·verify 모두 503이다. */
export class OpenTimestampsAnchorAdapter implements OpenTimestampsAnchor {
  readonly kind = 'OPEN_TIMESTAMPS' as const;
  constructor(private readonly config: { calendarUrl?: string | undefined } = {}) {}
  async stamp(input: AnchorInput): Promise<AnchorResult> {
    if (!this.config.calendarUrl) unavailable('OpenTimestamps');
    void input;
    return unavailable('OpenTimestamps');
  }
  async verify(ref: string): Promise<boolean> {
    void ref;
    return unavailable('OpenTimestamps');
  }
}

/** 시험·개발용 불변 저장소. 같은 입력이면 같은 참조를 준다. */
export class MemoryImmutableAnchorStore implements ImmutableAnchorStore {
  readonly kind = 'MEMORY' as const;
  readonly rows = new Map<string, AnchorInput>();
  async put(input: AnchorInput): Promise<AnchorResult> {
    const ref = `memory:s3:${input.checkpointId}:${createHash('sha256').update(input.rootHash).digest('hex').slice(0, 16)}`;
    this.rows.set(ref, input);
    return { ref, localOnly: false };
  }
  async verify(ref: string): Promise<boolean> {
    return this.rows.has(ref);
  }
}

/** 시험·개발용 OpenTimestamps. */
export class MemoryOpenTimestampsAnchor implements OpenTimestampsAnchor {
  readonly kind = 'MEMORY' as const;
  readonly rows = new Set<string>();
  async stamp(input: AnchorInput): Promise<AnchorResult> {
    const ref = `memory:ots:${input.checkpointId}`;
    this.rows.add(ref);
    return { ref, localOnly: false };
  }
  async verify(ref: string): Promise<boolean> {
    return this.rows.has(ref);
  }
}

/**
 * 체크포인트 하나를 두 외부 앵커에 남긴다. 하나라도 실패하면 그 사실을 결과에 적고 로컬 앵커를 유지한다.
 * 호출하는 쪽(정비 일·명령 실행)은 실패를 승인·명령 실패로 바꾸지 않는다(감사 체인은 이미 커밋됐다).
 */
export async function anchorCheckpoint(input: AnchorInput, deps: { immutable?: ImmutableAnchorStore | undefined; ots?: OpenTimestampsAnchor | undefined }): Promise<{ immutable?: AnchorResult; ots?: AnchorResult; localOnly: boolean; errors: string[] }> {
  const errors: string[] = [];
  let immutable: AnchorResult | undefined;
  let ots: AnchorResult | undefined;
  if (deps.immutable) {
    try {
      immutable = await deps.immutable.put(input);
    } catch (e) {
      errors.push(`immutable:${e instanceof Error ? e.name : 'error'}`);
    }
  }
  if (deps.ots) {
    try {
      ots = await deps.ots.stamp(input);
    } catch (e) {
      errors.push(`ots:${e instanceof Error ? e.name : 'error'}`);
    }
  }
  return { ...(immutable ? { immutable } : {}), ...(ots ? { ots } : {}), localOnly: !immutable || immutable.localOnly, errors };
}
