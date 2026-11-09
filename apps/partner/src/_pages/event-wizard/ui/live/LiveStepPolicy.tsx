// 4단계 판매 정책(실제 입력, ADR-0118, ADR-0245). 정렬 방식 이름은 회차의 정렬 설정 두 값으로 저장한다(model/form.ts).
import { FIFO_WARNING, queueModes } from '../../model/fixtures';
import type { QueueOrder, SeatAssignment } from '../../model/form';
import { ChoiceCards } from '../parts/ChoiceCards';
import { LimitStepper } from '../parts/LimitStepper';
import { PREVIEW_TITLE, SEAT_CHOICES } from '../parts/policy-choices';
import { FieldMessage, type StepProps } from './fields';

export function LiveStepPolicy({ draft, update, errorOf }: StepProps) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-12">
      <section className="card pad-lg col lg:col-span-7" style={{ gap: 16 }} aria-labelledby="h-n-ord">
        <div className="section-title">
          <h2 id="h-n-ord">대기열 정렬 방식</h2>
        </div>
        <div id="n-ord" tabIndex={-1}>
          <ChoiceCards
            name="n-ord"
            legend="정렬 방식"
            required
            choices={queueModes.map((m) => ({ value: m.value, title: m.label, desc: m.desc, flags: m.flags, preview: m.preview }))}
            defaultValue="HYBRID"
            value={draft.queueOrder}
            onValueChange={(v) => update({ queueOrder: v as QueueOrder }, 'queueOrder')}
            badgeFor={{ value: 'HYBRID', text: '기본', tone: 'primary' }}
            warnFor={{ value: 'FIFO', text: FIFO_WARNING }}
            previewTitle={PREVIEW_TITLE}
            hint={<p className="hint">고른 방식은 회차의 정렬 설정 두 값(로비 셔플·오픈 직후 묶음)으로 저장합니다. 둘 다 끈 조합은 고를 수 없습니다</p>}
          />
        </div>
        <FieldMessage id="n-ord" error={errorOf('queueOrder')} />
      </section>

      <div className="col gap-5 lg:col-span-5">
        <section className="card pad-lg col" style={{ gap: 16 }} aria-labelledby="h-n-asg">
          <div className="section-title">
            <h2 id="h-n-asg">좌석 배정과 구매 한도</h2>
          </div>
          <ChoiceCards
            name="n-asg"
            legend="좌석 배정 방식"
            required
            choices={SEAT_CHOICES}
            defaultValue="PICK"
            value={draft.seatAssignment}
            onValueChange={(v) => update({ seatAssignment: v as SeatAssignment }, 'seatAssignment')}
            padding="12px 14px"
            badgeFor={{ value: 'PICK', text: '기본', tone: 'primary' }}
            extraFor={{ value: 'AUTO', node: <p className="hint">좌석은 등급 안에서 자동으로 배정됩니다. 선호 기준은 무대 중앙 인접 순입니다</p> }}
          />
          <div className="field">
            <span className="label" id="n-limit-l" tabIndex={-1}>
              1인 한도
            </span>
            <LimitStepper labelId="n-limit-l" defaultValue={4} value={draft.perPersonLimit} onValueChange={(perPersonLimit) => update({ perPersonLimit }, 'perPersonLimit')} />
            <span className="hint">한 공연에서 한 사람이 살 수 있는 매수입니다</span>
            <FieldMessage id="n-limit-l" error={errorOf('perPersonLimit')} />
          </div>
        </section>

        <section className="card pad-lg col" style={{ gap: 12 }} aria-labelledby="h-n-rule">
          <div className="section-title">
            <h2 id="h-n-rule">판매 정책 규칙과 공연 규모</h2>
          </div>
          <p className="t-sm">팬클럽 선예매처럼 자격·기간에 따라 달라지는 조건은 공연을 등록한 뒤 판매 정책에서 정합니다.</p>
          <p className="hint">공연 규모는 판매 승인 때 운영자가 확정합니다.</p>
        </section>
      </div>
    </div>
  );
}
