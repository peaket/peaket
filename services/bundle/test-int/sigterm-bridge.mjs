// 시험 전용 --import 파일: 부모가 IPC로 'SIGTERM'을 보내면 이 프로세스에 SIGTERM을 낸다(services/payment-svc/test-int/sigterm-bridge.mjs와 같다).
// Windows의 child.kill('SIGTERM')은 처리기를 부르지 않고 프로세스를 바로 끝내 우아한 종료를 볼 수 없다. Linux(CI)는 진짜 신호를 쓰고 이 길을 타지 않는다.
// 채널을 unref해 이 파일이 프로세스를 붙잡지 않게 한다(처리기가 일을 마치면 프로세스가 스스로 끝나야 한다).
process.on('message', (m) => {
  if (m === 'SIGTERM') process.emit('SIGTERM', 'SIGTERM');
});
process.channel?.unref();
