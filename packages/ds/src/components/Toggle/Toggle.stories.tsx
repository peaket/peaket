// CMP-011 Toggle 이야기(d2 §2 CMP-011)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Toggle } from './Toggle';

const meta: Meta<typeof Toggle> = { title: 'CMP-011 Toggle', component: Toggle, args: { id: 'tg', label: '판매 시작 알림' } };
export default meta;
type Story = StoryObj<typeof Toggle>;

export const Off: Story = {};
export const On: Story = { args: { defaultChecked: true } };
export const WithHint: Story = { args: { hint: '앱 알림으로 보냅니다' } };
export const Disabled: Story = { args: { disabled: true, defaultChecked: true } };
export const LabelFirst: Story = { args: { labelFirst: true } };
