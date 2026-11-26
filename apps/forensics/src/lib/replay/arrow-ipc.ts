// F-04-17 Arrow IPC 파일 읽기. 정본: docs/features/forensic-replay.md §4.2·§8 FX-T21.
// apache-arrow의 tableFromIPC를 정확히 한 번 부르고, 표를 ArrowTableLike 포트로 옮겨 decodeReplayTable에 넘긴다.
// 실제 IPC·LZ4/ZSTD 파일 시험은 미실행이고, 라이브러리가 풀지 못하면 arrow-ipc 파일 거절이다.
import { Dictionary, tableFromIPC } from 'apache-arrow';
import type { ReplayEnvelope } from '../replay-export.ts';
import { decodeReplayTable, type ArrowTableLike, type DecodedReplay } from './arrow.ts';

export function decodeArrowIpc(bytes: Uint8Array, envelope: ReplayEnvelope): DecodedReplay {
  let table: ReturnType<typeof tableFromIPC>;
  try {
    table = tableFromIPC(bytes);
  } catch (err) {
    void err;
    return { ok: false, reject: { ok: false, code: 'arrow-ipc', message: 'Arrow 파일을 해독하지 못했습니다' } };
  }

  const like: ArrowTableLike = {
    numRows: table.numRows,
    schema: {
      fields: table.schema.fields.map((field) => ({
        name: field.name,
        type: String(field.type),
        ...(field.type instanceof Dictionary ? { dictionary: true } : {}),
      })),
      metadata: table.schema.metadata,
    },
    getChild: (name) => table.getChild(name),
  };
  return decodeReplayTable(like, envelope);
}
