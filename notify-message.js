/**
 * 텔레그램·콘솔에 보낼 문구를 만든다. 전송은 하지 않는다.
 * 날짜는 사용자가 입력한 표기(YYYY-MM-DD)를 그대로 쓰므로 dateLabel로 받는다.
 */

export const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** 코레일이 주는 HHMMSS 등을 HH:MM으로 */
export const rawTimeLabel = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return String(value || '');
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
};

export const reservationPaymentLabel = (data) => data.h_pay_limit_msg
  || (data.h_stl_lmt_tm ? rawTimeLabel(String(data.h_stl_lmt_tm).slice(-6)) : '')
  || '코레일 예약내역에서 확인';

/** 감시 조건 한 줄: "00:00~18:30" 또는 상한이 없으면 "00:00~" */
export const departureRangeLabel = (timeLabel, timeToLabel) =>
  timeToLabel ? `${timeLabel}~${timeToLabel}` : `${timeLabel}~`;

export const buildVacancyMessage = ({ from, to, dateLabel, rangeLabel, hits }) => {
  const lines = hits.map(hit => `🚄 <b>${hit.name}</b>  ${hit.dep}→${hit.arv}\n   ${hit.label} ${hit.seatSelectable ? `좌석선택 가능${hit.carCount ? ` (${hit.carCount}개 호차)` : ''}` : '예약가능'} ${hit.price ? '(' + hit.price + ')' : ''}`);
  return `<b>🟢 코레일 공석 발생!</b>\n${from} → ${to}  ${dateLabel} ${rangeLabel}\n\n${lines.join('\n')}\n\n👉 코레일 앱/웹에서 서둘러 예매하세요.`;
};

/** 예약 완료 알림과 콘솔 한 줄을 함께 만든다(같은 값에서 파생되므로). */
export const buildReservationMessage = ({ from, to, dateLabel, train, seat, option, data }) => {
  const name = `${train.h_trn_clsf_nm || 'KTX'} ${train.h_trn_no}`;
  const seatLabels = option.seats.map(item => `${option.carNo}호차 ${item.seat_spec}`).join(', ');
  const payment = reservationPaymentLabel(data);
  const pnr = data.h_pnr_no || data.str_pnr_no || '';
  const message = [
    '<b>✅ 코레일 예약 완료</b>',
    `${escapeHtml(from)} → ${escapeHtml(to)}  ${escapeHtml(dateLabel)}`,
    '',
    `🚄 <b>${escapeHtml(name)}</b>  ${escapeHtml(train.h_dpt_tm_qb || rawTimeLabel(train.h_dpt_tm))}→${escapeHtml(train.h_arv_tm_qb || rawTimeLabel(train.h_arv_tm))}`,
    `좌석: ${escapeHtml(seat.label)} / ${escapeHtml(seatLabels)}`,
    pnr ? `예약번호: ${escapeHtml(pnr)}` : '',
    `결제기한: ${escapeHtml(payment)}`,
    '',
    '👉 기한 내 코레일 앱/웹에서 결제하세요.',
    // 빈 줄은 구분용 한 줄만 남기고 연속된 빈 줄은 접는다.
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');

  const summary = `${name} ${seatLabels} | 결제기한 ${payment}${pnr ? ` | 예약번호 ${pnr}` : ''}`;
  return { message, summary, name, seatLabels, payment, pnr };
};
