import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseBestSeatOption, isFourFacing, isSideBySide } from './seat-selection.js';

const seat = (spec, options = {}) => ({
  seat_no: String(options.no ?? spec.replace(/\D/g, '')),
  seat_spec: spec,
  sale_psb_flg: 'Y',
  dir_seat_att_cd: options.direction || '009',
  intg_msg_cd: options.fourFacing ? 'MRR000013' : '',
  intg_msg: options.fourFacing ? 'KTX 4인동반석 순방향 좌석 입니다.' : '',
});

test('같은 행의 A-B, C-D를 붙은 좌석으로 판단한다', () => {
  assert.equal(isSideBySide(seat('4A'), seat('4B')), true);
  assert.equal(isSideBySide(seat('4B'), seat('4C')), false);
  assert.equal(isSideBySide(seat('4C'), seat('4D')), true);
});

test('유아가 있으면 순방향 단독석보다 역방향 인접석을 선택한다', () => {
  const result = chooseBestSeatOption([{ carNo: 9, seats: [
    seat('1A'), seat('2D'),
    seat('8A', { direction: '010' }), seat('8B', { direction: '010' }),
  ] }], { adults: 1, children: 0, infants: 1, seniors: 0 });
  assert.deepEqual(result.seats.map(item => item.seat_spec), ['8A', '8B']);
});

test('다른 승객이 있어도 예약 승객 순서에서 성인과 유아를 인접석으로 매핑한다', () => {
  const result = chooseBestSeatOption([{ carNo: 9, seats: [
    seat('3A'), seat('3B'), seat('7C'),
  ] }], { adults: 1, children: 1, infants: 1, seniors: 0 });
  assert.equal(isSideBySide(result.seats[0], result.seats[2]), true);
});

test('유아보다 성인이 적으면 안전하게 거부한다', () => {
  assert.throws(() => chooseBestSeatOption([{ carNo: 9, seats: [seat('1A'), seat('1B')] }], {
    adults: 0, children: 0, infants: 1, seniors: 0,
  }), /성인 수가 유아 수 이상/);
});

test('여러 명이면 붙은 좌석 쌍을 최대화한다', () => {
  const result = chooseBestSeatOption([{ carNo: 9, seats: [
    seat('1A'), seat('1B'), seat('2C'), seat('2D'), seat('7A'), seat('9D'),
  ] }], { adults: 4, children: 0, infants: 0, seniors: 0 });
  assert.equal(result.metrics.pairCount, 2);
});

test('인접 조건이 같으면 순방향을 우선한다', () => {
  const result = chooseBestSeatOption([{ carNo: 9, seats: [
    seat('1A', { direction: '010' }), seat('1B', { direction: '010' }),
    seat('5C'), seat('5D'),
  ] }], { adults: 2, children: 0, infants: 0, seniors: 0 });
  assert.deepEqual(result.seats.map(item => item.seat_spec), ['5C', '5D']);
});

test('방향과 인접 조건이 같으면 4인동반석을 피한다', () => {
  const facing = seat('8A', { fourFacing: true });
  assert.equal(isFourFacing(facing), true);
  const result = chooseBestSeatOption([{ carNo: 9, seats: [
    facing, seat('8B', { fourFacing: true }), seat('12C'), seat('12D'),
  ] }], { adults: 2, children: 0, infants: 0, seniors: 0 });
  assert.deepEqual(result.seats.map(item => item.seat_spec), ['12C', '12D']);
});

test('좌석 조건이 같으면 중앙 호차를 선택한다', () => {
  const result = chooseBestSeatOption([
    { carNo: 1, seats: [seat('1A'), seat('1B')] },
    { carNo: 9, seats: [seat('1A'), seat('1B')] },
    { carNo: 18, seats: [seat('1A'), seat('1B')] },
  ], { adults: 2, children: 0, infants: 0, seniors: 0 });
  assert.equal(result.carNo, 9);
});
