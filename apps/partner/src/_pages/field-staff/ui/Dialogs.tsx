// SCR-037 대화상자 둘(보드 showRevoke·showPlace): 권한 해제 확인(CMP-020 DangerConfirm 모양)과 배치 바꾸기(CMP-019, 휴대폰은 아래 시트).
// 데스크톱·태블릿은 .dialog, 휴대폰은 아래 시트 모양으로 버튼을 세로로 쌓고 주 버튼을 크게 둔다(보드 SCR-037-m .sheet).
import { Modal } from '@/shared/ui/Modal';
import type { Placement, StaffRow } from '../model/fixtures';

const ACTIONS = 'dialog-actions max-md:flex-col-reverse max-md:[&>*]:w-full';
const PRIMARY_SHEET = 'max-md:min-h-[52px] max-md:rounded-[var(--r-lg)] max-md:text-base';

function SheetHandle() {
  return <span className="sheet-handle md:hidden" aria-hidden="true" />;
}

export function revokeDialogId(row: StaffRow) {
  return `rv-${row.id}`;
}

/** 권한 해제 확인. 수락 전 초대 행은 닉네임이 없어 '수락 전 초대'로 부른다 [추천안: 보드는 수락한 스태프(도윤)만 그림] */
export function RevokeDialog({ row, defaultOpen = false }: { row: StaffRow; defaultOpen?: boolean }) {
  const id = revokeDialogId(row);
  const who = row.nickname ?? '수락 전 초대';
  return (
    <Modal id={id} labelledBy={`${id}-t`} describedBy={`${id}-d`} maxWidth={460} defaultOpen={defaultOpen} className="max-md:pt-2">
      <SheetHandle />
      <span className="state-icon is-danger" style={{ width: 48, height: 48, alignSelf: 'flex-start' }}>
        <i className="ic ic-ban" aria-hidden="true" />
      </span>
      <h2 className="dialog-title" id={`${id}-t`}>
        {who}의 권한을 해제합니다
      </h2>
      <p className="t-md" id={`${id}-d`}>
        해제하면 그 스캐너는 다음 요청부터 막히고 다음 동기화 때 로그아웃됩니다
      </p>
      <dl className="kv card-flat pad">
        <dt>역할</dt>
        <dd>{row.role}</dd>
        <dt>권한 유효 시간</dt>
        <dd>{row.validity}</dd>
        <dt>오늘 스캔</dt>
        <dd>{row.scans === null ? '—' : `${row.scans.toLocaleString('ko-KR')}건`}</dd>
      </dl>
      <p className="t-xs muted">
        인터넷에 연결되지 않은 스캐너는 연결될 때까지, 길게는 권한 유효 끝(22:00 KST)까지 계속 쓸 수 있습니다. 해제 뒤 시각의 기록은 올라오면 &apos;세션 밖
        기록&apos;으로 표시됩니다.
      </p>
      <div className={ACTIONS}>
        <button className="btn btn-ghost" type="button" data-modal-close="">
          그대로 두기
        </button>
        <button className={`btn btn-danger ${PRIMARY_SHEET}`} type="button" data-modal-close="">
          {who} 권한 해제
        </button>
      </div>
    </Modal>
  );
}

export function placementDialogId(index: number) {
  return `pc-${index}`;
}

export interface PlacementDialogProps {
  index: number;
  placement: Placement;
  defaultOpen?: boolean;
  /** 고르는 중인 구역(상태 미리보기: 보드는 동문-04를 서문으로 옮기는 중) */
  pendingZone?: string;
  /** 퇴장 모드를 골라 422가 난 모양(상태 '퇴장 모드 불가') */
  exitError?: boolean;
}

export function PlacementDialog({ index, placement, defaultOpen = false, pendingZone, exitError = false }: PlacementDialogProps) {
  const id = placementDialogId(index);
  const now = placement.zone ? `${placement.zone} · ${placement.mode ?? '입장'}` : '배치 안 함';
  return (
    <Modal id={id} labelledBy={`${id}-t`} describedBy={`${id}-d`} maxWidth={440} defaultOpen={defaultOpen} className="max-md:pt-2">
      <SheetHandle />
      <h2 className="dialog-title" id={`${id}-t`}>
        {placement.device} 배치 바꾸기
      </h2>
      <p className="t-sm muted">지금 배치: {now}</p>
      <div className="field">
        <label className="label" htmlFor={`${id}-zone`}>
          구역
        </label>
        <div className="input-group">
          <select id={`${id}-zone`} defaultValue={pendingZone ?? placement.zone ?? '배치 안 함'}>
            <option>동문</option>
            <option>서문</option>
            <option>배치 안 함</option>
          </select>
          <i className="ic ic-chevron-down" aria-hidden="true" />
        </div>
      </div>
      {exitError ? (
        <div className="field">
          <label className="label" htmlFor={`${id}-mode`}>
            모드
          </label>
          <div className="input-group is-error">
            <select id={`${id}-mode`} defaultValue="퇴장" aria-invalid="true" aria-describedby={`${id}-mode-e`}>
              <option>입장</option>
              <option>퇴장</option>
            </select>
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
          <span className="error-msg" id={`${id}-mode-e`} role="alert">
            <i className="ic ic-alert-circle" aria-hidden="true" />
            재입장 불허 회차에서는 퇴장 모드를 쓸 수 없습니다
          </span>
        </div>
      ) : (
        <div className="field">
          <label className="label" htmlFor={`${id}-mode`}>
            모드
          </label>
          <div className="input-group">
            <select id={`${id}-mode`} defaultValue="입장" aria-describedby={`${id}-mode-h`}>
              <option>입장</option>
              <option value="퇴장" disabled>
                퇴장(재입장 허용 회차만)
              </option>
            </select>
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
          <span className="hint" id={`${id}-mode-h`}>
            재입장 불허 회차에서는 퇴장 모드를 쓸 수 없습니다
          </span>
        </div>
      )}
      <p className="row t-sm" id={`${id}-d`} style={{ gap: 8, alignItems: 'flex-start' }}>
        <i className="ic ic-refresh ic-16 muted" aria-hidden="true" style={{ marginTop: 2 }} />
        <span>다음 동기화 때 그 스캐너에 적용됩니다</span>
      </p>
      <div className={ACTIONS}>
        <button className="btn btn-outline max-md:border-transparent max-md:bg-transparent" type="button" data-modal-close="">
          바꾸지 않고 닫기
        </button>
        {exitError ? (
          <button className={`btn btn-primary ${PRIMARY_SHEET}`} type="button" aria-disabled="true" aria-describedby={`${id}-mode-e`}>
            바꾸기
          </button>
        ) : (
          <button className={`btn btn-primary ${PRIMARY_SHEET}`} type="button" data-modal-close="">
            바꾸기
          </button>
        )}
      </div>
    </Modal>
  );
}
