// CMP-010 Select 이야기(d2 §2 CMP-010)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Select } from './Select';

const options = [
  { value: '1', label: '1매' },
  { value: '2', label: '2매' },
  { value: '4', label: '4매', disabled: true },
];
const meta: Meta<typeof Select> = { title: 'CMP-010 Select', component: Select, args: { id: 'sel', label: '매수', options, placeholder: '매수를 고르세요' } };
export default meta;
type Story = StoryObj<typeof Select>;

export const Placeholder: Story = {};
export const Selected: Story = { args: { defaultValue: '2' } };
export const Invalid: Story = { args: { error: '매수를 골라 주세요' } };
export const Disabled: Story = { args: { disabled: true } };
export const Small: Story = { args: { size: 'sm' } };
