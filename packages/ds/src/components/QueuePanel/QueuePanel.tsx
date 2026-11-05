// CMP-015 QueuePanel(대기 패널, d2 CMP-015, docs/frontend.md §4.8, ADR-0220). 대기열(SCR-008)의 기본 화면 네 가지
// (① 앞 인원 ③ 진행 막대 ② 예상 대기 ⑦ 대기 취소)와, 생길 때만 위에 뜨는 안내, 화면 아래 ⑥ [차례 알림 받기]·⑨ ( 순번 안내 › )를 그린다.
// 대기실 경량 페이지(apps/web/queue-room)는 같은 뷰 모델을 DOM 틀로 그린다. 이 부품은 그 틀과 같은 마크업·클래스를 내므로
// 같은 CSS(@peaket/ds/queue-room.css·queue-room-screens.css) 위에서 같은 그림이 된다(FE-T40, tools/web-checks/visual/queue-panel.spec.mjs).
// - 숫자는 반올림하지 않는다(d1 1원칙). 낭독은 화면이 1분에 한 번 문장을 넣는 live 영역 하나가 하고, 숫자 자체에는 live를 두지 않는다(ADR-0063)
// - '나' 표시와 막대 채움 자리는 CSS 변수(--p)로 준다. 움직임은 transform만 쓴다(d5 §5.8)
// - 남은 초(곧 입장)처럼 시간에 따라 바뀌는 값은 부르는 쪽이 모델로 넘긴다. 부품이 갖는 타이머는 1분 낭독 하나다(셸 announceEveryMinute와 같다)
// - 앞 인원이 바뀌면 바뀐 자리만 굴린다(셸 ui/roll.ts와 같은 규칙, 처음 그릴 때는 굴리지 않는다). 움직임 줄이기·저전력은 CSS가 끈다
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { rollDigits } from './roll';

export type QueuePanelState = 'loading' | 'batching' | 'waiting' | 'stale' | 'paused' | 'all-held' | 'soon';

export interface QueueViewModel {
  state: QueuePanelState;
  /** 내 앞 대기 인원(숫자 상태: waiting·stale·paused·all-held) */
  ahead?: number;
  /** 진행률 0~100(처음 받은 앞 인원 대비) */
  progress?: number;
  /** 예상 대기 글('약 2분'). 속도가 0이면 null('잠시 멈춤') */
  etaText?: string | null;
  /** 곧 입장: 자동으로 다시 시도할 때까지 남은 초 */
  soonSeconds?: number;
  /** 운영 공지(명령 7 템플릿) */
  banner?: string | null;
  /** 앞 인원 × 평균 매수 > 잔여석(④) */
  purchaseUnlikely?: boolean;
}

export interface QueuePanelProps {
  /** 상태는 model.state가 정한다(매진은 화면을 바꾸는 쪽이 SCR-018로 그린다) */
  model: QueueViewModel;
  onCancel?: () => void;
  onNotify?: () => void;
  onInfo?: () => void;
  /** 상태마다 위에 더할 안내(React 판의 Render Props). 기본 안내(공지·일시정지·일시 매진·구매 어려움) 뒤에 붙는다 */
  renderNotice?: (state: QueuePanelState) => ReactNode;
}

const fmt = (n: number): string => n.toLocaleString('ko-KR');

/** 진행 막대 aria-valuetext와 1분 낭독 문장(d5 §5.8, 대기실 queue-math.ts와 같다) */
export function queueSentence(ahead: number, eta: string | null | undefined, allHeld: boolean): string {
  if (allHeld) return `앞에 ${fmt(ahead)}명, 좌석이 풀리길 기다리는 중`;
  return eta ? `앞에 ${fmt(ahead)}명, ${eta} 남음` : `앞에 ${fmt(ahead)}명, 잠시 멈춤`;
}

const Ic = ({ name, extra }: { name: string; extra?: string }) => <i className={cx('ic', `ic-${name}`, extra)} aria-hidden="true" />;
const vars = (p: number): CSSProperties => ({ '--p': `${p}%` }) as CSSProperties;

function Spinner({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <div className="col q-center-block q-g16">
      <span className={cx('spinner q-spin-lg', tone)} aria-hidden="true" />
      {children}
    </div>
  );
}

/** ① 앞 인원 숫자: 바뀐 자리만 위에서 내려오게 굴린다(키를 값마다 달리해 다시 붙여 움직임을 다시 튼다) */
function AheadDigits({ text }: { text: string }) {
  const before = useRef<string | undefined>(undefined);
  const prev = before.current;
  useEffect(() => {
    before.current = text;
  }, [text]);
  const parts: ReactNode[] = [];
  let run = '';
  rollDigits(text, prev).forEach((d, i) => {
    if (d.old === undefined) {
      run += d.ch;
      return;
    }
    if (run) parts.push(run);
    run = '';
    parts.push(
      <span className="q-digit" key={`${i}-${d.ch}-${text}`}>
        <span className="q-digit-stack">
          <span>{d.ch}</span>
          <span className="q-digit-old">{d.old || '\u00a0'}</span>
        </span>
      </span>,
    );
  });
  if (run) parts.push(run);
  return <>{parts}</>;
}

/** 1분에 한 번 같은 문장을 다시 읽게 비웠다가 넣는다(셸 announceEveryMinute와 같다). 숫자 자체에는 live를 두지 않는다(ADR-0063) */
function useMinuteAnnouncement(sentence: string): string {
  const latest = useRef(sentence);
  latest.current = sentence;
  const [said, setSaid] = useState('');
  useEffect(() => {
    let refill: ReturnType<typeof setTimeout> | undefined;
    const id = setInterval(() => {
      setSaid('');
      refill = setTimeout(() => setSaid(latest.current), 100);
    }, 60_000);
    return () => {
      clearInterval(id);
      if (refill) clearTimeout(refill);
    };
  }, []);
  return said;
}

