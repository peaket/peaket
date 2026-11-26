// F-04-16 replay-export 받기·응답 계약·파일 봉투 검사. 정본: docs/features/forensic-replay.md §4.2·§6.3·§6.5·§6.7.1·§6.8,
// docs/api/openapi.yaml GET /v1/ops/fraud-cases/{caseId}/replay-export·GET /v1/ops/research-exports/{exportId}.
// Arrow 열 해독은 F-04-17 몫이고, 이 파일은 받은 파일의 봉투·스키마·원천 대조와 오류 문구까지만 맡는다.
import {
  MAX_FILE_BYTES,
  validateFile,
  type EventColumns,
  type ForensicMeta,
  type SchemaColumn,
  type Validation,
} from './forensics/events.ts';
import type { OpenTarget, OpenedSource } from './operating.ts';

export const ARROW_MAGIC = 'ARROW1' as const;
export const REPLAY_MEDIA_TYPE = 'application/vnd.apache.arrow.file' as const;
export const REPLAY_WINDOW_MS = 1_800_000;
/** 응답에는 파일 이름이 없다. 검증기 안에서만 쓰는 고정 이름이고 화면·내려받기에는 쓰지 않는다. */
const REPLAY_FILE_NAME = 'replay.arrow';

export interface ReplayEnvelope {
  byteLength: number;
  head: string;
  tail: string;
}

export interface ReplayFileInput {
  envelope: ReplayEnvelope;
  meta: ForensicMeta;
  schema: readonly SchemaColumn[];
  columns: EventColumns;
}

export interface ReplayWindow {
  fromMs?: number;
  toMs?: number;
}

export interface ReplayProblem {
  kind: 'auth' | 'denied' | 'review-pending' | 'reauth' | 'not-found' | 'not-ready' | 'expired' | 'invalid' | 'limited' | 'unavailable' | 'error';
  message: string;
  retry: boolean;
}

export interface ReplayOperation {
  operationId: 'getOpsFraudCaseReplayExport' | 'getOpsResearchExport';
  params: Record<string, string>;
  query: Record<string, number>;
}

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

export function replayEnvelopeOf(bytes: Uint8Array): ReplayEnvelope {
  return { byteLength: bytes.byteLength, head: ascii(bytes.slice(0, 6)), tail: ascii(bytes.slice(-6)) };
}

export function replayFileIssue(e: ReplayEnvelope): string | undefined {
  if (!Number.isInteger(e.byteLength) || e.byteLength < 12) return '앞뒤 매직 ARROW1이 없습니다(파일이 너무 짧습니다)';
  if (e.byteLength > MAX_FILE_BYTES) return '파일 크기가 200MB를 넘습니다';
  if (e.head !== ARROW_MAGIC || e.tail !== ARROW_MAGIC) return '앞뒤 매직 ARROW1이 없습니다';
  return undefined;
}

function header(headers: Headers | Record<string, string>, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return null;
}

export function replayHeadersIssue(status: number, headers: Headers | Record<string, string>): string | undefined {
  if (status !== 200) return undefined;
  const type = header(headers, 'content-type');
  if (type === null || !type.toLowerCase().startsWith(REPLAY_MEDIA_TYPE)) return '응답이 Arrow 파일 형식이 아닙니다';
  const cache = header(headers, 'cache-control');
  if (cache === null || !/(^|,)\s*no-store\s*(,|$)/i.test(cache)) return '응답에 Cache-Control: no-store가 없습니다';
  if (header(headers, 'content-disposition') !== null) return '응답에 Content-Disposition이 있습니다(내려받기 금지)';
  const length = header(headers, 'content-length');
  if (length !== null) {
    const n = Number(length);
    if (!Number.isSafeInteger(n) || n < 0) return 'Content-Length가 올바르지 않습니다';
    if (n > MAX_FILE_BYTES) return '파일 크기가 200MB를 넘습니다(Content-Length)';
  }
  return undefined;
}

export function replayFileValidation(file: ReplayFileInput, t: OpenTarget): Validation {
  return validateFile({
    meta: file.meta,
    schema: file.schema,
    columns: file.columns,
    envelope: {
      fileName: REPLAY_FILE_NAME,
      byteLength: file.envelope.byteLength,
      magicHead: file.envelope.head,
      magicTail: file.envelope.tail,
    },
    openedSource: t.source,
  });
}

export function replayProblem(status: number, type: string | null | undefined, source: OpenedSource): ReplayProblem {
  if (status === 401) return { kind: 'auth', message: '로그인이 필요합니다', retry: false };
  if (status === 403) {
    if (type === 'reauth-required') return { kind: 'reauth', message: '다시 인증해 주세요', retry: false };
    if (type === 'pseudonym-handler-required') return { kind: 'denied', message: '가명정보 취급자만 할 수 있습니다', retry: false };
    if (type === 'pseudonymization-review-pending') return { kind: 'review-pending', message: '가명 처리 검토 중입니다', retry: false };
    return { kind: 'denied', message: '부정 거래 조사관만 할 수 있습니다', retry: false };
  }
  if (status === 404) return { kind: 'not-found', message: '찾을 수 없습니다', retry: false };
  if (status === 409) return { kind: 'not-ready', message: '연구용 내보내기를 아직 만드는 중입니다', retry: true };
  if (status === 410) {
    return {
      kind: 'expired',
      message:
        source === 'INVESTIGATION'
          ? '이 회차의 조사용 기록은 보존 기간이 지났습니다. 증거 묶음만 볼 수 있습니다'
          : '이 회차의 가명 기록은 보존 기간(90일)이 지났습니다',
      retry: false,
    };
  }
  if (status === 422) return { kind: 'invalid', message: '시간창이 올바르지 않습니다', retry: false };
  if (status === 429) return { kind: 'limited', message: '오늘은 더 열 수 없습니다', retry: false };
  if (status === 503) return { kind: 'unavailable', message: '잠시 뒤 다시 시도해 주세요', retry: true };
  return { kind: 'error', message: '기록을 받지 못했습니다', retry: false };
}

export function replayOperation(t: OpenTarget, w?: ReplayWindow): ReplayOperation {
  if (t.source === 'RESEARCH') {
    if (w !== undefined) throw new TypeError('연구 내보내기는 만들 때 시간창을 정한다');
    return { operationId: 'getOpsResearchExport', params: { exportId: t.exportId! }, query: {} };
  }
  const query: Record<string, number> = {};
  if (w?.fromMs !== undefined) query.fromMs = w.fromMs;
  if (w?.toMs !== undefined) query.toMs = w.toMs;
  return { operationId: 'getOpsFraudCaseReplayExport', params: { caseId: t.caseId! }, query };
}

export function replayWindowIssue(w: ReplayWindow): string | undefined {
  const hasFrom = w.fromMs !== undefined;
  const hasTo = w.toMs !== undefined;
  if (hasFrom !== hasTo) return '시간창은 시작과 끝을 함께 적어야 합니다';
  if (!hasFrom) return undefined;
  if (!Number.isSafeInteger(w.fromMs) || !Number.isSafeInteger(w.toMs)) return '시간창은 밀리초 정수여야 합니다';
  if (w.toMs! <= w.fromMs!) return '시간창 끝은 시작보다 뒤여야 합니다';
  if (w.toMs! - w.fromMs! > REPLAY_WINDOW_MS) return '시간창은 30분 이하여야 합니다';
  return undefined;
}
