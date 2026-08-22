import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReservationBody } from './reservation-params.js';

test('좌석지정 예약 요청에 승객 종류와 선택 좌석을 정확히 넣는다', () => {
  const body = buildReservationBody({
    train: {
      h_chg_trn_dv_cd: '1', h_run_dt: '20260823', h_trn_no: '001',
      h_trn_gp_cd: '100', h_trn_clsf_cd: '00', h_dpt_dt: '20260823',
      h_dpt_tm: '051300', h_dpt_rs_stn_cd: '0001', h_dpt_stn_cons_ordr: '000001',
      h_dpt_stn_run_ordr: '000001', h_arv_rs_stn_cd: '0020',
      h_arv_stn_cons_ordr: '000007', h_arv_stn_run_ordr: '000007', h_seat_att_cd: '015',
    },
    seatClassCode: '1',
    seats: [{ srcarNo: 10, seat_no: '47' }, { srcarNo: 10, seat_no: '48' }],
    passengers: { adults: 1, children: 0, infants: 1, seniors: 0 },
    date: '20260823',
  });
  const params = new URLSearchParams(body);
  assert.equal(params.get('txtJobId'), '1101');
  assert.equal(params.get('txtCompaCnt1'), '1');
  assert.equal(params.get('txtDiscKndCd1'), '000');
  assert.equal(params.get('txtCompaCnt4'), '1');
  assert.equal(params.get('txtDiscKndCd4'), '321');
  assert.equal(params.get('txtSrcarNo1'), '10');
  assert.equal(params.get('txtSeatNo1'), '47');
  assert.equal(params.get('txtSeatNo2'), '48');
});

test('환승 여정은 일부 구간만 잘못 예약하지 않도록 거부한다', () => {
  assert.throws(() => buildReservationBody({
    train: { h_chg_trn_dv_cd: '2' }, seatClassCode: '1', seats: [],
    passengers: { adults: 1, children: 0, infants: 0, seniors: 0 }, date: '20260823',
  }), /환승 여정/);
});

