// 준비 표시(openspec 변경 add-maintenance-control-and-consumers 결정 8, ADR-0103 결정 2, docs/architecture.md §5 '프로브 규칙', D-T29).
// 시작 작업은 listen 전에 등록하고, 모두 끝나야 관리 포트 /ready가 200이다. /ready는 이 표시만 읽고 의존성을 부르지 않는다(D-T19).
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
}
