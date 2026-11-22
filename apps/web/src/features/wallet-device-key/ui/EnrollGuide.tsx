'use client';
// 입장용 휴대폰 등록 전 안내(ADR-0363 결정 10, offline-gate §2·§4, d5 §5.13 '이 휴대폰에 입장 키가 없음', O-T32·O-T50).
// iOS 브라우저 탭: "홈 화면에 추가한 앱에서 등록하세요" [ 방법 보기 ](CMP-068 홈 화면 추가 안내) ( 그래도 이 브라우저에 등록 › ).
// 데스크톱: "입장 QR은 휴대폰에서 등록하세요" ( 그래도 이 기기에 등록 › ). 키는 ( 그래도 … ) 를 눌러야만 만든다.
import { useState } from 'react';
import { Dialog } from '@peaket/ds/Dialog';

export interface EnrollGuideProps {
  platform: 'ios-tab' | 'desktop';
  /** ( 그래도 … 등록 › ) */
  onProceed: () => void;
  disabled?: boolean;
}

export function EnrollGuide({ platform, onProceed, disabled = false }: EnrollGuideProps) {
  const [open, setOpen] = useState(false);
  const ios = platform === 'ios-tab';
  return (
    <>
      <p className="t-md fw-b" role="status">
        {ios ? '홈 화면에 추가한 앱에서 등록하세요' : '입장 QR은 휴대폰에서 등록하세요'}
      </p>
      <p className="t-sm muted">
        {ios ? '사파리 탭과 홈 화면 앱은 저장소를 따로 써서, 탭에서 등록하면 홈 화면 앱에서 다시 받아야 할 수 있습니다.' : '공연 당일 휴대폰에서 처음 열면 다시 받기로 처리되어 24시간에 한 번만 받을 수 있습니다.'}
      </p>
      {ios ? (
        <button className="btn btn-outline btn-block" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
          방법 보기
        </button>
      ) : null}
      <button className="btn btn-text" type="button" aria-disabled={disabled ? true : undefined} onClick={() => (disabled ? undefined : onProceed())}>
        {ios ? '그래도 이 브라우저에 등록' : '그래도 이 기기에 등록'}
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </button>
      {ios ? (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          layout="auto"
          icon="phone"
          iconTone="primary"
          title="홈 화면에 추가하는 방법"
          description="추가한 앱에서 티켓을 한 번 열어 두면, 공연장에서 인터넷이 없어도 티켓이 열립니다"
          actions={
            <button className="btn btn-primary btn-lg w-full md:w-auto" type="button" onClick={() => setOpen(false)}>
              확인
            </button>
          }
        >
          <ol className="col t-sm" style={{ gap: 8, paddingLeft: 18, listStyle: 'decimal' }}>
            <li>사파리 아래쪽 공유 버튼을 누르고 &lsquo;홈 화면에 추가&rsquo;를 고릅니다</li>
            <li>홈 화면에 생긴 피켓 앱을 열고 이 티켓에서 등록합니다</li>
          </ol>
        </Dialog>
      ) : null}
    </>
  );
}
