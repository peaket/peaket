// 수집 대상과 뜬 결과의 모양, 뜨기·올리기 포트(docs/observability.md §5 '진단 증거' 뜨는 것·올리기, 시험 D-T51 ①⑤⑥).
// 뜬 내용은 바이트로만 다루고 로그·지표에 싣지 않는다. 오류는 종류 이름(code)만 남긴다(오류 글에는 주소·비밀번호가 섞일 수 있다).

export type TargetKind = 'postgres' | 'redis';
export const TARGET_KINDS: readonly TargetKind[] = ['postgres', 'redis'];

/** 수집 대상 하나(PEAKET_EVIDENCE_TARGETS의 항목과 그 접속 주소) */
export interface EvidenceTarget {
  name: string;
  kind: TargetKind;
  url: string;
}

/** 종류마다 뜨는 파일 이름(manifest.json 말고) */
export const SNAPSHOT_FILES: Readonly<Record<TargetKind, readonly string[]>> = {
  postgres: ['pg-activity.json', 'pg-blocking.json', 'pg-replication-slots.json'],
  redis: ['redis-info.txt', 'redis-slowlog.json', 'redis-client-list.txt'],
};
export const MANIFEST_FILE = 'manifest.json';

export interface SnapshotFile {
  name: string;
  body: Uint8Array;
  contentType: string;
}

export interface SnapshotError {
  /** 뜨지 못한 파일 이름 */
  file: string;
  /** 오류 종류 이름(빈칸 없는 64자 이하, 오류 글 없음) */
  code: string;
}

/** 한 대상을 뜬 결과. 접속하지 못했으면 connected false이고 files가 비며 errors가 파일마다 있다 */
export interface Snapshot {
  connected: boolean;
  files: SnapshotFile[];
  errors: SnapshotError[];
}

/** 의존성의 순간 상태를 뜨는 포트(종류마다 어댑터 하나). 던지지 않고 Snapshot으로 답한다 */
export interface SnapshotSource {
  snapshot(target: EvidenceTarget): Promise<Snapshot>;
}

/** 진단 증거 저장소의 바이트 올리기 포트(@peaket/platform EvidenceBytesStore와 같은 모양). 실패하면 던진다 */
export interface EvidenceObjectStore {
  putBytes(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** 오류에서 종류 이름만 꺼낸다: 꼴이 맞는 code(ECONNREFUSED·SQLSTATE 등), Redis 오류 답의 첫 낱말(NOPERM 등), 그 밖은 fallback */
export function errorCode(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
    const message = (err as { message?: unknown }).message;
    const first = typeof message === 'string' ? /^([A-Z][A-Z0-9_]{1,31})\b/.exec(message)?.[1] : undefined;
    if (first) return first;
  }
  return fallback;
}

/** 수집 시각(UTC 밀리초 ISO)과 대상으로 객체 이름을 만든다: evidence-collector/<대상>/<시각>/<파일> */
export function objectKey(prefix: string, target: string, collectedAt: string, file: string): string {
  return `${prefix}/${target}/${collectedAt}/${file}`;
}
