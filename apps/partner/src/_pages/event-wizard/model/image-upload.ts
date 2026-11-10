// 등록 뒤 공연 이미지 올리기(ADR-0257 결정 4). 위저드가 [공연 등록]이 성공한 뒤에 늦게 싣는다(첫 화면 JS에 넣지 않는다).
// 포스터(첫 줄)부터 한 장씩 차례로 올리고 줄마다 결과를 알린다. 실패해도 등록은 되돌리지 않는다. 보내는 일(send)은 밖에서 받는다.
// - 상세 이미지의 order는 '그 줄보다 앞선 상세 줄 가운데 이미 올린 장수'다(앞 줄이 실패한 뒤 [다시 올리기]해도 서버 순서가 줄 차례와 같게).
// - 503·429에 다시 시도 하한(Retry-After)이 있으면 남은 장을 보내지 않고, 하한 × (1 + 0~20%) 뒤까지 [다시 올리기]를 잠근다(docs/frontend.md §4.1 '기다림').
// - 401이면 남은 장을 보내지 않고 로그인으로 보낼 줄임을 알린다(등록 경로와 같다).
import { IMAGE_TEXT, type ImageDraft, type ImageKind, uploadPlan, uploadProblemText } from './images.ts';

export interface UploadOutcome {
  key: string;
  kind: ImageKind;
  status: 'done' | 'error';
  message?: string;
  /** 이 시각(ms) 전에는 다시 올리지 않는다(서버가 준 하한) */
  retryAt?: number;
  /** 로그인이 끝났다(401) */
  unauthorized?: true;
}

export type SendImage = (productionId: string, item: { kind: ImageKind; alt: string; order?: number }, file: File) => Promise<unknown>;

/** 위쪽으로만 퍼뜨리는 폭(하한 × (1 + U(0, 0.2)), docs/frontend.md §4.1) */
const UPWARD_JITTER = 0.2;

function problemOf(e: unknown): { status: number; type: string; extensions: Record<string, unknown>; retryFloorMs?: number } {
  const p = typeof e === 'object' && e !== null ? (e as { status?: unknown; type?: unknown; extensions?: unknown; retryFloorMs?: unknown }) : {};
  return {
    status: typeof p.status === 'number' ? p.status : 0,
    type: typeof p.type === 'string' ? p.type : 'network',
    extensions: typeof p.extensions === 'object' && p.extensions !== null ? (p.extensions as Record<string, unknown>) : {},
    ...(typeof p.retryFloorMs === 'number' && Number.isFinite(p.retryFloorMs) && p.retryFloorMs >= 0 ? { retryFloorMs: p.retryFloorMs } : {}),
  };
}

export { canRetry } from './images.ts';

/** only를 주면 그 줄들만 다시 올린다([다시 올리기]). done은 이미 올린 줄 키다(order 계산). 파일이 없는 줄은 실패로 알린다 */
export async function uploadImages(o: {
  productionId: string;
  images: readonly ImageDraft[];
  fileOf: (key: string) => File | undefined;
  send: SendImage;
  only?: readonly string[];
  done?: readonly string[];
  now?: () => number;
  random?: () => number;
  onEach?: (r: UploadOutcome) => void;
}): Promise<UploadOutcome[]> {
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  const uploaded = new Set(o.done ?? []);
  const plan = uploadPlan(o.images);
  const out: UploadOutcome[] = [];
  const emit = (r: UploadOutcome) => {
    out.push(r);
    o.onEach?.(r);
  };
  /** 멈춘 뒤 남은 줄(보내지 않은 줄)에 붙일 결과 */
  let rest: Omit<UploadOutcome, 'key' | 'kind'> | undefined;
  for (const [i, item] of plan.entries()) {
    if (o.only && !o.only.includes(item.key)) continue;
    if (rest) {
      emit({ key: item.key, kind: item.kind, ...rest });
      continue;
    }
    const file = o.fileOf(item.key);
    if (!file) {
      emit({ key: item.key, kind: item.kind, status: 'error', message: IMAGE_TEXT.repick });
      continue;
    }
    const order = item.kind === 'DETAIL' ? plan.slice(0, i).filter((x) => x.kind === 'DETAIL' && uploaded.has(x.key)).length : undefined;
    try {
      await o.send(o.productionId, { kind: item.kind, alt: item.alt, ...(order !== undefined ? { order } : {}) }, file);
      uploaded.add(item.key);
      emit({ key: item.key, kind: item.kind, status: 'done' });
    } catch (e) {
      const p = problemOf(e);
      if (p.status === 401) {
        rest = { status: 'error', message: IMAGE_TEXT.failed, unauthorized: true };
        emit({ key: item.key, kind: item.kind, ...rest });
        continue;
      }
      const message = uploadProblemText(p);
      if ((p.status === 503 || p.status === 429) && p.retryFloorMs !== undefined) {
        const retryAt = now() + p.retryFloorMs * (1 + UPWARD_JITTER * random());
        emit({ key: item.key, kind: item.kind, status: 'error', message, retryAt });
        rest = { status: 'error', message: IMAGE_TEXT.unavailable, retryAt };
        continue;
      }
      emit({ key: item.key, kind: item.kind, status: 'error', message });
    }
  }
  return out;
}
