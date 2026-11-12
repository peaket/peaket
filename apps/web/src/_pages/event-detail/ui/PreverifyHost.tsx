'use client';
// 사전 검증의 늦게 싣는 쪽(ADR-0211, 첫 JS 예산 §5.8): 흐름(features/preverify/flow.ts)을 만들고, 사람 확인 대화상자(CMP-047 위젯 자리)와
// 조용한 갱신용 숨긴 자리를 그리며, API 호출을 잇는다. 화면 값은 Preverify.tsx의 공급자로 올린다.
import { useEffect, useRef, useState } from 'react';
import { WebShellModal, webModalButtonClass } from '@peaket/ds/WebShell';
import { refreshFanSession } from '@/entities/me';
import { runHumanCheck } from '@/features/human-check/load';
import { createPreverifyFlow, type FlowState } from '@/features/preverify/flow';
import { queueRoomHref } from '@/shared/config/origins';
import { browserClock } from '@/shared/lib/clock';
import { deviceId } from '@/shared/lib/device-id';
import { entryHref } from '@/shared/lib/in-app-browser';
import { preverifyStorage, type PreverifyActions, type PreverifyView } from './Preverify';

async function loadQueueApi() {
  const [queue, api] = await Promise.all([import('@peaket/api-client/endpoints/queue'), import('@/shared/api')]);
  api.ensureBrowserApi();
  return { createQueuePreVerification: queue.createQueuePreVerification, withFanRefresh: api.withFanRefresh };
}

