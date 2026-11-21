// 받는 층: 감사 체크포인트 생성·목록·상세·검증·검증 묶음(openapi /v1/ops/audit-checkpoints, BAT-465 GAT-310, ADR-0348 결정 8·12)과
// 세션 없는 공개 앵커(/v1/ops/audit-anchors). 공개 행의 서명은 게시 작업만 채우고, 이 프로세스는 저장된 공개키로 확인만 한다.
import { Controller, Get, Header, HttpCode, Post, Req } from '@nestjs/common';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditCheckpointService, isLegacyCheckpoint, isPublicCheckpoint, type AuditCheckpoint, type AuditCheckpointVerification } from '../checkpoint.js';
import { CHECKPOINT_SIGNATURE_ALG } from '../checkpoint-signer.js';

const CheckpointIdParams = z.object({ checkpointId: z.uuid() }).strict();
const CreateBody = z.object({ reason: z.string().min(1).max(500) }).strict();
/** 사유: 앞뒤 공백을 지우고 NFC로 한 번 정규화한 뒤 1~2,000자, 제어 문자·양방향 제어 문자 없음(명령 사유와 같은 규칙, ASVS 1.3.3) */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI = /[‪-‮⁦-⁩]/;
const BundleReason = z
  .string()
  .min(1)
  .max(2000)
  .transform((s) => s.trim().normalize('NFC'))
  .refine((s) => s.length >= 1 && s.length <= 2000 && !CONTROL.test(s) && !BIDI.test(s), { message: 'reason' });
const BundleBody = z.object({ seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), reason: BundleReason }).strict();
const KindEnum = z.enum(['DAILY', 'EVENT_CLOSE', 'MANUAL', 'EXECUTION']);
const OtsStateEnum = z.enum(['PENDING', 'COMPLETE']);
const CheckpointView = z.object({
  checkpointId: z.string(),
  fromSeq: z.number(),
  toSeq: z.number(),
  rootHash: z.string(),
  prevCheckpointHash: z.string(),
  reason: z.string(),
  actorRef: z.string(),
  createdAt: z.string(),
  signature: z.string().nullable().optional(),
  keyId: z.string().nullable().optional(),
  anchorRef: z.string().nullable().optional(),
  anchoredAt: z.string().nullable().optional(),
  no: z.number().nullable(),
  kind: KindEnum.nullable(),
  leafCount: z.number().nullable(),
  merkleRoot: z.string().nullable(),
  checkpointHash: z.string().nullable(),
  signatureAlg: z.literal(CHECKPOINT_SIGNATURE_ALG).nullable(),
  otsState: OtsStateEnum.nullable(),
  publishedAt: z.string().nullable(),
  legacy: z.boolean(),
});
const CheckpointPage = z.object({ items: z.array(CheckpointView), nextCursor: z.string().nullable() });
const VerificationView = z.object({
  checkpointId: z.string(),
  valid: z.boolean(),
  rootValid: z.boolean(),
  prevValid: z.boolean(),
  signatureValid: z.boolean(),
  anchorValid: z.boolean(),
  fromSeq: z.number(),
  toSeq: z.number(),
  checkedAt: z.string(),
  no: z.number().nullable(),
  kind: KindEnum.nullable(),
  legacy: z.boolean(),
  signed: z.boolean(),
  checkpointHash: z.string().nullable(),
  otsState: OtsStateEnum.nullable(),
  publishedAt: z.string().nullable(),
});
const AnchorView = z.object({
  checkpointId: z.string(),
  fromSeq: z.number(),
  toSeq: z.number(),
  rootHash: z.string(),
  prevCheckpointHash: z.string(),
  createdAt: z.string(),
  signature: z.string().nullable(),
  keyId: z.string().nullable(),
  anchorRef: z.string().nullable(),
  anchoredAt: z.string().nullable(),
  algorithm: z.enum(['Ed25519', CHECKPOINT_SIGNATURE_ALG]),
  publicKey: z.string(),
  no: z.number().nullable(),
  kind: KindEnum.nullable(),
  leafCount: z.number().nullable(),
  merkleRoot: z.string().nullable(),
  checkpointHash: z.string().nullable(),
  checkpointJson: z.string().nullable(),
  signatureAlg: z.literal(CHECKPOINT_SIGNATURE_ALG).nullable(),
  otsState: OtsStateEnum.nullable(),
  publishedAt: z.string().nullable(),
  legacy: z.boolean(),
});
const BundleView = z.object({
  version: z.literal(1),
  checkpoint: z.object({
    no: z.number(),
    checkpointId: z.string(),
    json: z.string(),
    checkpointHash: z.string(),
    signature: z.string(),
    keyId: z.string(),
    signatureAlg: z.string(),
    publicKeyPem: z.string(),
    otsProof: z.string().nullable(),
  }),
  record: z.object({ seq: z.number(), recordJson: z.string(), prevHash: z.string(), recordSha256: z.string(), leafSalt: z.string() }),
  inclusionProof: z.object({ leafIndex: z.number(), treeSize: z.number(), path: z.array(z.string()) }),
});

