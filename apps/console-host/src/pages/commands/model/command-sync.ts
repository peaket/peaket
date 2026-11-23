// SCR-030 명령 목록·상세 다시 읽기(F-03-4 T11, ADR-0100).
// - 호스트가 연 늘 여는 흐름의 command 사건은 다시 읽기 방아쇠로만 쓴다(본문에 updatedAt·delivery가 없고, 명령 확인의 정본은 REST 상세).
//   고른 명령이면 상세를, 그 밖이면 목록을 REST로 다시 읽는다. reset이면 목록과 고른 상세를 다시 읽는다.
// - ack가 쌓이는 동안(DISPATCHED)은 상태가 바뀌지 않아 사건이 오지 않는다(감독 결정 2026-11-23: 그 동안의 사건은 동결).
//   그래서 DISPATCHED 상세를 읽으면 3초마다 다시 읽어 덮어 그리고, 끝 상태를 읽으면 멈춘다. 주기 폴링은 이것뿐이다.
// - viewer는 목록만 본다(openapi getOpsCommand는 operator·commander만).
import { ensureConsoleApi } from '@/shared/api';
import { onLive } from '@/shared/api/live';
import { mapCommandList, type CommandPage } from './commands';
import type { CommandDetail } from './command-actions';
import type { ConsoleRole } from './command-form';

/** DISPATCHED 상세를 다시 읽는 간격: 전파 지연 기준 3초(docs/features/control-tower.md §4 T10)와 같다 */
export const DETAIL_REREAD_MS = 3_000;

/** 이 상태의 상세는 ack가 더 쌓일 수 있어 다시 읽는다 */
const MOVING = new Set(['APPROVED', 'DISPATCHED']);

export interface CommandSync {
  select(commandId: string | null): void;
  /** 목록과 고른 상세를 지금 다시 읽는다(사람이 누른 새로 고침·요청 뒤) */
  refresh(): void;
  stop(): void;
}

export function syncCommands(o: { role: ConsoleRole; onList: (page: CommandPage) => void; onDetail: (detail: CommandDetail) => void; onListError?: () => void; onDetailError?: () => void }): CommandSync {
  const canDetail = o.role === 'operator' || o.role === 'commander';
  let selected: string | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 늦게 온 응답이 새 응답을 덮지 않게 요청마다 번호를 단다 */
  let listSeq = 0;
  let detailSeq = 0;

  const clearTimer = () => {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    timer = undefined;
  };

  async function readList(): Promise<void> {
    if (stopped || !ensureConsoleApi()) return;
    const seq = (listSeq += 1);
    try {
      const { listOpsCommands } = await import('@peaket/api-client/endpoints/ops');
      const r = await listOpsCommands({ limit: 100 });
      if (stopped || seq !== listSeq) return;
      o.onList(mapCommandList(r.data as Parameters<typeof mapCommandList>[0]));
    } catch {
      if (!stopped && seq === listSeq) o.onListError?.();
    }
  }

  async function readDetail(id: string): Promise<void> {
    if (stopped || !canDetail || selected !== id || !ensureConsoleApi()) return;
    clearTimer();
    const seq = (detailSeq += 1);
    try {
      const { getOpsCommand } = await import('@peaket/api-client/endpoints/ops');
      const r = await getOpsCommand(id);
      if (stopped || selected !== id || seq !== detailSeq) return;
      const d = r.data as CommandDetail;
      o.onDetail(d);
      if (MOVING.has(d.state ?? '')) timer = globalThis.setTimeout(() => void readDetail(id), DETAIL_REREAD_MS);
    } catch {
      if (!stopped && selected === id && seq === detailSeq) o.onDetailError?.();
    }
  }

  const offCommand = onLive('command', (data) => {
    if (stopped) return;
    const id = (data as { commandId?: unknown } | null)?.commandId;
    void readList();
    if (typeof id === 'string' && id === selected) void readDetail(id);
  });
  const offReset = onLive('reset', () => {
    if (stopped) return;
    void readList();
    if (selected) void readDetail(selected);
  });

  void readList();

  return {
    select(commandId) {
      if (stopped) return;
      selected = commandId;
      clearTimer();
      detailSeq += 1;
      if (commandId) void readDetail(commandId);
    },
    refresh() {
      if (stopped) return;
      void readList();
      if (selected) void readDetail(selected);
    },
    stop() {
      stopped = true;
      clearTimer();
      offCommand();
      offReset();
    },
  };
}
