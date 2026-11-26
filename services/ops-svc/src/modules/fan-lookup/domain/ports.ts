// ops-svc 팬 조회 접속기록 저장소(F-06-5, data.md admin_data_access).
export interface AdminDataAccessRow {
  readonly id: string;
  readonly adminAccountId: string;
  readonly actorRole: string;
  readonly action: string;
  readonly targetKind: string;
  readonly reason: string;
  readonly fields: string[];
  readonly sourceIp: string;
  readonly sourceService: string;
  readonly targetCount: number;
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
  readonly retainUntilMs: number;
}
export interface AdminDataAccessStore {
  append(row: AdminDataAccessRow): Promise<void>;
  rows?(): Array<Record<string, unknown>>;
  failNext?(): void;
}
