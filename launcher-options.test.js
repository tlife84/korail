import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWatchArgs, formatWatchCommand, normalizeTime } from './launcher-options.js';

const defaults = {
  date: '2026-08-23',
  time: '12:00',
  timeTo: '16:00',
  from: '광명',
  to: '서대전',
  adults: 1,
  children: 0,
  infants: 0,
  seniors: 0,
  seatClass: 'gen',
  interval: 60,
  mode: 'notify',
  telegram: true,
  once: false,
};

test('UI 입력을 기존 watch.js 인자로 변환한다', () => {
  const args = buildWatchArgs({
    ...defaults,
    mode: 'reserve',
    infants: 1,
    trains: ' 587, 589 ',
  });

  assert.deepEqual(args, [
    '--date', '2026-08-23', '--time', '12:00', '--from', '광명', '--to', '서대전',
    '--adults', '1', '--children', '0', '--infants', '1', '--seniors', '0',
    '--seat-class', 'gen', '--interval', '60', '--time-to', '16:00',
    '--trains', '587,589', '--reserve',
  ]);
});

test('테스트 모드와 텔레그램 해제를 플래그로 변환한다', () => {
  const args = buildWatchArgs({ ...defaults, mode: 'dry-run', once: true, telegram: false });
  assert.ok(args.includes('--dry-run-reserve'));
  assert.ok(args.includes('--once'));
  assert.ok(args.includes('--no-telegram'));
});

test('유아가 어른보다 많은 좌석선택 예약을 거부한다', () => {
  assert.throws(
    () => buildWatchArgs({ ...defaults, mode: 'reserve', adults: 1, infants: 2 }),
    /유아 수 이상의 어른/,
  );
});

test('표시용 명령어를 생성한다', () => {
  const command = formatWatchCommand(buildWatchArgs(defaults));
  assert.match(command, /^node watch\.js /);
  assert.match(command, /--from 광명/);
});

test('콜론 없는 네 자리 시간을 24시간 형식으로 교정한다', () => {
  assert.equal(normalizeTime('1200'), '12:00');
  assert.equal(normalizeTime(' 1830 '), '18:30');
  assert.equal(normalizeTime('12:00'), '12:00');

  const args = buildWatchArgs({ ...defaults, time: '1200', timeTo: '1830' });
  assert.equal(args[args.indexOf('--time') + 1], '12:00');
  assert.equal(args[args.indexOf('--time-to') + 1], '18:30');
});

test('교정 후에도 유효하지 않은 시간은 거부한다', () => {
  assert.throws(() => buildWatchArgs({ ...defaults, time: '2560' }), /시간은/);
});

test('계정과 토큰은 명령줄 인자에 넣지 않는다', () => {
  const command = formatWatchCommand(buildWatchArgs({
    ...defaults,
    korailId: '1234567890',
    korailPw: 'secret',
    telegramToken: '123456789:AAEhBOweik6ad9r-6ujKvHqAbcdefGhIjKl',
    telegramChatIds: '556744257',
  }));

  for (const secret of ['1234567890', 'secret', 'AAEhBOweik6ad9r', '556744257']) {
    assert.doesNotMatch(command, new RegExp(secret));
  }
});
