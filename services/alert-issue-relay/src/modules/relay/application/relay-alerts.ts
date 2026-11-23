// 유스케이스: SEV3 경보를 GitHub 티켓 하나로 만들고, 해제 때 댓글을 달고 닫는다.
// 정본: docs/observability.md §5 '경보 보내는 길' 티켓 중계(같은 지문은 열린 티켓 하나, 해제는 댓글과 닫기, 실패는 502로 다시 받기),
// V-T53 ④. 같은 지문을 동시에 받아도 하나만 열리게 파드 안에서 지문마다 차례로 처리한다(복제 1).
import { maskPiiText } from '@peaket/platform';
import { isTicketAlert, resolvedComment, type AlertInput, type IssueRef } from '../domain/alert.js';
import type { GitHubIssuesPort } from '../domain/github-issues.js';

export type Decision = 'created' | 'duplicate' | 'closed' | 'ignored';
export const DECISIONS: readonly Decision[] = ['created', 'duplicate', 'closed', 'ignored'];

export interface RelaySignals {
  decision(d: Decision): void;
}

export class RelayAlerts {
  readonly #github: GitHubIssuesPort;
  readonly #signals: RelaySignals;
  /** 지문마다의 처리 사슬(같은 지문의 동시 요청을 차례로) */
  readonly #chains = new Map<string, Promise<void>>();
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(o: { github: GitHubIssuesPort; signals: RelaySignals }) {
    this.#github = o.github;
    this.#signals = o.signals;
  }

  /** 받은 경보를 모두 처리한 뒤 받은 수를 돌려준다. GitHub 실패는 GitHubUnavailable로 올린다 */
  async receive(alerts: AlertInput[]): Promise<number> {
    const job = this.#process(alerts);
    this.#inFlight.add(job);
    try {
      await job;
      return alerts.length;
    } finally {
      this.#inFlight.delete(job);
    }
  }

  /** 지금까지 받은 웹훅의 GitHub 호출이 모두 끝나면 풀린다 */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
  }

  async #process(alerts: AlertInput[]): Promise<void> {
    for (const alert of alerts) await this.#handle(alert);
  }

  async #handle(alert: AlertInput): Promise<void> {
    if (!isTicketAlert(alert)) {
      this.#signals.decision('ignored');
      return;
    }
    await this.#withLock(alert.fingerprint, async () => {
      const open = await this.#github.findOpen(alert.fingerprint);
      if (alert.status === 'resolved') {
        if (!open) {
          this.#signals.decision('ignored');
          return;
        }
        await this.#github.comment(open, resolvedComment(alert, maskPiiText));
        await this.#github.close(open);
        this.#signals.decision('closed');
        return;
      }
      if (open) {
        this.#signals.decision('duplicate');
        return;
      }
      await this.#github.create(alert);
      this.#signals.decision('created');
    });
  }

  /** 같은 지문의 처리를 앞선 것이 끝난 뒤에 시작한다. 사슬은 실패해도 풀린다 */
  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => gate);
    this.#chains.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#chains.get(key) === tail) this.#chains.delete(key);
    }
  }
}

export type { IssueRef };
