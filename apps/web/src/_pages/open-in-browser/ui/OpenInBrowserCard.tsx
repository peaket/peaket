'use client';
// SCR-058 가운데 안내 카드와 방법 안내 시트(보드 SCR-058-m·t·d, d5 §5.32, d3 SCR-058 행). 안내문을 버튼보다 먼저 읽는다.
// - 기기 줄: 알아낸 기기 줄을 맨 위에 굵게(NFR-019 지원 브라우저). ?state=로 고르면 그 기기, 아니면 사용자 에이전트로 알아낸다(안내용, 서버 판정에 쓰지 않는다).
// - [다른 브라우저로 열기]: Android는 intent 주소로 기본 브라우저를 바로 연다. iOS는 'Safari에서 여는 방법', Windows·Mac은 '기본 브라우저로 열기' 안내 창.
// - [주소 복사]: 가려던 주소를 복사하고 토스트 "주소를 복사했습니다".
// 방법 안내 창은 휴대폰 아래 시트, 태블릿·데스크톱 대화상자(WebShellModal). Mac 줄·Mac 안내 창 제목은 보드에 없어 d5 문구로 정했다(추천안).
import { useEffect, useId, useState } from 'react';
import { WebShellModal, webModalButtonClass } from '@peaket/ds/WebShell';
import type { Scr058State } from '@/shared/config/screens.discovery';
import { useToast } from '@/shared/ui/toast';

export type Device = 'android' | 'ios' | 'windows' | 'mac' | 'other';

const LINES: Record<Exclude<Device, 'other'>, { label: string; browsers: string; icon: 'ic-phone' | 'ic-monitor'; obj: '을' | '를' }> = {
  ios: { label: 'iPhone·iPad는', browsers: 'Safari', icon: 'ic-phone', obj: '를' },
  android: { label: 'Android는', browsers: 'Chrome이나 삼성 인터넷', icon: 'ic-phone', obj: '을' },
  windows: { label: 'Windows는', browsers: 'Edge나 Chrome', icon: 'ic-monitor', obj: '을' },
  mac: { label: 'Mac은', browsers: 'Safari나 Chrome', icon: 'ic-monitor', obj: '을' },
};

/** 보드의 줄 순서(알아낸 기기가 맨 위). 모르는 기기는 planning/04 문구 순서 */
const ORDER: Record<Device, Exclude<Device, 'other'>[]> = {
  android: ['android', 'ios', 'windows', 'mac'],
  windows: ['windows', 'ios', 'android', 'mac'],
  ios: ['ios', 'android', 'windows', 'mac'],
  mac: ['mac', 'ios', 'android', 'windows'],
  other: ['ios', 'android', 'windows', 'mac'],
};

const HOWTO: Record<'ios' | 'windows' | 'mac', { title: string; steps: string[] }> = {
  ios: {
    title: 'Safari에서 여는 방법',
    steps: [
      '이 앱 화면의 메뉴 버튼(점 세 개나 공유 모양)을 누릅니다',
      "'Safari로 열기'나 '기본 브라우저로 열기'를 고릅니다",
      '메뉴에 없으면 주소를 복사해 Safari 주소창에 붙여 넣습니다',
    ],
  },
  windows: {
    title: '기본 브라우저(Edge 등)로 열기',
    steps: [
      '이 창의 메뉴 버튼(점 세 개나 브라우저 모양)을 누릅니다',
      "'기본 브라우저로 열기'를 고릅니다",
      '메뉴에 없으면 주소를 복사해 Edge나 Chrome 주소창에 붙여 넣습니다',
    ],
  },
  mac: {
    title: '기본 브라우저(Safari 등)로 열기',
    steps: [
      '이 창의 메뉴 버튼(점 세 개나 브라우저 모양)을 누릅니다',
      "'기본 브라우저로 열기'를 고릅니다",
      '메뉴에 없으면 주소를 복사해 Safari나 Chrome 주소창에 붙여 넣습니다',
    ],
  },
};

function stateDevice(state: Scr058State | null): Device | null {
  if (state === null) return null;
  if (state === 'Android' || state === '주소 복사됨') return 'android';
  if (state === 'iOS 방법 안내') return 'ios';
  return 'windows';
}

function detectDevice(ua: string, touchPoints: number): Device {
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh/i.test(ua)) return 'mac';
  return 'other';
}

