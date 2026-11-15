// CMP-006 PasswordField 이야기(d2 §2 CMP-006, docs/design/d4-handoff-checklist.md #25, FE-T18 붙여넣기·FE-T40).
// BAT-170 웨이브 7: 시험 담당(l2w7-BAT170-test)이 붙여넣기 시험(tools/web-checks/ds/behavior.spec.mjs)용으로 더했다.
// 기존 CMP-004 TextField 이야기의 Password·PasswordVisible은 그대로 두고, 여기에는 로그인(current) 칸의 붙여넣기 대상만 둔다.
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { PasswordField } from './PasswordField';

const meta: Meta<typeof PasswordField> = { title: 'CMP-006 PasswordField', component: PasswordField, args: { id: 'pw-current', label: '비밀번호', kind: 'current' } };
export default meta;
type Story = StoryObj<typeof PasswordField>;

export const Current: Story = {};

function PasteProbe() {
  const [value, setValue] = useState('');
  return (
    <div className="col" style={{ gap: 8 }}>
      <PasswordField id="pw-paste" label="비밀번호" kind="current" onChange={(e) => setValue(e.target.value)} />
      <output data-testid="pw-length">{value.length}</output>
    </div>
  );
}
export const Paste: Story = { render: () => <PasteProbe /> };
