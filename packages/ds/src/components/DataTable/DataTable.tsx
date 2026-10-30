'use client';
// CMP-031 DataTable. 표 논리(정렬·선택)는 TanStack Table 9가 맡고, 모양은 캔버스 키트 13절 .table-wrap·.table을 그대로 낸다.
// 보드 마크업: <div class="table-wrap"><table class="table [dense]"><thead><tr><th scope="col" aria-sort="descending">
//   <button class="row" type="button" style="gap:4px;background:transparent;border:0;padding:0;cursor:pointer;color:var(--text)">첫 오픈
//   <i class="ic ic-chevron-down ic-14"></i></button></th>… 숫자 열은 .r(오른쪽 정렬·고정폭 숫자), 고른 행은 tr.is-selected.
// - 정렬: sortable 열의 머리 버튼. 정렬 상태는 th의 aria-sort로 알린다. 서버 정렬이면 manualSorting + onSortChange.
// - 선택: selectable이면 첫 열에 체크박스(.cb). 전체 선택(일부면 indeterminate), 'N개 선택'을 글자로 알린다(aria-live).
// - 상태: loading(.skel 줄, aria-busy) · empty(빈 상태) · error(오류 상태) · ready.
// - 가로 스크롤: scroll이면 .table-scroll로 상자 안에서만 민다(폭 320에서 화면 전체가 밀리지 않게). minWidth로 표 최소 폭.
// - totalCount를 주면 aria-rowcount(전체 행 수)와 행마다 aria-rowindex를 단다(가상 스크롤·페이지로 일부만 그릴 때).
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  createSortedRowModel,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
  useTable,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';
import { cx } from '../../lib/cx';
import { Icon } from '../../icons';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';

const features = tableFeatures({
  rowSortingFeature,
  rowSelectionFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic, text: sortFn_text },
});

export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  /** 정렬에 쓰는 값이자 cell이 없을 때 보일 값 */
  value?: (row: T) => string | number | null | undefined;
  /** 칸 내용 */
  cell?: (row: T) => ReactNode;
  align?: 'left' | 'right';
  sortable?: boolean;
  /** 행 머리 칸(<th scope="row">) */
  rowHeader?: boolean;
  width?: number | string;
}

export interface DataTableSort {
  id: string;
  desc: boolean;
}

export interface DataTableProps<T> {
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  getRowId: (row: T) => string;
  /** 표 이름(화면에서는 숨긴 caption) */
  caption: string;
  dense?: boolean;
  selectable?: boolean;
  /** 행 체크박스 이름에 쓸 글(예: 예매번호). 체크박스 이름은 '<글> 선택' */
  rowLabel?: (row: T) => string;
  selectedIds?: readonly string[];
  defaultSelectedIds?: readonly string[];
  onSelectionChange?: (ids: string[]) => void;
  /** 고른 행이 있을 때 'N개 선택' 옆 일괄 처리 버튼 */
  bulkActions?: (ids: string[]) => ReactNode;
  sort?: DataTableSort | null;
  defaultSort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort | null) => void;
  /** 서버가 정렬한다(받은 순서 그대로 그린다) */
  manualSorting?: boolean;
  state?: 'ready' | 'loading' | 'empty' | 'error';
  /** 빈 상태(기본: EmptyState '표시할 항목이 없습니다') */
  empty?: ReactNode;
  /** 오류 상태(기본: ErrorState) */
  error?: ReactNode;
  loadingRows?: number;
  scroll?: boolean;
  minWidth?: number;
  /** 전체 행 수(일부만 그릴 때). 모르면 -1 */
  totalCount?: number;
  /** 첫 행의 전체 위치(1부터, 페이지 둘째 쪽이면 26 등) */
  firstRowIndex?: number;
  className?: string;
  style?: CSSProperties;
}

const sortButton: CSSProperties = { gap: 4, background: 'transparent', border: 0, padding: 0, cursor: 'pointer' };

