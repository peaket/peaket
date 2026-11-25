// F-04-13 시험 계약: 이 묶음의 오류 본문 type은 접두사 없는 이름이다.
// 다른 경로의 ProblemError(type URI)를 바꾸지 않도록 이 오류만 따로 만든다.
import { ProblemError } from '@peaket/platform';

export class BareProblemError extends ProblemError {
  constructor(type: string, status: number, title: string) {
    super({ type, status, title });
    Object.defineProperty(this, 'type', { value: type, enumerable: true, configurable: true, writable: true });
  }
}

export const bareProblem = (type: string, status: number, title: string): BareProblemError => new BareProblemError(type, status, title);

/** 도메인의 평범한 { type, status, message } 오류를 이 묶음의 bare 오류로 바꾼다. */
export const asBareProblem = (e: unknown): unknown => {
  if (e instanceof ProblemError) return e;
  if (e && typeof e === 'object' && 'type' in e && 'status' in e) {
    const p = e as { type: string; status: number; message?: string };
    if (typeof p.type === 'string' && typeof p.status === 'number') return bareProblem(p.type, p.status, p.message ?? p.type);
  }
  return e;
};
