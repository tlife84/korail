const PASSENGER_TYPES = [
  { key: 'adults', reserveIdx: '1', passengerCode: '1', discountCode: '000' },
  { key: 'children', reserveIdx: '3', passengerCode: '3', discountCode: '000' },
  { key: 'infants', reserveIdx: '4', passengerCode: '3', discountCode: '321' },
  { key: 'seniors', reserveIdx: '5', passengerCode: '1', discountCode: '131' },
];

export const buildReservationBody = ({ train, seatClassCode, seats, passengers, date }) => {
  if (train.h_chg_trn_dv_cd && train.h_chg_trn_dv_cd !== '1') {
    throw new Error('환승 여정 자동 예약은 아직 지원하지 않습니다.');
  }
  const total = Object.values(passengers).reduce((sum, count) => sum + (Number(count) || 0), 0);
  const params = {
    Device: 'IP', Version: '999999999',
    txtJobId: '1101', txtMenuId: '11', pnrNo: '',
    txtTotPsgCnt: String(total), txtStndFlg: 'N', h_fmly_use_flg: 'N',
    txtJrnyCnt: '1', txtSeatAttCd1: '000', txtSeatAttCd2: '000',
    txtSeatAttCd3: '000', txtSeatAttCd5: '000', hidFreeFlg: 'N', txtCompaCnt2: '0',
    txtJrnyTpCd1: '11', txtJrnySqno1: '001',
    txtRunDt1: train.h_run_dt || date,
    txtTrnNo1: train.h_trn_no || '',
    txtTrnGpCd1: train.h_trn_gp_cd || '',
    txtTrnClsfCd1: train.h_trn_clsf_cd || '',
    txtDptDt1: train.h_dpt_dt || train.h_run_dt || date,
    txtDptTm1: train.h_dpt_tm || '',
    txtDptRsStnCd1: train.h_dpt_rs_stn_cd || '',
    txtDptStnConsOrdr1: train.h_dpt_stn_cons_ordr || '',
    txtDptStnRunOrdr1: train.h_dpt_stn_run_ordr || '',
    txtArvRsStnCd1: train.h_arv_rs_stn_cd || '',
    txtArvStnConsOrdr1: train.h_arv_stn_cons_ordr || '',
    txtArvStnRunOrdr1: train.h_arv_stn_run_ordr || '',
    txtChgFlg1: 'N', txtPsrmClCd1: seatClassCode,
    txtSeatAttCd4: train.h_seat_att_cd || '015',
    txtSrcarCnt: String(seats.length),
  };

  for (const type of PASSENGER_TYPES) {
    const count = Number(passengers[type.key]) || 0;
    if (!count) continue;
    params[`txtCompaCnt${type.reserveIdx}`] = String(count);
    params[`txtPsgTpCd${type.reserveIdx}`] = type.passengerCode;
    params[`txtDiscKndCd${type.reserveIdx}`] = type.discountCode;
  }
  seats.forEach((selected, index) => {
    params[`txtSrcarNo${index + 1}`] = String(selected.srcarNo);
    params[`txtSeatNo${index + 1}`] = String(selected.seat_no);
  });
  return new URLSearchParams(params).toString();
};

