'use client';
// CMP-049의 '내 순번 검증' 폼(캔버스 보드 SCR-019 ⑥⑨). 같은 브라우저에 토큰 해시가 있으면 자동으로 채우고 <자동 채움> 배지를 단다.
// 원본 시드 공개 전에는 [다시 계산해 확인]이 이유 있는 비활성(aria-disabled + 늘 보이는 이유 글)이다.
// 결과는 다시 계산한 순번과 결과 파일의 순번을 함께 보인다(role="status"). 실제 계산(SHA-256·Fisher–Yates)은 데이터 연결 단계에서 붙인다.
// layout: stack(휴대폰·데스크톱 옆 패널: 입력 아래 버튼) · inline(태블릿: 입력 오른쪽 버튼) · responsive(md~lg 미만만 inline).
import { useId, useState } from 'react';
import { cx } from '../../lib/cx';

export interface ShuffleVerifierResult {
  /** 결과 파일의 순번 '3,215' */
  fileRank: string;
  /** 다시 계산한 순번 '3,215' */
  recomputedRank: string;
}

export interface ShuffleVerifierProps {
  /** '참가 토큰 해시' 또는 '사전 검증 토큰 해시'(동시 도착 묶음·선착순 공연) */
  tokenLabel: string;
  /** 자동으로 채운 값(같은 브라우저의 토큰 해시). 없으면 빈 입력 */
  autofill?: string;
  hint: string;
  /** 원본 시드 공개 전이면 그 이유 글. 있으면 버튼은 이유 있는 비활성 */
  disabledReason?: string;
  /** 누르면 보일 결과(목업) */
  result: ShuffleVerifierResult;
  /** 처음부터 결과를 보인다(상태 미리보기 '검증 결과 일치') */
  defaultShowResult?: boolean;
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
  layout = 'stack',
  className,
}: ShuffleVerifierProps) {
  const base = useId();
  const [shown, setShown] = useState(defaultShowResult);
  const [value, setValue] = useState(autofill ?? '');
  const inline = layout === 'responsive';
  const same = result.fileRank === result.recomputedRank;
  const button = (
    <button
      className={cx('btn btn-secondary btn-lg', inline ? 'btn-block md:w-auto md:min-h-12 md:flex-none lg:w-full' : 'btn-block')}
      type="button"
      aria-disabled={disabledReason ? 'true' : undefined}
      aria-describedby={disabledReason ? `${base}-why` : undefined}
      onClick={() => {
        if (!disabledReason && value.trim()) setShown(true);
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
            }}
            aria-describedby={`${base}-hint`}
          />
          {inline && !disabledReason ? <div className="hidden md:block lg:hidden">{button}</div> : null}
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
        <div className={cx(inline && 'md:hidden lg:block')}>{button}</div>
      )}
      <div role="status">
        {shown ? (
          <div className={cx('banner', same ? 'banner-success' : 'banner-danger')}>
            <i className={cx('ic', same ? 'ic-check-circle' : 'ic-alert-circle')} aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">{same ? '다시 계산한 순번이 결과 파일과 같습니다' : '다시 계산한 순번이 결과 파일과 다릅니다'}</span>
              <dl className="kv" style={{ marginTop: 8, fontSize: 13, lineHeight: '18px' }}>
                <dt>결과 파일의 순번</dt>
                <dd className="num">{result.fileRank}</dd>
                <dt>다시 계산한 순번</dt>
                <dd className="num">{result.recomputedRank}</dd>
              </dl>
            </div>
          </div>
        ) : null}
      </div>
    </form>
  );
}
