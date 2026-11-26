'use client';
// SCR-062 라이브 경로(F-07-12). ?state=가 없을 때 목록·할 일 API를 부르고 HomeLiveView에 넘긴다.
// 할 일 API가 실패해도 목록은 그린다(Promise.allSettled). 필터 400은 조건 안내로 바꾼다.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getPartnerTodoSummary, listPartnerProductions, type PartnerHomeQuery } from '@/shared/api/partner-live';
import { homeQueryOf, homeRowsOf, todoCardsOf, type HomeRow, type TodoCard } from '../model/live';
import { HomeLiveView, type HomeViewMode } from './live-view';

interface Loaded {
  mode: HomeViewMode;
  rows: HomeRow[];
  todo: TodoCard[] | null | undefined;
  message: string | null;
}

const LOADING: Loaded = { mode: 'loading', rows: [], todo: undefined, message: null };

export function LivePartnerHome() {
  const sp = useSearchParams();
  const qs = sp?.toString() ?? '';
  const [loaded, setLoaded] = useState<Loaded>(LOADING);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(qs);
    const query = homeQueryOf(
      {
        ...(params.get('saleReview') ? { saleReview: params.get('saleReview')! } : {}),
        ...(params.get('saleStatus') ? { saleStatus: params.get('saleStatus')! } : {}),
        ...(params.get('period') ? { period: params.get('period')! } : {}),
        ...(params.get('q') ? { q: params.get('q')! } : {}),
      },
      new Date(),
    ) as PartnerHomeQuery;
    setLoaded(LOADING);
    void Promise.allSettled([listPartnerProductions(query, controller.signal), getPartnerTodoSummary(controller.signal)]).then(([list, todo]) => {
      if (controller.signal.aborted) return;
      const cards = todo.status === 'fulfilled' ? todoCardsOf(todo.value) : null;
      if (list.status === 'rejected') {
        const status = (list.reason as { status?: number } | undefined)?.status;
        setLoaded({ mode: 'error', rows: [], todo: cards, message: status === 400 ? '조건을 다시 확인해 주세요' : null });
        return;
      }
      const rows = homeRowsOf(list.value);
      setLoaded({ mode: rows.length === 0 ? 'empty' : 'ready', rows, todo: cards, message: null });
    });
    return () => controller.abort();
  }, [qs]);

  return <HomeLiveView mode={loaded.mode} rows={loaded.rows} todo={loaded.todo} message={loaded.message} />;
}
