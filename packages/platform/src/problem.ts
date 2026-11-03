// RFC 9457 Problem Details(docs/api/guidelines.md §2, openspec 변경 add-service-template 결정 3).
// 코드는 ProblemError를 던지고, 전역 필터(problem-filter.ts)가 application/problem+json 본문으로 바꾼다.
export const PROBLEM_TYPE_BASE = 'https://peaket.example/problems/';
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
/** 확장 필드가 덮으면 안 되는 칸(표준 칸과 공용 확장) */
export const RESERVED_PROBLEM_MEMBERS = ['type', 'title', 'status', 'detail', 'instance', 'traceId', 'debug'] as const;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ProblemInit {
  /** 오류 이름(케밥 표기, 예 seat-already-held). type URI의 마지막 경로가 된다 */
  type: string;
  /** 4xx·5xx */
  status: number;
  /** 같은 type이면 늘 같은 제목(번역만 다르다, guidelines §2) */
  title: string;
  detail?: string;
  /** 그 응답에만 싣는 확장 필드(openapi의 Problem 확장 칸) */
  extensions?: Record<string, unknown>;
  /** 업무상 정상 분기(예: 좌석 경합 409). 오류가 아니라 정상 분기 카운터로 센다(guidelines §2, NFR-003) */
  normalBranch?: boolean;
  /** Retry-After 머리(초, guidelines §2·§5) */
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class ProblemError extends Error {
  readonly type: string;
  readonly slug: string;
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly normalBranch: boolean;
  readonly retryAfterSeconds?: number;

  constructor(init: ProblemInit) {
    super(init.detail ?? init.title, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ProblemError';
    if (!SLUG.test(init.type)) throw new Error(`Problem 이름은 케밥 표기여야 한다: ${init.type}`);
    if (!Number.isInteger(init.status) || init.status < 400 || init.status > 599) {
      throw new Error(`Problem 상태 코드는 4xx·5xx여야 한다: ${init.status}`);
    }
    if (!init.title) throw new Error('Problem 제목이 비었다');
    const extensions = { ...(init.extensions ?? {}) };
    for (const k of Object.keys(extensions)) {
      if ((RESERVED_PROBLEM_MEMBERS as readonly string[]).includes(k)) throw new Error(`확장 필드가 표준 칸을 덮는다: ${k}`);
    }
    if (init.retryAfterSeconds !== undefined && !(Number.isInteger(init.retryAfterSeconds) && init.retryAfterSeconds >= 0)) {
      throw new Error(`Retry-After는 0 이상의 정수(초)여야 한다: ${init.retryAfterSeconds}`);
    }
    this.slug = init.type;
    this.type = `${PROBLEM_TYPE_BASE}${init.type}`;
    this.status = init.status;
    this.title = init.title;
    this.detail = init.detail;
    this.extensions = Object.freeze(extensions);
    this.normalBranch = init.normalBranch === true;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** 남은 시간이 모자라 시작하지 않았다(guidelines §5, 결정 4) */
export function deadlineExceeded(): ProblemError {
  return new ProblemError({ type: 'deadline-exceeded', status: 504, title: '남은 처리 시간이 모자라 요청을 끝내지 못했습니다' });
}

/**
 * 자기 과부하(연결 풀 대기 초과, 벌크헤드 가득)로 기다리지 않고 거절한다. 429와 Retry-After 1초 [가정].
 * 이상 파드 퇴출에 세어지지 않게 503을 쓰지 않는다(guidelines §2, architecture §5, 기술 검토 낮음-140)
 */
export function serverBusy(cause?: unknown): ProblemError {
  return new ProblemError({ type: 'server-busy', status: 429, title: '요청이 많아 잠시 처리하지 못했습니다', retryAfterSeconds: 1, cause });
}