const iso = (ms: number | undefined): string | null => (ms !== undefined ? new Date(ms).toISOString() : null);

/** 공개 행의 새 칸(옛 행·내부 행은 비거나 legacy 참) */
const publicFieldsOf = (c: AuditCheckpoint) => {
  const isPublic = isPublicCheckpoint(c);
  return {
    no: c.no ?? null,
    kind: c.kind ?? null,
    leafCount: c.leafCount ?? null,
    merkleRoot: isLegacyCheckpoint(c) ? null : c.rootHash,
    checkpointHash: c.checkpointHash ?? null,
    signatureAlg: isPublic ? CHECKPOINT_SIGNATURE_ALG : null,
    otsState: c.otsState ?? null,
    publishedAt: iso(c.publishedAtMs),
    legacy: isLegacyCheckpoint(c),
  } as const;
};

export const checkpointViewOf = (c: AuditCheckpoint): z.output<typeof CheckpointView> => ({
  checkpointId: c.checkpointId,
  fromSeq: c.fromSeq,
  toSeq: c.toSeq,
  rootHash: c.rootHash,
  prevCheckpointHash: c.prevCheckpointHash,
  reason: c.reason,
  actorRef: c.actorRef,
  createdAt: new Date(c.createdAtMs).toISOString(),
  ...(c.signature !== undefined ? { signature: c.signature } : {}),
  ...(c.keyId !== undefined ? { keyId: c.keyId } : {}),
  ...(c.anchorRef !== undefined ? { anchorRef: c.anchorRef } : {}),
  ...(c.anchoredAtMs !== undefined ? { anchoredAt: new Date(c.anchoredAtMs).toISOString() } : {}),
  ...publicFieldsOf(c),
});

const verificationViewOf = (v: AuditCheckpointVerification): z.output<typeof VerificationView> => ({
  checkpointId: v.checkpointId,
  valid: v.valid,
  rootValid: v.rootValid,
  prevValid: v.prevValid,
  signatureValid: v.signatureValid,
  anchorValid: v.anchorValid,
  fromSeq: v.fromSeq,
  toSeq: v.toSeq,
  checkedAt: new Date(v.checkedAtMs).toISOString(),
  no: v.no ?? null,
  kind: v.kind ?? null,
  legacy: v.legacy,
  signed: v.signed,
  checkpointHash: v.checkpointHash ?? null,
  otsState: v.otsState ?? null,
  publishedAt: iso(v.publishedAtMs),
});

@Controller('v1/ops/audit-checkpoints')
export class AuditCheckpointsController {
  constructor(private readonly checkpoints: AuditCheckpointService) {}

