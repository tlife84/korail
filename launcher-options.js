const SEAT_CLASSES = new Set(['gen', 'any', 'spe', 'standing']);
const MODES = new Set(['notify', 'dry-run', 'reserve']);

const requiredText = (value, label) => {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label}을(를) 입력하세요.`);
  return text;
};

const parseCount = (value, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 9) {
    throw new Error(`${label} 수는 0~9 사이의 정수여야 합니다.`);
  }
  return number;
};

const validTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

export const normalizeTime = value => {
  const text = String(value ?? '').trim();
  return /^\d{4}$/.test(text) ? `${text.slice(0, 2)}:${text.slice(2)}` : text;
};

const validateDate = value => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('날짜는 YYYY-MM-DD 형식이어야 합니다.');
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('실제로 존재하는 날짜를 선택하세요.');
  }
};

export const buildWatchArgs = input => {
  const date = requiredText(input.date, '날짜');
  const from = requiredText(input.from, '출발역');
  const to = requiredText(input.to, '도착역');
  const time = normalizeTime(input.time || '00:00');
  const timeTo = normalizeTime(input.timeTo || '');
  const mode = String(input.mode || 'notify');
  const seatClass = String(input.seatClass || 'gen');

  validateDate(date);
  if (from === to) throw new Error('출발역과 도착역은 달라야 합니다.');
  if (!validTime(time) || (timeTo && !validTime(timeTo))) {
    throw new Error('시간은 00:00~23:59 사이여야 합니다.');
  }
  if (timeTo && timeTo < time) throw new Error('종료 시각은 시작 시각보다 빠를 수 없습니다.');
  if (!MODES.has(mode)) throw new Error('실행 방식을 다시 선택하세요.');
  if (!SEAT_CLASSES.has(seatClass)) throw new Error('좌석 종류를 다시 선택하세요.');

  const adults = parseCount(input.adults ?? 1, '어른');
  const children = parseCount(input.children ?? 0, '어린이');
  const infants = parseCount(input.infants ?? 0, '유아');
  const seniors = parseCount(input.seniors ?? 0, '경로');
  const total = adults + children + infants + seniors;
  if (total < 1 || total > 9) throw new Error('전체 승객 수는 1~9명이어야 합니다.');
  if (mode !== 'notify' && infants > adults) {
    throw new Error('좌석선택 예약에서는 유아 수 이상의 어른이 필요합니다.');
  }
  if (mode !== 'notify' && seatClass === 'standing') {
    throw new Error('입석·자유석은 좌석선택 예약을 지원하지 않습니다.');
  }

  const interval = Number(input.interval ?? 60);
  if (!Number.isInteger(interval) || interval < 15 || interval > 86400) {
    throw new Error('조회 주기는 15~86400초 사이의 정수여야 합니다.');
  }

  const trains = String(input.trains || '').replace(/\s+/g, '');
  if (trains && !/^\d+(,\d+)*$/.test(trains)) {
    throw new Error('열차번호는 587 또는 587,589처럼 입력하세요.');
  }

  const args = [
    '--date', date,
    '--time', time,
    '--from', from,
    '--to', to,
    '--adults', String(adults),
    '--children', String(children),
    '--infants', String(infants),
    '--seniors', String(seniors),
    '--seat-class', seatClass,
    '--interval', String(interval),
  ];
  if (timeTo) args.push('--time-to', timeTo);
  if (trains) args.push('--trains', trains);
  if (mode === 'dry-run') args.push('--dry-run-reserve');
  if (mode === 'reserve') args.push('--reserve');
  if (input.once === true) args.push('--once');
  if (input.telegram === false) args.push('--no-telegram');
  return args;
};

const quoteArg = value => /^[\p{L}\p{N}._,:/-]+$/u.test(value)
  ? value
  : `"${value.replaceAll('"', '\\"')}"`;

export const formatWatchCommand = args => `node watch.js ${args.map(quoteArg).join(' ')}`;
