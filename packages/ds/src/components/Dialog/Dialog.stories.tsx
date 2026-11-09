// CMP-019 Dialog · CMP-020 DangerConfirm 이야기(d2 §2, §3.4 모달 패턴, §3.5 단계적 확인)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { Button } from '../Button';
import { DangerConfirm } from '../DangerConfirm';
import { Dialog } from './Dialog';

const meta: Meta<typeof Dialog> = {
  title: 'CMP-019 Dialog',
  component: Dialog,
  parameters: { layout: 'fullscreen' },
  args: { open: true, onClose: () => {}, title: '예매를 취소할까요?', description: '취소하면 좌석이 다른 분께 돌아갑니다.' },
};
export default meta;
type Story = StoryObj<typeof Dialog>;

const actions = (
  <>
    <Button variant="outline">닫기</Button>
    <Button variant="danger">예매 취소</Button>
  </>
);
export const Open: Story = { args: { actions } };
export const WithIcon: Story = { args: { actions, icon: 'alert', iconTone: 'warning' } };
export const Sheet: Story = { args: { actions, layout: 'sheet' } };
export const Alert: Story = {
  args: { role: 'alertdialog', actions, icon: 'alert-circle', iconTone: 'danger', iconPlacement: 'inline', dismissible: false },
};

function InteractiveDialog() {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState('');
  return (
    <>
      <Button onClick={() => setOpen(true)}>대화상자 열기</Button>
      <p className="t-sm" id="outside">
        바깥 내용 <button type="button">바깥 버튼</button>
      </p>
      <output data-testid="log">{log}</output>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setLog('닫힘');
        }}
        title="좌석을 놓을까요?"
        description="놓으면 다른 분이 고를 수 있습니다."
        actions={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              닫기
            </Button>
            <Button onClick={() => setOpen(false)}>놓기</Button>
          </>
        }
      />
    </>
  );
}
/** 버튼으로 열고 Esc·바깥·닫기로 닫는다. 닫히면 연 버튼으로 초점이 돌아온다 */
export const Interactive: Story = { parameters: { layout: 'padded' }, render: () => <InteractiveDialog /> };
function AlertGuardDemo() {
  const [closes, setCloses] = useState(0);
  return (
    <>
      <output data-testid="closes">{closes}</output>
      <Dialog
        open
        role="alertdialog"
        dismissible={false}
        onClose={() => setCloses((n) => n + 1)}
        title="결제 시간이 1분 남았습니다"
        description="시간이 지나면 좌석이 풀립니다."
        actions={<Button>계속 결제하기</Button>}
      />
    </>
  );
}
/** dismissible이 거짓이면 Esc·바깥 누르기가 onClose를 부르지 않는다(닫힘 횟수 0) */
export const AlertGuard: Story = { render: () => <AlertGuardDemo /> };

function InitialFocusDemo() {
  const [open, setOpen] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button onClick={() => setOpen(true)}>환불 확인 열기</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        role="alertdialog"
        title="환불을 요청할까요?"
        initialFocus={confirmRef}
        actions={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              닫기
            </Button>
            <Button ref={confirmRef} onClick={() => setOpen(false)}>
              환불 요청
            </Button>
          </>
        }
      />
    </>
  );
}
/** initialFocus로 준 요소(둘째 버튼)에 열 때 초점이 간다 */
export const InitialFocus: Story = { parameters: { layout: 'padded' }, render: () => <InitialFocusDemo /> };
export const DangerFan: Story = {
  render: () => (
    <DangerConfirm open onClose={() => {}} onConfirm={() => {}} title="양도를 취소할까요?" description="상대가 받은 제안이 사라집니다." confirmLabel="양도 취소" />
  ),
};
export const DangerOps: Story = {
  render: () => (
    <DangerConfirm
      open
      variant="ops"
      onClose={() => {}}
      onConfirm={() => {}}
      title="판매를 일시정지할까요?"
      description="대기열 진입이 멈춥니다."
      confirmLabel="판매 일시정지"
      confirmPhrase="LUMEN 1025"
    />
  ),
};
