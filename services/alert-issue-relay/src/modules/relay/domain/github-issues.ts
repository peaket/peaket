// GitHub Issues 포트와 실패 표시(응용 층이 어댑터를 직접 모르게 한다). 정본: docs/observability.md §5 티켓 중계.
import type { AlertInput, IssueRef } from '../domain/alert.js';

/** GitHub 호출이 실패했다(무응답·5xx·401 다시 받기 뒤에도 실패·429). 웹훅은 502로 답해 Alertmanager가 다시 보내게 한다 */
export class GitHubUnavailable extends Error {
  override name = 'GitHubUnavailable';
}

export interface GitHubIssuesPort {
  /** 열린 경보 티켓 가운데 본문에 그 지문 줄이 있는 것(쪽을 끝까지 읽는다). 없으면 null */
  findOpen(fingerprint: string): Promise<IssueRef | null>;
  create(alert: AlertInput): Promise<IssueRef>;
  comment(issue: IssueRef, body: string): Promise<void>;
  close(issue: IssueRef): Promise<void>;
}
