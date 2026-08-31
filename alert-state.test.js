import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlertTracker } from './alert-state.js';

test('같은 열차·등급은 한 번만 알린다', () => {
  const alerts = createAlertTracker();
  assert.equal(alerts.claim('451', '일반실'), true);
  assert.equal(alerts.claim('451', '일반실'), false);
  assert.equal(alerts.size, 1);
});

test('열차와 등급이 다르면 각각 알린다', () => {
  const alerts = createAlertTracker();
  assert.equal(alerts.claim('451', '일반실'), true);
  assert.equal(alerts.claim('451', '특실'), true);
  assert.equal(alerts.claim('453', '일반실'), true);
  assert.equal(alerts.size, 3);
});

test('매진으로 돌아가면 해제하고, 다시 공석이 나면 또 알린다', () => {
  const alerts = createAlertTracker();
  alerts.claim('451', '일반실');
  alerts.release('451', []); // 이번 주기에 선택 가능한 등급 없음
  assert.equal(alerts.has('451', '일반실'), false);
  assert.equal(alerts.claim('451', '일반실'), true, '재오픈 시 다시 알린다');
});

test('선택 가능한 등급은 해제하지 않아 중복 알림을 막는다', () => {
  const alerts = createAlertTracker();
  alerts.claim('451', '일반실');
  alerts.claim('451', '특실');
  alerts.release('451', ['일반실']);
  assert.equal(alerts.has('451', '일반실'), true, '아직 공석이므로 유지');
  assert.equal(alerts.has('451', '특실'), false, '매진됐으므로 해제');
});

test('해제는 다른 열차 상태를 건드리지 않는다', () => {
  const alerts = createAlertTracker();
  alerts.claim('451', '일반실');
  alerts.claim('453', '일반실');
  alerts.release('451', []);
  assert.equal(alerts.has('453', '일반실'), true);
});

test('좌석검증 없이 알렸던 예약가능 상태도 해제 대상이다', () => {
  const alerts = createAlertTracker();
  alerts.claim('451', '예약가능');
  alerts.release('451', []);
  assert.equal(alerts.has('451', '예약가능'), false);
});
