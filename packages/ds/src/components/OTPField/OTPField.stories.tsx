// CMP-007 OTPField 이야기(d2 §2 CMP-007, docs/design/d4-handoff-checklist.md #25, FE-T18 붙여넣기·FE-T40).
// BAT-170 웨이브 7: 시험 담당(l2w7-BAT170-test)이 붙여넣기 시험(tools/web-checks/ds/behavior.spec.mjs)용으로 더했다.
// Paste는 받은 값(onChange 뒤 칸의 값)을 output으로 보여 시험이 부품 밖에서 결과를 읽는다.
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { OTPField } from './OTPField';

const meta: Meta<typeof OTPField> = { title: 'CMP-007 OTPField', component: OTPField, args: { id: 'otp' } };
export default meta;
type Story = StoryObj<typeof OTPField>;

export const Default: Story = {};

function PasteProbe() {
  const [value, setValue] = useState('');
  return (
    <div className="col" style={{ gap: 8 }}>
      <OTPField id="otp-paste" onChange={(e) => setValue(e.target.value)} />
      <output data-testid="otp-value">{value}</output>
    </div>
  );
}
export const Paste: Story = { render: () => <PasteProbe /> };
