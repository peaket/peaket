// 옛 공개 앵커 서명 대상(BAT-465 R-584)의 바이트 꼴만 남긴다(ADR-0348 결정 4).
// API 프로세스의 Ed25519 서명기와 환경 값 PEAKET_AUDIT_ANCHOR_PRIVATE_KEY·PEAKET_AUDIT_ANCHOR_KEY_ID는 없앴다. 새 공개 체크포인트는
// 게시 작업만 ECDSA P-256(KMS)으로 서명한다(checkpoint-signer.ts). 0023 이전 옛 행(local·ci 자료뿐)은 공개 사슬 밖의 legacy로 보이고,
// 그 Ed25519 서명은 더 확인하지 않는다(키가 없다). 아래 함수는 옛 행을 따로 확인하려는 쪽이 꼴을 맞출 수 있게 둔다.

/** 옛 서명 대상 바이트의 판 */
export const AUDIT_ANCHOR_MESSAGE_VERSION = 'audit-checkpoint-v1';

export interface AuditAnchorTarget {
  readonly checkpointId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly rootHash: string;
  readonly prevCheckpointHash: string;
  readonly createdAtMs: number;
}

/** 옛 서명 대상: 판, 체크포인트 ID, 구간, 루트, 직전 루트, 만든 시각(ISO)을 줄바꿈으로 잇는다 */
export function auditAnchorMessage(t: AuditAnchorTarget): Buffer {
  return Buffer.from(
    [AUDIT_ANCHOR_MESSAGE_VERSION, t.checkpointId, String(t.fromSeq), String(t.toSeq), t.rootHash, t.prevCheckpointHash, new Date(t.createdAtMs).toISOString()].join('\n'),
    'utf8',
  );
}