function HeaderCheckbox({ checked, indeterminate, onChange, disabled }: { checked: boolean; indeterminate: boolean; onChange: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} className="cb" type="checkbox" aria-label="전체 선택" checked={checked} onChange={onChange} disabled={disabled} />;
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  caption,
  dense = false,
  selectable = false,
  rowLabel,
  selectedIds,
  defaultSelectedIds,
  onSelectionChange,
  bulkActions,
  sort,
  defaultSort = null,
  onSortChange,
  manualSorting = false,
  state = 'ready',
  empty,
  error,
  loadingRows = 5,
  scroll = false,
  minWidth,
  totalCount,
  firstRowIndex = 1,
  className,
  style,
}: DataTableProps<T>) {
  const [innerSort, setInnerSort] = useState<SortingState>(defaultSort ? [defaultSort] : []);
  const sorting: SortingState = sort !== undefined ? (sort ? [sort] : []) : innerSort;
  const [innerSel, setInnerSel] = useState<RowSelectionState>(() =>
    Object.fromEntries((defaultSelectedIds ?? []).map((id) => [id, true])),
  );
  const rowSelection: RowSelectionState = selectedIds ? Object.fromEntries(selectedIds.map((id) => [id, true])) : innerSel;

  const defs = useMemo(
    () =>
      columns.map((c) => ({
        id: c.id,
        accessorFn: (row: T) => c.value?.(row) ?? null,
        enableSorting: Boolean(c.sortable),
      })),
    [columns],
  );
  const data = useMemo(() => [...rows], [rows]);

  const table = useTable({
    features,
    columns: defs as never,
    data,
    getRowId: (row: T) => getRowId(row),
    manualSorting,
    enableSortingRemoval: true,
    enableRowSelection: selectable,
    state: { sorting, rowSelection },
    onSortingChange: (updater: unknown) => {
      const next = (typeof updater === 'function' ? (updater as (s: SortingState) => SortingState)(sorting) : updater) as SortingState;
      if (sort === undefined) setInnerSort(next);
      onSortChange?.(next[0] ?? null);
    },
    onRowSelectionChange: (updater: unknown) => {
      const next = (typeof updater === 'function'
        ? (updater as (s: RowSelectionState) => RowSelectionState)(rowSelection)
        : updater) as RowSelectionState;
      if (!selectedIds) setInnerSel(next);
      onSelectionChange?.(Object.keys(next).filter((k) => next[k]));
    },
  } as never) as unknown as {
    getRowModel: () => { rows: Array<{ id: string; original: T; getIsSelected: () => boolean; toggleSelected: (v?: boolean) => void }> };
    getColumn: (id: string) => { getIsSorted: () => false | 'asc' | 'desc'; toggleSorting: (desc?: boolean) => void; clearSorting: () => void } | undefined;
    getIsAllRowsSelected: () => boolean;
    getIsSomeRowsSelected: () => boolean;
    toggleAllRowsSelected: (v?: boolean) => void;
  };

  const tableRows = table.getRowModel().rows;
  const selectedCount = Object.values(rowSelection).filter(Boolean).length;
  const selected = Object.keys(rowSelection).filter((k) => rowSelection[k]);
  const colCount = columns.length + (selectable ? 1 : 0);

  const cycleSort = (id: string) => {
    const col = table.getColumn(id);
    if (!col) return;
    const cur = col.getIsSorted();
    // 없음 → 내림차순 → 오름차순 → 없음(보드의 첫 정렬은 최신이 위인 내림차순)
    if (cur === false) col.toggleSorting(true);
    else if (cur === 'desc') col.toggleSorting(false);
    else col.clearSorting();
  };

  let body: ReactNode;
  if (state === 'loading') {
    body = Array.from({ length: loadingRows }, (_, i) => (
      <tr key={`sk-${i}`}>
        {Array.from({ length: colCount }, (__, j) => (
          <td key={j}>
            <span className="skel" style={{ height: 16 }} />
          </td>
        ))}
      </tr>
    ));
  } else if (state === 'error') {
    body = (
      <tr>
        <td colSpan={colCount}>{error ?? <ErrorState headingLevel={3} title="표를 불러오지 못했습니다" />}</td>
      </tr>
    );
  } else if (state === 'empty' || tableRows.length === 0) {
    body = (
      <tr>
        <td colSpan={colCount}>{empty ?? <EmptyState headingLevel={3} title="표시할 항목이 없습니다" />}</td>
      </tr>
    );
  } else {
    body = tableRows.map((row, i) => {
      const isSel = row.getIsSelected();
      return (
        <tr key={row.id} className={isSel ? 'is-selected' : undefined} aria-rowindex={totalCount !== undefined ? firstRowIndex + i + 1 : undefined}>
          {selectable ? (
            <td style={{ width: 44 }}>
              <input
                className="cb"
                type="checkbox"
                aria-label={`${rowLabel ? rowLabel(row.original) : row.id} 선택`}
                checked={isSel}
                onChange={() => row.toggleSelected()}
              />
            </td>
          ) : null}
          {columns.map((c) => {
            const content = c.cell ? c.cell(row.original) : (c.value?.(row.original) ?? '');
            const cls = c.align === 'right' ? 'r' : undefined;
            return c.rowHeader ? (
              <th key={c.id} scope="row" className={cls} style={{ background: 'transparent', fontSize: 'inherit', fontWeight: 700, color: 'var(--text)', whiteSpace: 'normal' }}>
                {content}
              </th>
            ) : (
              <td key={c.id} className={cls}>
                {content}
              </td>
            );
          })}
        </tr>
      );
    });
  }

  return (
    <div className={cx('col', className)} style={{ gap: 8, ...style }}>
      {selectable ? (
        <div className="toolbar" style={selectedCount > 0 ? undefined : { display: 'none' }}>
          <span className="t-sm fw-b">{selectedCount}개 선택</span>
          {selectedCount > 0 && bulkActions ? bulkActions(selected) : null}
        </div>
      ) : null}
      {selectable ? (
        <p className="sr-only" aria-live="polite">
          {selectedCount > 0 ? `${selectedCount}개 선택` : ''}
        </p>
      ) : null}
      <div className={cx('table-wrap', scroll && 'table-scroll')} aria-busy={state === 'loading' || undefined}>
        <table className={cx('table', dense && 'dense')} style={minWidth ? { minWidth } : undefined} aria-rowcount={totalCount}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr aria-rowindex={totalCount !== undefined ? 1 : undefined}>
              {selectable ? (
                <th scope="col" style={{ width: 44 }}>
                  <HeaderCheckbox
                    checked={tableRows.length > 0 && table.getIsAllRowsSelected()}
                    indeterminate={table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected()}
                    onChange={() => table.toggleAllRowsSelected(!table.getIsAllRowsSelected())}
                    disabled={state !== 'ready' || tableRows.length === 0}
                  />
                </th>
              ) : null}
              {columns.map((c) => {
                const sorted = c.sortable ? (table.getColumn(c.id)?.getIsSorted() ?? false) : false;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    className={c.align === 'right' ? 'r' : undefined}
                    style={c.width !== undefined ? { width: c.width } : undefined}
                    aria-sort={c.sortable ? (sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none') : undefined}
                  >
                    {c.sortable ? (
                      <button
                        className="row"
                        type="button"
                        style={{ ...sortButton, ...(sorted ? { color: 'var(--text)' } : null), ...(c.align === 'right' ? { marginLeft: 'auto' } : null) }}
                        onClick={() => cycleSort(c.id)}
                      >
                        {c.header}
                        <Icon name={sorted === 'asc' ? 'chevron-up' : sorted === 'desc' ? 'chevron-down' : 'sort'} size={14} />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
    </div>
  );
}
