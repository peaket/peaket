// 준비 표시(openspec 변경 add-maintenance-control-and-consumers 결정 8, ADR-0103 결정 2, docs/architecture.md §5 '프로브 규칙', D-T29).
// 시작 작업은 listen 전에 등록하고, 모두 끝나야 관리 포트 /ready가 200이다. /ready는 이 표시만 읽고 의존성을 부르지 않는다(D-T19).
// 종료 중(SIGTERM 뒤)과 진단 수집 중(RB-31)도 같은 표시에 작업 이름으로 건다(BUILD_ORDER BAS-080, docs/devops.md §6.4).
/** Nest 주입 이름. createService가 전역으로 넣는다(모듈이 시작 작업을 걸고 끝낼 때 @Inject(READINESS)로 받는다) */
export const READINESS = Symbol.for('peaket.platform.readiness');

/** SIGTERM을 받은 뒤 거는 작업 이름(끝내지 않는다. 프로세스가 끝날 때까지 준비 상태가 아니다) */
export const READINESS_SHUTTING_DOWN = 'shutting-down';
/** 진단 수집(RB-31) 동안 거는 작업 이름 */
export const READINESS_DIAGNOSING = 'diagnosing';

export class Readiness {
  readonly #pending = new Set<string>();

  /** 시작 작업 하나를 건다(끝나기 전까지 준비 상태가 아니다) */
  register(task: string): void {
    this.#pending.add(task);
  }

  complete(task: string): void {
    this.#pending.delete(task);
  }

  isReady(): boolean {
    return this.#pending.size === 0;
  }

  pending(): string[] {
    return [...this.#pending].sort();
  }

  /** /ready 답의 status. 종료 중이 가장 앞이고, 그다음 진단 수집 중, 나머지는 시작 중이다 */
  status(): 'ready' | 'shutting-down' | 'diagnosing' | 'starting' {
    if (this.#pending.size === 0) return 'ready';
    if (this.#pending.has(READINESS_SHUTTING_DOWN)) return 'shutting-down';
    if (this.#pending.has(READINESS_DIAGNOSING)) return 'diagnosing';
    return 'starting';
  }
}
