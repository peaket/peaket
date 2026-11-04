// CMP-009 Checkbox·ConsentCheckbox 이야기(d2 §2 CMP-009)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ConsentCheckbox } from '../ConsentCheckbox';
import { Checkbox } from './Checkbox';

const meta: Meta<typeof Checkbox> = { title: 'CMP-009 Checkbox', component: Checkbox, args: { id: 'cb', label: '알림 받기' } };
export default meta;
type Story = StoryObj<typeof Checkbox>;

export const Unchecked: Story = {};
export const Checked: Story = { args: { defaultChecked: true } };
export const WithHint: Story = { args: { hint: '판매 시작 10분 전에 알려 드립니다' } };
export const Invalid: Story = { args: { error: '알림을 받으려면 체크해 주세요' } };
export const Disabled: Story = { args: { disabled: true, defaultChecked: true } };
export const Focus: Story = { args: { showFocus: true } };
export const Consents: Story = {
  render: () => (
    <div className="col" style={{ gap: 8, maxWidth: 360 }}>
      <ConsentCheckbox id="c1" label="이용약관 동의" requirement="required" detailHref="#terms" />
      <ConsentCheckbox id="c2" label="개인정보 수집·이용 동의" requirement="required" detailHref="#privacy" defaultChecked />
      <ConsentCheckbox id="c3" label="마케팅 정보 받기" requirement="optional" />
    </div>
  ),
};
