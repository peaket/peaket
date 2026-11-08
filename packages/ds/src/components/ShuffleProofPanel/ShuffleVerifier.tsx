'use client';
// CMP-049의 '내 순번 검증' 폼(캔버스 보드 SCR-019 ⑥⑨). 같은 브라우저에 토큰 해시가 있으면 자동으로 채우고 <자동 채움> 배지를 단다.
// 원본 시드 공개 전에는 [다시 계산해 확인]이 이유 있는 비활성(aria-disabled + 늘 보이는 이유 글)이다.
// 결과는 다시 계산한 순번과 결과 파일의 순번을 함께 보인다(role="status"). 실제 계산은 부르는 쪽이 onVerify로 넘긴다(결과 파일을 모아 다시 계산, ADR-0232 결정 9).
// layout: stack(휴대폰·데스크톱 옆 패널: 입력 아래 버튼) · inline(태블릿: 입력 오른쪽 버튼) · responsive(md~lg 미만만 inline).
import { useEffect, useId, useState } from 'react';
import { cx } from '../../lib/cx';
import { createVerifyRun, IDLE_RUN, type VerifyRunContext, type VerifyRunResult, type VerifyRunState } from './verify-run';

/** 결과 파일의 순번과 다시 계산한 순번('3,215'), 결과 아래 안내 */
export type ShuffleVerifierResult = VerifyRunResult;

export interface ShuffleVerifierProps {
  /** '참가 토큰 해시' 또는 '사전 검증 토큰 해시'(동시 도착 묶음·선착순 공연) */
  tokenLabel: string;
  /** 자동으로 채운 값(같은 브라우저의 토큰 해시). 없으면 빈 입력 */
  autofill?: string;
  hint: string;
  /** 원본 시드 공개 전이면 그 이유 글. 있으면 버튼은 이유 있는 비활성 */
  disabledReason?: string;
  /** 누르면 보일 결과(목업, onVerify가 없을 때) */
  result?: ShuffleVerifierResult;
  /** 처음부터 결과를 보인다(상태 미리보기 '검증 결과 일치') */
  defaultShowResult?: boolean;
  /** 실제 다시 계산(결과 파일을 모아 계산한다, ADR-0232). 끝나면 결과나 { error } */
  onVerify?: (tokenHash: string, ctx: VerifyRunContext) => Promise<ShuffleVerifierResult | { error: string }>;
  /** 진행 소식이 오기 전에 보일 글 */
  busyLabel?: string;
  /** 시작 전에 알릴 받을 크기('결과 파일 4,096개, 약 77MB를 받습니다') */
  sizeNotice?: string;
  layout?: 'stack' | 'responsive';
  className?: string;
}

export function ShuffleVerifier({
  tokenLabel,
  autofill,
  hint,
  disabledReason,
  result,
  defaultShowResult = false,
  onVerify,
  busyLabel,
  sizeNotice,
  layout = 'stack',
  className,
}: ShuffleVerifierProps) {
  const base = useId();
  const [shown, setShown] = useState(defaultShowResult);
  const [value, setValue] = useState(autofill ?? '');
  const [run, setRun] = useState<VerifyRunState>(IDLE_RUN);
  const [runner] = useState(() => (onVerify ? createVerifyRun(onVerify, setRun) : null));
  // 부품이 사라지면(화면을 떠남, 자동 채움이 늦게 와 key가 바뀜) 돌던 계산을 멈춘다
  useEffect(() => () => runner?.cancel(), [runner]);
  const { busy, error, progress } = run;
  const inline = layout === 'responsive';
  const verified = runner ? run.result : shown ? (result ?? null) : null;
  const same = verified ? verified.fileRank === verified.recomputedRank : false;
  const verify = () => {
    if (!value.trim()) return;
    if (runner) runner.start(value.trim());
    else setShown(true);
  };
  const button = (
    <button
      className={cx('btn btn-secondary btn-lg', inline ? 'btn-block md:w-auto md:min-h-12 md:flex-none lg:w-full' : 'btn-block')}
      type="button"
      aria-disabled={disabledReason ? 'true' : undefined}
      aria-describedby={disabledReason ? `${base}-why` : undefined}
      onClick={() => {
        if (!disabledReason) verify();
      }}
    >
      다시 계산해 확인
    </button>
  );
  return (
    <form className={cx('card col', className)} style={{ gap: 14 }} action="#" onSubmit={(e) => e.preventDefault()}>
      <div className="field">
        <div className={cx('row', inline ? 'between md:justify-start lg:justify-between' : 'between')} style={{ gap: 8 }}>
          <label className="label" htmlFor={`${base}-token`}>
            {tokenLabel}
          </label>
          {autofill ? (
            <span className="badge badge-primary">
              <i className="ic ic-check" aria-hidden="true" />
              자동 채움
            </span>
          ) : null}
        </div>
        <div className={cx(inline && 'md:flex md:items-center md:gap-3 lg:block')}>
          <input
            className={cx('input mono', inline && 'md:grow')}
            id={`${base}-token`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            style={{ fontSize: 14 }}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setShown(false);
              // 입력을 바꾸면 돌던 계산을 멈추고 옛 결과를 지운다
              runner?.cancel();
            }}
            aria-describedby={`${base}-hint`}
          />
          {inline && !disabledReason ? <div className="hidden md:block lg:hidden">{busy ? null : button}</div> : null}
        </div>
        <span className="hint" id={`${base}-hint`}>
          {hint}
        </span>
      </div>
      {disabledReason ? (
        <div className="col" style={{ gap: 8 }}>
          <p className="t-sm muted" id={`${base}-why`}>
            {disabledReason}
          </p>
          {button}
        </div>
      ) : (
        <div className={cx(inline && 'md:hidden lg:block')}>{busy ? null : button}</div>
      )}
      {sizeNotice && !disabledReason && !busy ? <p className="t-sm muted">{sizeNotice}</p> : null}
      <div role="status">
        {busy ? <p className="t-sm muted">{progress ?? busyLabel ?? '다시 계산하는 중입니다'}</p> : null}
        {error ? (
          <div className="banner banner-danger">
            <i className="ic ic-alert-circle" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">{error}</span>
            </div>
          </div>
        ) : null}
        {verified ? (
          <div className={cx('banner', same ? 'banner-success' : 'banner-danger')}>
            <i className={cx('ic', same ? 'ic-check-circle' : 'ic-alert-circle')} aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">{same ? '다시 계산한 순번이 결과 파일과 같습니다' : '다시 계산한 순번이 결과 파일과 다릅니다'}</span>
              <dl className="kv" style={{ marginTop: 8, fontSize: 13, lineHeight: '18px' }}>
                <dt>결과 파일의 순번</dt>
                <dd className="num">{verified.fileRank}</dd>
                <dt>다시 계산한 순번</dt>
                <dd className="num">{verified.recomputedRank}</dd>
              </dl>
              {verified.note ? (
                <p className="t-sm" style={{ marginTop: 8 }}>
                  {verified.note}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {busy ? (
        <button className="btn btn-outline btn-sm self-start" type="button" onClick={() => runner?.cancel()}>
          계산 취소
        </button>
      ) : null}
    </form>
  );
}