/** 자리가 그려질 때까지 기다린다(대화상자는 열린 다음 그리기에서 자리를 만든다) */
function slotWaiter() {
  let el: HTMLElement | null = null;
  let waiters: ((e: HTMLElement) => void)[] = [];
  return {
    ref: (e: HTMLElement | null) => {
      el = e;
      if (e) {
        for (const w of waiters) w(e);
        waiters = [];
      }
    },
    get: (signal: AbortSignal) =>
      new Promise<HTMLElement | null>((resolve) => {
        if (el) return resolve(el);
        waiters.push(resolve);
        signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
  };
}

export default function PreverifyHost({
  eventId,
  loginHref,
  summary,
  onView,
  bind,
}: {
  eventId: string;
  loginHref: string;
  summary: () => unknown;
  onView: (v: PreverifyView) => void;
  bind: (a: PreverifyActions | null) => void;
}) {
  const [view, setView] = useState<FlowState>({ token: null, step: 'idle', open: false, intent: 'early' });
  const dialogSlot = useRef(slotWaiter());
  const silentSlot = useRef(slotWaiter());
  const flowRef = useRef<ReturnType<typeof createPreverifyFlow> | null>(null);
  const [left, setLeft] = useState(0);
  // 인앱 브라우저면 사람 확인을 마친 뒤에도 SCR-058을 먼저 거친다(클라이언트가 붙은 뒤에만 읽는다).
  // 흐름을 다시 만들지 않도록 state 대신 ref에 둔다(사람 확인 도중 흐름이 초기화되지 않는다).
  const uaRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    uaRef.current = navigator.userAgent;
  }, []);

  useEffect(() => {
    const flow = createPreverifyFlow({
      eventId,
      kv: preverifyStorage(),
      now: () => browserClock().now(),
      random: Math.random,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      visible: () => document.visibilityState === 'visible',
      onVisible: (cb) => {
        const f = () => {
          if (document.visibilityState === 'visible') cb();
        };
        document.addEventListener('visibilitychange', f);
        return () => document.removeEventListener('visibilitychange', f);
      },
      humanCheck: async (silent, signal) => {
        const slot = await (silent ? silentSlot : dialogSlot).current.get(signal);
        if (!slot) return null;
        return runHumanCheck(slot, 'preverify', signal, { silent });
      },
      post: async (body, signal) => {
        const { createQueuePreVerification, withFanRefresh } = await loadQueueApi();
        const sent = performance.now();
        const r = await withFanRefresh(() => createQueuePreVerification(eventId, body, { signal }));
        const data = r.data as { serverTimeMs?: unknown };
        if (typeof data.serverTimeMs === 'number') browserClock().addSample({ serverMs: data.serverTimeMs, sentMono: sent, receivedMono: performance.now() });
        return r.data;
      },
      body: () => {
        const id = deviceId();
        const s = summary();
        return { ...(id ? { deviceId: id } : {}), ...(s ? { behaviorSummary: s } : {}) };
      },
      navigate: (u) => location.assign(u),
      refreshPersonal: () => void refreshFanSession(),
      queueHref: entryHref(queueRoomHref(eventId), uaRef.current),
      loginHref,
      onChange: (s) => {
        setView(s);
        onView(s);
      },
    });
    flowRef.current = flow;
    bind({ check: flow.check, enter: flow.enter, retry: flow.retry, close: flow.close });
    return () => {
      bind(null);
      flowRef.current = null;
      flow.dispose();
    };
  }, [eventId, loginHref, summary, onView, bind]);

  // 자동 다시 시도까지 남은 초는 표시만 한다(실제 시각은 흐름이 정한다). 낭독은 한 번(아래 sr-only 문장)
  useEffect(() => {
    if (view.step !== 'retry' || view.retryAt === undefined) return;
    const at = view.retryAt;
    const update = () => setLeft(Math.max(0, Math.ceil((at - browserClock().now()) / 1000)));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [view.step, view.retryAt]);

  const busy = view.step === 'checking' || view.step === 'sending';
  const retry = () => flowRef.current?.retry();
  const close = () => flowRef.current?.close();

  return (
    <>
      {/* 조용한 갱신용 숨긴 자리(조작이 필요하면 위젯을 보이지 않고 멈춘다) */}
      <div ref={silentSlot.current.ref} className="sr-only" aria-hidden="true" />
      <WebShellModal
        open={view.open}
        onClose={close}
        title="사람 확인"
        icon={<i className="ic ic-shield" aria-hidden="true" />}
        actions={
          <button type="button" className={webModalButtonClass('ghost')} onClick={close}>
            닫기
          </button>
        }
      >
        <div className="col" style={{ gap: 12 }}>
          <p className="t-sm muted">{view.intent === 'enter' ? '확인을 마치면 바로 대기열로 이동합니다' : '오픈 전에 확인을 마쳐 두세요. 확인은 15분 동안 유효하고 그동안 조용히 갱신됩니다'}</p>
          {busy ? (
            <div className="progress indet" role="progressbar" aria-label="사람 확인 중">
              <span />
            </div>
          ) : null}
          <div ref={dialogSlot.current.ref} />
          {view.step === 'failed' ? <Notice text="확인하지 못했습니다. 다시 시도해 주세요" onRetry={retry} /> : null}
          {view.step === 'unavailable' ? <Notice text="사람 확인을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요" onRetry={retry} /> : null}
          {view.step === 'not-open' ? <Notice text="대기열이 아직 열리지 않았습니다. 잠시 뒤 다시 시도해 주세요" onRetry={retry} /> : null}
          {view.step === 'storage' ? <Notice text="이 브라우저에 확인 결과를 저장하지 못했습니다. 사생활 보호 모드나 저장 공간을 확인한 뒤 다시 시도해 주세요" onRetry={retry} /> : null}
          {view.step === 'verify' ? <Notice text="휴대폰 본인확인을 먼저 해 주세요" onRetry={() => void refreshFanSession().then(close)} retryLabel="본인확인 상태 다시 보기" /> : null}
          {view.step === 'retry' ? (
            <p className="t-sm">
              <span className="sr-only" role="status">
                잠시 뒤 자동으로 다시 시도합니다
              </span>
              <span aria-hidden="true">
                잠시 뒤 자동으로 다시 시도합니다 · <span className="num">{left}초</span>
              </span>
            </p>
          ) : null}
        </div>
      </WebShellModal>
    </>
  );
}

function Notice({ text, onRetry, retryLabel = '다시 시도' }: { text: string; onRetry: () => void; retryLabel?: string }) {
  return (
    <div className="banner banner-danger" role="alert">
      <i className="ic ic-alert-circle" aria-hidden="true" />
      <div className="banner-body col" style={{ gap: 8 }}>
        <span>{text}</span>
        <button type="button" className="btn btn-outline btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onRetry}>
          {retryLabel}
        </button>
      </div>
    </div>
  );
}
