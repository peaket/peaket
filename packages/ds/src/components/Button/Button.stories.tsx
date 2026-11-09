// CMP-001 Button 이야기: 변형·크기·상태마다 하나(d2 §2 CMP-001, §3.6 이유 있는 비활성, FE-T18·FE-T40)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Button } from './Button';
import { ButtonLink } from './ButtonLink';

const meta: Meta<typeof Button> = { title: 'CMP-001 Button', component: Button, args: { children: '예매하기' } };
export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {};
export const Variants: Story = {
  render: () => (
    <div className="row wrap" style={{ gap: 8 }}>
      <Button variant="primary">기본</Button>
      <Button variant="secondary">보조</Button>
      <Button variant="outline">외곽선</Button>
      <Button variant="ghost">고스트</Button>
      <Button variant="text">글자</Button>
      <Button variant="danger">위험</Button>
      <Button variant="danger-outline">위험 외곽선</Button>
    </div>
  ),
};
export const Sizes: Story = {
  render: () => (
    <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
      <Button size="sm">작게</Button>
      <Button size="md">보통</Button>
      <Button size="lg">크게</Button>
      <Button size="xl">아주 크게</Button>
      <Button size="field">현장</Button>
    </div>
  ),
};
export const Providers: Story = {
  render: () => (
    <div className="col" style={{ gap: 8, maxWidth: 320 }}>
      <Button variant="kakao" block>
        카카오로 계속하기
      </Button>
      <Button variant="naver" block>
        네이버로 계속하기
      </Button>
      <Button variant="google" block>
        Google로 계속하기
      </Button>
    </div>
  ),
};
export const WithIcon: Story = { args: { icon: 'search', children: '검색' } };
export const Loading: Story = { args: { loading: true, children: '결제하는 중' } };
export const Disabled: Story = { args: { disabled: true, children: '잠시 막힘' } };
/** d2 §3.6: 초점은 받고 누르기·Enter·Space는 막으며, 늘 보이는 이유 글을 aria-describedby로 잇는다 */
export const DisabledWithReason: Story = {
  args: { disabledReason: '필수 동의 두 개에 체크하면 결제할 수 있습니다', children: '결제하기', block: true },
};
/** 이유 글을 화면 머리 배너 하나에 두고 여러 버튼이 그 id를 가리킨다 */
export const DisabledReasonElsewhere: Story = {
  render: () => (
    <div className="col" style={{ gap: 12 }}>
      <p id="perm-reason" className="t-sm">
        판매 일시정지는 commander만 실행할 수 있습니다
      </p>
      <div className="row" style={{ gap: 8 }}>
        <Button variant="danger" disabledReasonId="perm-reason">
          판매 일시정지
        </Button>
        <Button variant="outline" disabledReasonId="perm-reason">
          대기열 다시 열기
        </Button>
      </div>
    </div>
  ),
};
export const AsLink: Story = {
  render: () => (
    <ButtonLink href="#events" variant="outline">
      공연 보러 가기
    </ButtonLink>
  ),
};

function ReasonGuardDemo() {
  const [clicks, setClicks] = useState(0);
  const [submits, setSubmits] = useState(0);
  return (
    <form
      className="col"
      style={{ gap: 8, maxWidth: 360 }}
      onSubmit={(e) => {
        e.preventDefault();
        setSubmits((n) => n + 1);
      }}
    >
      <Button type="submit" disabledReason="필수 동의 두 개에 체크하면 결제할 수 있습니다" onClick={() => setClicks((n) => n + 1)} block>
        결제하기
      </Button>
      <output data-testid="clicks">{clicks}</output>
      <output data-testid="submits">{submits}</output>
    </form>
  );
}
/** 이유 있는 비활성 버튼이 누르기·Enter·Space·폼 제출을 막는지 보는 이야기(FE-T18, d2 §3.6) */
export const ReasonGuard: Story = { render: () => <ReasonGuardDemo /> };
