// payment-svc 종료 차례(BUILD_ORDER HOT-150 코드 리뷰 L9). main.ts는 프로세스 전체를 띄워 이 파일이 차례만 따로 본다.
import { describe, expect, test } from 'vitest';
import { shutdownInOrder, type ShutdownSteps } from '../src/shutdown.js';

function steps(o: { stop?: Promise<unknown>[]; closeService?: () => Promise<void> } = {}) {
  const order: string[] = [];
  const errors: unknown[] = [];
  const value: ShutdownSteps = {
    stop: () => o.stop ?? [Promise.resolve()],
    closeService: async () => {
      order.push('service');
      await o.closeService?.();
    },
    closeConnections: () => {
      order.push('connections');
      return [Promise.resolve(), undefined];
    },
    onError: (err) => errors.push(err),
  };
  return { value, order, errors };
}

describe('shutdownInOrder', () => {
  test('P-T53_리뷰 고침 L9: 멈추기가 실패해도 서비스를 닫고 그 뒤에 연결을 닫으며 실패를 알린다', async () => {
    const failure = new Error('멈추지 못했다');
    const { value, order, errors } = steps({ stop: [Promise.reject(failure)] });
    await shutdownInOrder(value);
    expect(order).toEqual(['service', 'connections']);
    expect(errors).toEqual([failure]);
  });

  test('P-T53_리뷰 고침 L9: 멈추기 하나가 실패해도 나머지 멈추기가 끝난 뒤에 서비스를 닫는다(돌던 쓰기가 닫힌 풀을 만나지 않는다)', async () => {
    let finishSlow: () => void = () => {};
    let slowDone = false;
    const slow = new Promise<void>((resolve) => {
      finishSlow = () => {
        slowDone = true;
        resolve();
      };
    });
    let serviceSawSlowDone = false;
    const { value } = steps({
      stop: [Promise.reject(new Error('실패')), slow],
      closeService: async () => {
        serviceSawSlowDone = slowDone;
      },
    });
    const done = shutdownInOrder(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishSlow();
    await done;
    expect(serviceSawSlowDone).toBe(true);
  });

  test('P-T53_리뷰 고침 L9: 서비스 닫기가 실패해도 연결을 닫고 실패를 알린다', async () => {
    const failure = new Error('닫지 못했다');
    const { value, order, errors } = steps({
      closeService: async () => {
        throw failure;
      },
    });
    await shutdownInOrder(value);
    expect(order).toEqual(['service', 'connections']);
    expect(errors).toEqual([failure]);
  });

  test('P-T53_정상 종료는 멈추기 → 서비스 → 연결 차례이고 실패를 알리지 않는다', async () => {
    const { value, order, errors } = steps();
    await shutdownInOrder(value);
    expect(order).toEqual(['service', 'connections']);
    expect(errors).toEqual([]);
  });
});
