// CMP-004 TextField · CMP-006 PasswordField · CMP-008 PhoneField 이야기(d2 §2, §3.1 폼 입력 패턴)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PasswordField } from '../PasswordField';
import { PhoneField } from '../PhoneField';
import { TextField } from './TextField';

const meta: Meta<typeof TextField> = {
  title: 'CMP-004 TextField',
  component: TextField,
  args: { id: 'tf', label: '이름', hint: '예매자 본인 이름을 적어 주세요' },
};
export default meta;
type Story = StoryObj<typeof TextField>;

export const Default: Story = {};
export const Filled: Story = { args: { defaultValue: '김피켓' } };
export const Focus: Story = { args: { showFocus: true } };
export const Invalid: Story = { args: { defaultValue: '김', error: '이름이 너무 짧습니다. 두 글자 이상 적어 주세요' } };
export const Disabled: Story = { args: { disabled: true, defaultValue: '김피켓' } };
export const Optional: Story = { args: { optional: true, label: '요청 사항', hint: undefined } };
export const Small: Story = { args: { size: 'sm' } };
export const WithIcon: Story = {
  args: { id: 'tf-search', label: '공연 검색', icon: 'search', hideLabel: true, placeholder: '공연·아티스트 검색', hint: undefined },
};
export const Password: Story = { render: () => <PasswordField id="pw" label="비밀번호" kind="current" defaultValue="secret-1234" /> };
export const PasswordVisible: Story = {
  render: () => <PasswordField id="pw2" label="새 비밀번호" kind="new" defaultValue="secret-1234" defaultVisible hint="8자 이상" />,
};
export const Phone: Story = { render: () => <PhoneField id="ph" label="휴대폰 번호" /> };