function Count({ ahead, pct, eta, stale, allHeld, paused }: { ahead: number; pct: number; eta: string | null; stale: boolean; allHeld: boolean; paused: boolean }) {
  const tone = stale ? 'muted' : '';
  const sentence = queueSentence(ahead, eta, allHeld);
  const said = useMinuteAnnouncement(sentence);
  const digits = fmt(ahead);
  return (
    <div className="col q-count" data-sentence={sentence}>
      <p className="row q-ahead">
        <span className={cx('t-lg fw-b q-ahead-l', tone)}>앞에</span>
        <span className={cx('t-display num', tone)} data-q="ahead" data-v={digits}>
          <span className="sr-only">{`${digits}명`}</span>
          <span className="q-roll" aria-hidden="true">
            <AheadDigits text={digits} />명
          </span>
        </span>
      </p>
      <div className="q-barwrap">
        <span className="q-me" aria-hidden="true" style={vars(pct)}>
          <span className="badge badge-solid q-me-badge">나</span>
          <span className="q-me-tick" />
        </span>
        <div className="progress progress-lg q-bar" role="progressbar" aria-label="대기 진행" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={sentence}>
          <span className={cx('q-fill', !stale && !paused && 'q-flow', stale && 'q-dim')} style={vars(pct)} />
        </div>
      </div>
      {!allHeld ? (
        <div className="col q-eta">
          <span className="t-sm muted">예상 대기 시간</span>
          <strong className={cx('t-xl', eta && 'num', tone)} data-q="eta">
            {eta ?? '잠시 멈춤'}
          </strong>
        </div>
      ) : (
        <p className="row t-md fw-b q-jc">
          <span className="spinner muted" aria-hidden="true" />
          좌석이 풀리길 기다리는 중
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </div>
  );
}

export function QueuePanel({ model: m, onCancel, onNotify, onInfo, renderNotice }: QueuePanelProps) {
  const st = m.state;
  const hasCount = m.ahead !== undefined && (st === 'waiting' || st === 'stale' || st === 'paused' || st === 'all-held');
  const eta = m.etaText ?? null;
  return (
    <div className="col q-inqueue">
      {m.banner ? (
        <div className="banner banner-announce" role="status">
          <Ic name="megaphone" />
          <div className="banner-body">
            <span className="banner-title">운영 공지</span>
            {m.banner}
          </div>
        </div>
      ) : null}
      {st === 'paused' ? (
        <div className="banner banner-warning" role="status">
          <Ic name="pause" />
          <div className="banner-body fw-b">판매가 잠시 멈췄습니다. 대기 순서는 그대로입니다</div>
        </div>
      ) : null}
      {st === 'all-held' ? (
        <div className="banner banner-info" role="status">
          <Ic name="seat" />
          <div className="banner-body fw-b">남은 좌석이 모두 결제 중입니다. 결제되지 않은 좌석이 풀리면 차례대로 이어집니다</div>
        </div>
      ) : null}
      {m.purchaseUnlikely ? (
        <div className="banner banner-warning" role="status">
          <Ic name="alert" />
          <div className="banner-body">현재 순번으로는 구매가 어려울 수 있습니다</div>
        </div>
      ) : null}
      {renderNotice?.(st)}
      <section className="col q-region" role="region" aria-label="대기 상태">
        {st === 'stale' ? (
          <p className="row t-sm fw-b q-jc" role="status">
            <span className="spinner muted" aria-hidden="true" />
            연결 확인 중
          </p>
        ) : null}
        {st === 'loading' ? (
          <Spinner tone="muted">
            <p className="t-lg" role="status">
              순번 확인 중
            </p>
          </Spinner>
        ) : null}
        {st === 'stale' && m.ahead === undefined ? (
          <Spinner tone="muted">
            <p className="t-lg">순번 확인 중</p>
          </Spinner>
        ) : null}
        {hasCount ? <Count ahead={m.ahead!} pct={Math.round(m.progress ?? 0)} eta={eta} stale={st === 'stale'} allHeld={st === 'all-held'} paused={st === 'paused'} /> : null}
        {st === 'batching' ? (
          <Spinner tone="tx-link">
            <p className="t-lg" role="status">
              순서를 정하는 중입니다. 이 동안에는 순번이 보이지 않습니다
            </p>
          </Spinner>
        ) : null}
        {st === 'soon' ? (
          <div className="col q-center-block q-g12">
            <span className="state-icon is-primary">
              <Ic name="bell" />
            </span>
            <p className="t-2xl" role="alert">
              곧 입장합니다
            </p>
            <p className="t-md">
              <span className="num fw-b">{`${Math.max(1, Math.ceil(m.soonSeconds ?? 1))}초`}</span> 뒤 자동으로 다시 시도합니다
            </p>
            <p className="t-sm muted">다른 탭을 보고 있어도 탭 제목에 남은 초가 보입니다</p>
          </div>
        ) : null}
        <button className="btn btn-text q-self-center" type="button" aria-haspopup="dialog" data-opens="cancel" onClick={onCancel}>
          대기 취소
        </button>
      </section>
      <div className="col q-queue-foot">
        <button className="btn btn-secondary btn-block q-cta" type="button" aria-haspopup="dialog" data-opens="notify" onClick={onNotify}>
          <Ic name="bell" />
          차례 알림 받기
        </button>
        <button className="btn btn-text btn-sm q-mh32" type="button" aria-haspopup="dialog" data-opens="info" onClick={onInfo}>
          순번 안내
          <Ic name="chevron-right" extra="ic-16" />
        </button>
      </div>
    </div>
  );
}
