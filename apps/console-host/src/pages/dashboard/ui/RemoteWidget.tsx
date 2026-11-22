// 원격 위젯 자리(실제 값, ADR-0100 결정 6, ADR-0360, ADR-0361). 원격(대기열·구매 팀)을 무결성 적재기로 싣고(목록·계약 판·sha384·5초·한 번 다시),
// 위젯 정보의 계약 판이 맞으면 위젯을 그린다. 값은 위젯이 ConsoleServices(REST 위젯 조회 + 위젯 흐름)로 받는다.
// - 싣는 동안은 스켈레톤, 원격을 받지 못하면 그 자리만 '이 위젯만 불러오지 못했습니다' 카드(CMP-035)이고 [다시 시도]가 그 칸만 다시 싣는다
// - 접기: 위젯 머리의 [접기]·접힌 줄 누르기로 바꾸고 이 브라우저에만 남긴다(peaket.console.ui). 접어도 구독은 그대로다(핵심 숫자가 바뀐다)
// - 화면 밖: IntersectionObserver로 보고, 화면 밖이면 값을 넘기지 않고 마지막 값만 들고 있다가 보이면 한 번 넘긴다(구독은 그대로, §4.5)
// 퍼블리싱(?state=) 화면은 이 자리 대신 고정 자료 위젯을 그린다(board-d).
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import type { DetailLink, WidgetProps } from '@peaket/console-contract';
import { slotFor } from '@/shared/api/live';
import { loadRemoteWidget, RemoteLoadError, type RemoteName } from '@/shared/lib/remotes/load-remote';
import { useUiPrefs } from '@/shared/lib/theme';
import { useLiveHost } from '@/shared/model/live-host';
import { FailCard, Skeleton } from './WidgetSlot';

interface RemoteWidgetProps {
  remote: RemoteName;
  /** 위젯 정보의 name(예: queue-admission-rate) */
  name: string;
  title: string;
  style?: CSSProperties;
}

class Boundary extends Component<{ title: string; style?: CSSProperties; onRetry: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <FailCard
        title={this.props.title}
        style={this.props.style}
        onRetry={() => {
          this.setState({ failed: false });
          this.props.onRetry();
        }}
      />
    ) : (
      this.props.children
    );
  }
}

const noop = (_: DetailLink) => undefined;
const noStatus = () => undefined;
const RANGE_MS = 15 * 60_000;

/**
 * 자리가 화면 안인지 본다. 자리는 display: contents라 상자가 없어 첫 자식 요소를 보고, 원격이 그리는 요소가 바뀌면(불러오는 중 → 위젯 → 접힘)
 * MutationObserver로 다시 건다. 관찰 도구가 없는 브라우저는 늘 화면 안으로 본다
 */
function useOnScreen(ref: { current: HTMLElement | null }, onChange: (on: boolean) => void, ready: boolean) {
  useEffect(() => {
    const box = ref.current;
    if (!ready || !box || typeof IntersectionObserver !== 'function' || typeof MutationObserver !== 'function') return undefined;
    let observed: Element | null = null;
    const io = new IntersectionObserver((entries) => {
      const e = entries.filter((x) => x.target === observed).at(-1);
      if (e) onChange(e.isIntersecting);
    });
    const attach = () => {
      const el = box.firstElementChild;
      if (el === observed) return;
      if (observed) io.unobserve(observed);
      observed = el;
      if (el) io.observe(el);
    };
    const mo = new MutationObserver(attach);
    mo.observe(box, { childList: true });
    attach();
    return () => {
      mo.disconnect();
      io.disconnect();
      onChange(true);
    };
  }, [ref, onChange, ready]);
}

export function RemoteWidget({ remote, name, title, style }: RemoteWidgetProps) {
  const [Widget, setWidget] = useState<ComponentType<WidgetProps> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const eventId = useLiveHost((s) => s.scope.eventId);
  const collapsed = useUiPrefs((s) => s.collapsed.includes(name));
  const setCollapsed = useUiPrefs((s) => s.setCollapsed);
  const slot = useMemo(() => slotFor(name), [name]);
  useEffect(() => () => slot.dispose(), [slot]);
  const box = useRef<HTMLDivElement>(null);
  const onScreen = useCallback((on: boolean) => slot.setOnScreen(on), [slot]);
  useOnScreen(box, onScreen, Widget !== null);

  useEffect(() => {
    let alive = true;
    loadRemoteWidget(remote, name)
      .then((W) => {
        if (alive) setWidget(() => W);
      })
      .catch((e: unknown) => {
        if (alive) setFailed(e instanceof RemoteLoadError ? e.reason : 'container');
      });
    return () => {
      alive = false;
    };
  }, [remote, name, attempt]);
  const retry = useCallback(() => {
    setFailed(null);
    setWidget(null);
    setAttempt((n) => n + 1);
  }, []);
  const onCollapsedChange = useCallback((c: boolean) => setCollapsed(name, c), [name, setCollapsed]);
  const timeRange = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - RANGE_MS).toISOString(), to: to.toISOString() };
  }, [eventId]);
  if (failed) return <FailCard title={title} style={style} remote reason={failed} onRetry={retry} />;
  if (!Widget) return <Skeleton title={title} style={style} />;
  return (
    <Boundary title={title} style={style} onRetry={retry}>
      <div ref={box} style={{ display: 'contents' }} data-remote={remote} data-widget={name} data-collapsed={collapsed ? 'true' : undefined}>
        <Widget
          eventId={eventId}
          timeRange={timeRange}
          density="comfortable"
          collapsed={collapsed}
          services={slot.services}
          onOpenDetail={noop}
          onStatus={noStatus}
          onCollapsedChange={onCollapsedChange}
        />
      </div>
    </Boundary>
  );
}
