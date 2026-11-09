// CMP-010 RadioGroup 이야기(d2 §2 CMP-010)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { RadioGroup } from './RadioGroup';

const options = [
  { value: 'card', label: '신용·체크카드' },
  { value: 'bank', label: '계좌 이체', description: '은행 앱에서 승인합니다' },
  { value: 'pay', label: '간편 결제', disabled: true },
] as const;
const meta: Meta<typeof RadioGroup> = {
  title: 'CMP-010 RadioGroup',
  component: RadioGroup,
  args: { name: 'pay', legend: '결제 수단', options, defaultValue: 'card' },
};
export default meta;
type Story = StoryObj<typeof RadioGroup>;

export const Vertical: Story = {};
export const Horizontal: Story = { args: { orientation: 'horizontal', options: options.slice(0, 2) } };
export const Invalid: Story = { args: { defaultValue: undefined, error: '결제 수단을 하나 골라 주세요', required: true } };
export const Disabled: Story = { args: { disabled: true } };
