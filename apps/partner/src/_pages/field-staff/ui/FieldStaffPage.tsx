// SCR-037 현장 스태프·현장 운영(/events/[id]/staff). 보드 SCR-037-m·t·d를 한 페이지 반응형으로 합쳤다(d5 §6.11, §3.9).
// 하위 탭 [스태프](초대·배정 명단·요약)와 [현장 운영](공연 당일 입장 현장). 휴대폰에서도 전부 한다(d5 §3.9 SCR-037 '전부').
// 개인정보는 보이지 않는다: 스태프는 닉네임·역할·수락 여부·건수만(docs/security/data-classification.md).
import { requireProduction } from '@/entities/production';
import { routes } from '@/shared/config/routes';
import { STAFF_OPS_STATES, STAFF_STATES, type StaffState } from '@/shared/config/states/scr037';
import { readPreview, type RouteProps } from '@/shared/lib/preview';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { EventContextHeader } from '@/widgets/event-context';
import { opsData, placements, staffRows, type OpsMode } from '../model/fixtures';
import { PlacementDialog, RevokeDialog } from './Dialogs';
import { OpsPanel } from './OpsPanel';
import { StaffPanel } from './StaffPanel';
import { SubTabs } from './SubTabs';

function opsModeOf(state: StaffState): OpsMode {
  if (state === '입장 전 준비') return 'pre';
  if (state === '입장 기록 마감 뒤') return 'closed';
  return 'live';
}

/** 회차 고르기 아래 줄(보드 hdrDuring·hdrBefore·hdrClosed) */
function headLine(state: StaffState, isOps: boolean, mode: OpsMode): string {
  if (isOps && mode === 'closed') return '공연 종료 · 입장 기록 마감 23:12 KST · 재입장 불가';
  if (state === '빈 화면' || (isOps && mode === 'pre')) return '입장 시작 10/25(일) 16:30 KST · 스태프 권한 13:30 KST부터 · 재입장 불가';
  return '입장 중 · 공연 시작 18:00 KST · 스태프 권한 22:00 KST까지 · 재입장 불가';
}

/** 상태 미리보기에서 열어 둘 배치 바꾸기 대상(보드는 동문-04) */
const PREVIEW_DEVICE = '동문-04';
/** 상태 미리보기에서 열어 둘 권한 해제 대상(보드는 도윤) */
const PREVIEW_REVOKE = 'gs-doyun';

export default async function FieldStaffPage({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  const pv = readPreview(await searchParams, STAFF_STATES, '스태프');
  const production = requireProduction(id);
  const isOps = STAFF_OPS_STATES.includes(pv.state);
  const mode = opsModeOf(pv.state);
  const data = opsData(mode, pv.state === '이상 표시 없음');
  const placeOpen = pv.state === '배치 바꾸기' || pv.state === '퇴장 모드 불가';
  const rounds = production.rounds;
  const roundLabel = rounds[0]?.startsAt ?? '회차';
  const keep = new URLSearchParams(Object.entries(pv.keep).filter((e): e is [string, string] => e[1] !== undefined)).toString() || undefined;

  return (
    <>
      <EventContextHeader production={production} current="staff" keep={keep} />

      <section className="col" style={{ gap: 16 }} aria-labelledby="gs-h">
        <div className="row between wrap max-md:flex-col max-md:items-stretch md:items-end" style={{ gap: 12 }}>
          <div className="col" style={{ gap: 4 }}>
            <h2 className="t-lg" id="gs-h">
              현장 스태프·현장 운영
            </h2>
            <span className="t-sm muted">{headLine(pv.state, isOps, mode)}</span>
          </div>
          <div className="field md:w-[232px] lg:w-[260px]">
            <label className="label" htmlFor="gs-round">
              회차
            </label>
            <div className="input-group md:h-10 md:[&_select]:text-sm">
              <select id="gs-round" defaultValue={rounds[0]?.id}>
                {rounds.length === 0 ? <option>회차 없음</option> : null}
                {rounds.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.startsAt}
                  </option>
                ))}
              </select>
              <i className="ic ic-chevron-down" aria-hidden="true" />
            </div>
          </div>
        </div>

        <SubTabs
          key={pv.state}
          initial={isOps ? 'ops' : 'staff'}
          staff={<StaffPanel roundLabel={roundLabel} inviteFail={pv.state === '초대 실패'} empty={pv.state === '빈 화면'} />}
          ops={<OpsPanel mode={mode} data={data} />}
        />
      </section>

      {staffRows
        .filter((r) => r.canRevoke)
        .map((r) => (
          <RevokeDialog key={`${pv.state}-${r.id}`} row={r} defaultOpen={pv.state === '권한 해제 확인' && r.id === PREVIEW_REVOKE} />
        ))}
      {placements.map((p, i) => {
        const preview = placeOpen && p.device === PREVIEW_DEVICE;
        return (
          <PlacementDialog
            key={`${pv.state}-${p.device}`}
            index={i}
            placement={p}
            defaultOpen={preview}
            pendingZone={preview ? '서문' : undefined}
            exitError={preview && pv.state === '퇴장 모드 불가'}
          />
        );
      })}

      <PreviewStateSwitcher path={routes.eventTab(id, 'staff')} states={STAFF_STATES} current={pv.state} keep={pv.keep} />
    </>
  );
}
