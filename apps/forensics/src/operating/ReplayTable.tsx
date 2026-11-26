// F-04-17 표로 보기. 정본: docs/features/forensic-replay.md §2.3, d5 §7.17.
// 그림마다 같은 집계를 표로 보여 준다. 값은 호출한 쪽이 만든 표 행을 그대로 쓴다.
import type { ReactNode } from 'react';

export interface ReplayTableColumn<T> {
  key: string;
  label: string;
  value: (row: T) => ReactNode;
}

export function ReplayTable<T>({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: readonly ReplayTableColumn<T>[];
  rows: readonly T[];
}) {
  return (
    <div className="scroll-x" style={{ overflowX: 'auto' }}>
      <table className="table t-sm">
        <caption className="t-xs muted">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key}>{column.value(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