/** Android 인앱 브라우저에서 기본 브라우저로 바로 여는 intent 주소(패키지를 정하지 않아 기본 브라우저가 연다) */
function androidIntentHref(absolute: string): string {
  const u = new URL(absolute);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(':', '')};end`;
}

export interface OpenInBrowserCardProps {
  /** 미리보기 상태(?state=). 없으면 기기를 알아낸다 */
  state: Scr058State | null;
  /** 외부 브라우저에서 열 주소(절대 주소 또는 이 앱 경로) */
  href: string;
}

export function OpenInBrowserCard({ state, href }: OpenInBrowserCardProps) {
  const toast = useToast();
  const titleId = useId();
  const [device, setDevice] = useState<Device>(stateDevice(state) ?? 'other');
  const [howto, setHowto] = useState<'ios' | 'windows' | 'mac' | null>(
    state === 'iOS 방법 안내' ? 'ios' : state === 'Windows 방법 안내' ? 'windows' : null,
  );
  const [copiedPreview, setCopiedPreview] = useState(state === '주소 복사됨');

  useEffect(() => {
    if (state !== null) return;
    setDevice(detectDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0));
  }, [state]);

  const absolute = () => new URL(href, window.location.href).toString();

  async function copy() {
    setCopiedPreview(false);
    const url = absolute();
    try {
      await navigator.clipboard.writeText(url);
      toast('주소를 복사했습니다', 'ic-check');
    } catch {
      // 추천안: 보드에 실패 문구가 없어 주소를 그대로 보여 손으로 옮기게 한다
      toast(`주소를 복사하지 못했습니다. 이 주소를 직접 입력해 주세요: ${url}`, 'ic-alert');
    }
  }

  function openOther() {
    if (device === 'android') {
      window.location.href = androidIntentHref(absolute());
      return;
    }
    setHowto(device === 'ios' ? 'ios' : device === 'mac' ? 'mac' : 'windows');
  }

  const order = ORDER[device];
  return (
    <>
      <section
        className="card col mx-auto my-auto w-full gap-[18px] px-5 pt-6 pb-5 md:max-w-[520px] lg:gap-5 lg:px-7 lg:pt-8 lg:pb-7"
        aria-labelledby={titleId}
      >
        <span className="state-icon is-primary h-14 w-14">
          <i className="ic ic-external" aria-hidden="true" />
        </span>
        <h1 className="t-lg" id={titleId}>
          이 앱 안의 브라우저에서는 대기실에 들어갈 수 없습니다
        </h1>
        <div className="banner banner-info" role="status">
          <i className="ic ic-info" aria-hidden="true" />
          <div className="banner-body col" style={{ gap: 10 }}>
            <p>대기 순번과 입장 키는 브라우저에 저장됩니다. 이 기기의 기본 브라우저에서 열어 주세요.</p>
            <ul className="col" style={{ gap: 6 }}>
              {order.map((key, i) => {
                const line = LINES[key];
                const last = i === order.length - 1;
                const text = `${line.label} ${line.browsers}${last ? `${line.obj} 쓸 수 있습니다(Whale도 됩니다).` : ','}`;
                const strong = i === 0 && device !== 'other';
                return (
                  <li key={key} className="row items-start" style={{ gap: 8 }}>
                    <i className={`ic ${line.icon} ic-16 ${strong ? '' : 'muted'}`} aria-hidden="true" style={{ marginTop: 2 }} />
                    {strong ? <strong className="fw-b">{text}</strong> : <span>{text}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <div className="col" style={{ gap: 10 }}>
          <button className="btn btn-primary btn-lg btn-block" type="button" aria-haspopup={device === 'android' ? undefined : 'dialog'} onClick={openOther}>
            <i className="ic ic-external" aria-hidden="true" />
            다른 브라우저로 열기
          </button>
          <button className="btn btn-secondary btn-lg btn-block" type="button" onClick={copy}>
            <i className="ic ic-copy" aria-hidden="true" />
            주소 복사
          </button>
        </div>
      </section>

      {howto ? (
        <WebShellModal
          open
          onClose={() => setHowto(null)}
          title={HOWTO[howto].title}
          actions={
            <>
              <button className={webModalButtonClass('secondary')} type="button" onClick={copy}>
                <i className="ic ic-copy" aria-hidden="true" />
                주소 복사
              </button>
              <button className={webModalButtonClass('ghost')} type="button" onClick={() => setHowto(null)}>
                닫기
              </button>
            </>
          }
        >
          <ol className="col" style={{ gap: 14 }}>
            {HOWTO[howto].steps.map((s, i) => (
              <li key={s} className="row items-start" style={{ gap: 12 }}>
                <span className="step-num" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="t-md">{s}</span>
              </li>
            ))}
          </ol>
        </WebShellModal>
      ) : null}

      {copiedPreview ? (
        // '주소 복사됨' 미리보기: 셸 토스트와 같은 자리에 열린 채로 그린다
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[95] flex justify-center px-4 lg:bottom-8">
          <div className="toast" role="status">
            <i className="ic ic-check" aria-hidden="true" />
            주소를 복사했습니다
          </div>
        </div>
      ) : null}
    </>
  );
}
