// ds QueuePanel의 숫자 굴림 자리 견주기가 대기실 셸(apps/web/queue-room/src/ui/roll.ts)과 같은 결과인지(ADR-0220: 같은 그림)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollDigits } from './roll.ts';
import { rollDigits as shellRoll } from '../../../../../apps/web/queue-room/src/ui/roll.ts';

test('FE-T40 React 대기 패널의 숫자 굴림 자리는 셸과 같다', () => {
  const cases = [['3,214', undefined], ['3,209', '3,214'], ['999', '1,000'], ['10', '9'], ['18', '18'], ['1,000', '999']];
  for (const [now, before] of cases) assert.deepEqual(rollDigits(now, before), shellRoll(now, before), `${before} → ${now}`);
});