  @Post()
  @HttpCode(201)
  @Roles(['commander'])
  @ContractRouteSchema({ body: CreateBody, responses: { 201: CheckpointView } })
  async create(@ContractBody(CreateBody) body: z.output<typeof CreateBody>, @CurrentPrincipal() me: Principal): Promise<z.output<typeof CheckpointView>> {
    // 체크포인트는 7년 보존이고 누구나(viewer도) 목록에서 본다: 관리 계정 ID 대신 그때의 역할 이름만 남긴다(ADR-0149 결정 4, BAT-355 리뷰 RV-02)
    // 수동 체크포인트는 공개 사슬에 들고, 서명·게시는 다음 게시 작업 실행이 한다(ADR-0348 결정 1)
    return checkpointViewOf(await this.checkpoints.create({ reason: body.reason, actorRef: me.role ?? 'commander', kind: 'MANUAL' }));
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ responses: { 200: CheckpointPage } })
  async list(@Req() request: FastifyRequest): Promise<z.output<typeof CheckpointPage>> {
    const raw = (request.query as Record<string, unknown>).limit;
    const limit = typeof raw === 'string' ? Number(raw) : 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ProblemError({ type: 'invalid-query', status: 400, title: '목록 조건이 올바르지 않습니다' });
    const items = await this.checkpoints.list(limit);
    return { items: items.map(checkpointViewOf), nextCursor: null };
  }

  @Get(':checkpointId')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ params: CheckpointIdParams, responses: { 200: CheckpointView } })
  async detail(@ContractParams(CheckpointIdParams) params: z.output<typeof CheckpointIdParams>): Promise<z.output<typeof CheckpointView>> {
    return checkpointViewOf(await this.checkpoints.get(params.checkpointId));
  }

  @Get(':checkpointId/verification')
  @Header('Cache-Control', 'no-store')
  @Roles(['viewer', 'operator', 'commander'])
  @ContractRouteSchema({ params: CheckpointIdParams, responses: { 200: VerificationView } })
  async verify(@ContractParams(CheckpointIdParams) params: z.output<typeof CheckpointIdParams>): Promise<z.output<typeof VerificationView>> {
    return verificationViewOf(await this.checkpoints.verify(params.checkpointId));
  }

  /**
   * 검증 묶음(ADR-0348 결정 8): 잎 솔트가 실리는 외부 제공 자료라 commander만(viewer·operator는 403). 내보내기는 감사 기록 AUDIT_BUNDLE_EXPORTED로 남는다.
   * 서명 전·옛 행은 409 checkpoint-not-ready, 구간 밖 seq는 422 seq-not-in-checkpoint다. 응답은 저장하지 않는다(no-store)
   */
  @Post(':checkpointId/verification-bundles')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Roles(['commander'])
  @ContractRouteSchema({ params: CheckpointIdParams, body: BundleBody, responses: { 201: BundleView } })
  async bundle(
    @ContractParams(CheckpointIdParams) params: z.output<typeof CheckpointIdParams>,
    @ContractBody(BundleBody) body: z.output<typeof BundleBody>,
    @CurrentPrincipal() me: Principal,
  ): Promise<z.output<typeof BundleView>> {
    const b = await this.checkpoints.exportBundle({ checkpointId: params.checkpointId, seq: body.seq, reason: body.reason, actorAdminAccountId: me.accountId, actorRole: me.role ?? 'commander' });
    return { version: b.version, checkpoint: { ...b.checkpoint }, record: { ...b.record }, inclusionProof: { ...b.inclusionProof, path: [...b.inclusionProof.path] } };
  }
}

/**
 * 공개 앵커(ADR-0075, ADR-0348 결정 12): 체크포인트 칸·서명·공개키를 세션 없이 내준다.
 * 새 공개 행은 ECDSA P-256 서명(DER base64, 대상은 checkpointJson 바이트)과 그 키의 SPKI PEM, 옛 행은 Ed25519(공개키 없음, 빈 글)다.
 * 서명 전이면 signature·keyId가 null이고 publicKey는 빈 글이다. 감사 체인 구간을 다시 모은 검증은 같은 경로의 /verification이 한다.
 */
@Controller('v1/ops/audit-anchors')
export class AuditAnchorsController {
  constructor(private readonly checkpoints: AuditCheckpointService) {}

  @Get(':checkpointId')
  @Header('Cache-Control', 'no-store')
  @Roles(['public'])
  @ContractRouteSchema({ params: CheckpointIdParams, responses: { 200: AnchorView } })
  async anchor(@ContractParams(CheckpointIdParams) params: z.output<typeof CheckpointIdParams>): Promise<z.output<typeof AnchorView>> {
    const c = await this.checkpoints.get(params.checkpointId);
    const pem = await this.checkpoints.publicKeyPemOf(c);
    return {
      checkpointId: c.checkpointId,
      fromSeq: c.fromSeq,
      toSeq: c.toSeq,
      rootHash: c.rootHash,
      prevCheckpointHash: c.prevCheckpointHash,
      createdAt: new Date(c.createdAtMs).toISOString(),
      signature: c.signature ?? null,
      keyId: c.keyId ?? null,
      anchorRef: c.anchorRef ?? null,
      anchoredAt: iso(c.anchoredAtMs),
      algorithm: isLegacyCheckpoint(c) ? 'Ed25519' : CHECKPOINT_SIGNATURE_ALG,
      publicKey: pem ?? '',
      checkpointJson: c.checkpointJson ?? null,
      ...publicFieldsOf(c),
    };
  }

  @Get(':checkpointId/verification')
  @Header('Cache-Control', 'no-store')
  @Roles(['public'])
  @ContractRouteSchema({ params: CheckpointIdParams, responses: { 200: VerificationView } })
  async verify(@ContractParams(CheckpointIdParams) params: z.output<typeof CheckpointIdParams>): Promise<z.output<typeof VerificationView>> {
    return verificationViewOf(await this.checkpoints.verify(params.checkpointId));
  }
}
