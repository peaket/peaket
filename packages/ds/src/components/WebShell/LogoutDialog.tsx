'use client';
// 로그아웃 확인(d5 §3.1, ADR-0079 결정 17, 보드 SCR-017 '로그아웃 확인'). 휴대폰은 아래 시트, 태블릿·데스크톱은 대화상자다.
// 세 셸 변형이 같은 대화상자를 쓴다(ASVS 7.4.4). 무엇을 지우는지는 docs/frontend.md §3.12 표가 정한다(데이터 연결 단계).
import { useId, useState } from "react";
import { WebShellModal, webModalButtonClass } from "./WebShellModal";

export interface LogoutDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (opts: { clearEntryKeys: boolean }) => void;
}

export function LogoutDialog({ open, onClose, onConfirm }: LogoutDialogProps) {
  const id = useId();
  const [clearKeys, setClearKeys] = useState(false);
  return (
    <WebShellModal
      open={open}
      onClose={onClose}
      title="로그아웃합니다"
      describedBy={`${id}-d`}
      maxWidth={480}
      actions={
        <>
          <button className={webModalButtonClass("primary")} type="button" onClick={() => onConfirm({ clearEntryKeys: clearKeys })}>
            로그아웃
          </button>
          <button className={webModalButtonClass("ghost")} type="button" onClick={onClose}>
            취소
          </button>
        </>
      }
    >
      <p className="t-sm" id={`${id}-d`}>
        이 기기에 저장된 대기·예매 진행 정보를 지웁니다. 입장 키는 남겨 두어 공연장에서 인터넷 없이 QR을 열 수 있습니다.
      </p>
      <label className="check-row" htmlFor={`${id}-key`}>
        <input
          className="cb"
          id={`${id}-key`}
          type="checkbox"
          checked={clearKeys}
          onChange={(e) => setClearKeys(e.target.checked)}
          aria-describedby={`${id}-hint`}
        />
        이 기기의 입장 키도 지우기
      </label>
      <p className="t-xs muted" id={`${id}-hint`}>
        다른 사람과 함께 쓰는 기기라면 지워 주세요. 지우면 입장 시작 전에 다시 받아야 하고(티켓마다 24시간에 한 번), 입장이 시작된 뒤에는 현장 부스에서 받습니다.
      </p>
    </WebShellModal>
  );
}
