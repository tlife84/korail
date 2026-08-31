/**
 * 감시 실행에 필요한 설정을 한 곳에서 만들고 검증한다.
 *
 * CLI 인자 파싱만 분리한 게 아니라 "인자 이름 → 정규화된 설정" 변환 전체를 담는다.
 * Electron 설정 화면도 같은 모양의 객체를 넘겨 같은 검증을 통과하게 하려는 것이다.
 * 검증 실패는 예외나 process.exit이 아니라 error 문자열로 돌려준다 — 호출한 쪽이
 * 터미널에 찍을지 화면에 띄울지 정하도록.
 */
import { credentialWarnings } from './env-config.js';

/** `--key value` / `--flag` 형태의 인자를 평범한 객체로 */
export const parseArgs = (argv = []) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
    out[key] = value;
  }
  return out;
};

export const HELP = `
코레일 공석 감시 → 텔레그램 알림

필수:
  --date <YYYY-MM-DD>     승차일 (예: 2026-07-17)
  --from <역이름>          출발역 (예: 광명)
  --to   <역이름>          도착역 (예: 서대전)

선택:
  --time <HH:MM>          이 시각 이후 열차만 (기본 00:00)
  --time-to <HH:MM>       이 시각 이전(출발 기준) 열차만 (기본 제한 없음)
  --adults <n>            어른 수 (기본 1)
  --children <n>          어린이 수 (기본 0)
  --infants <n>           유아 수 (기본 0)
  --seniors <n>           경로 수 (기본 0)
  --seat-class <종류>      감시할 좌석: gen(일반실) | any(일반실+특실) | spe(특실) | standing(입석·자유석)  (기본 gen)
  --trains <번호,번호>      특정 열차번호만 감시 (기본: 시간 이후 전체)
  --interval <초>          조회 주기 초 (기본 60, 최소 30 권장)
  --once                  1회만 조회하고 종료 (테스트용)
  --reserve               공석 발견 시 좌석을 골라 예약 (성공 후 종료)
  --dry-run-reserve       좌석만 골라 출력하고 실제 예약은 하지 않음
  --login                 전용 Chrome에서 수동 로그인만 진행 후 종료
  --login-timeout <초>     수동 로그인 대기시간 (기본 300)
  --port <n>              Chrome 원격 디버깅 포트 (기본 9222)
  --no-telegram           텔레그램 전송 안 함 (콘솔만)
  --help                  이 도움말

계정·알림 값은 인자가 아니라 .env 파일이나 환경변수로 받는다 (설정 화면이 넘겨준다):
  KORAIL_ID / KORAIL_PW          자동 로그인·예약용 계정 (없으면 --login 수동 로그인)
  TELEGRAM_BOT_TOKEN             봇 토큰 (없으면 콘솔에만 출력)
  TELEGRAM_CHAT_IDS              받을 대화 ID, 쉼표로 여러 명
`;

export const SEAT_CLASSES = ['gen', 'any', 'spe', 'standing'];

const isValidTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

const isRealDate = value => {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
};

/** 첫 번째로 걸리는 문제 하나만 돌려준다 (기존 CLI가 하나씩 알려주던 방식 그대로). */
const firstProblem = (config) => {
  const counts = [config.adults, config.children, config.infants, config.seniors];
  if (counts.some(count => !Number.isInteger(count) || count < 0)) {
    return '승객 수는 0 이상의 정수여야 합니다.';
  }
  if (!Number.isInteger(config.totalPassengers) || config.totalPassengers < 1 || config.totalPassengers > 9) {
    return '승객 수 합계는 1~9명이어야 합니다.';
  }
  if (!isRealDate(config.dateLabel)) {
    return '날짜는 실제 존재하는 YYYY-MM-DD 형식이어야 합니다.';
  }
  if (!isValidTime(config.timeLabel) || (config.timeToLabel && !isValidTime(config.timeToLabel))) {
    return '시간은 HH:MM 형식(00:00~23:59)이어야 합니다.';
  }
  if (config.from === config.to) {
    return '출발역과 도착역은 달라야 합니다.';
  }
  if (!SEAT_CLASSES.includes(config.seatClass)) {
    return '--seat-class는 gen, any, spe, standing 중 하나여야 합니다.';
  }
  if (config.reserve && config.dryRunReserve) {
    return '--reserve와 --dry-run-reserve는 함께 사용할 수 없습니다.';
  }
  if (config.infants > config.adults && (config.reserve || config.dryRunReserve)) {
    return '좌석선택 예약에서는 유아를 성인과 붙이기 위해 성인 수가 유아 수 이상이어야 합니다.';
  }
  if ((config.reserve || config.dryRunReserve) && config.seatClass === 'standing') {
    return '입석·자유석은 좌석을 직접 선택할 수 없어 자동 예약을 지원하지 않습니다.';
  }
  return null;
};

/**
 * 인자 객체 + 계정 정보 → 감시 엔진이 그대로 쓰는 설정.
 * 성공하면 { config }, 실패하면 { error }.
 */
export const buildWatchConfig = (args = {}, creds = {}) => {
  const loginOnly = !!args.login;
  const missing = loginOnly ? [] : ['date', 'from', 'to'].filter(key => !args[key]);
  if (missing.length) {
    return { error: `누락된 필수 인자: ${missing.map(key => '--' + key).join(', ')}\n${HELP}` };
  }

  const config = {
    date: args.date?.replace(/-/g, '') || '',              // YYYYMMDD
    dateLabel: args.date || '',                            // 사용자가 입력한 표기 그대로
    from: args.from || '',
    to: args.to || '',
    hour: (args.time || '00:00').replace(':', '') + '00',  // HHMMSS
    timeLabel: args.time || '00:00',
    // 출발시각 범위 (HHMM 정수). 상한 미지정 시 제한 없음.
    depFrom: parseInt((args.time || '00:00').replace(':', '')),
    depTo: args['time-to'] ? parseInt(args['time-to'].replace(':', '')) : null,
    timeToLabel: args['time-to'] || null,
    adults: parseInt(args.adults ?? '1'),
    children: parseInt(args.children ?? '0'),
    infants: parseInt(args.infants ?? '0'),
    seniors: parseInt(args.seniors ?? '0'),
    seatClass: (args['seat-class'] || 'gen').toLowerCase(),
    trains: args.trains ? args.trains.split(',').map(value => value.trim()) : null,
    interval: Math.max(15, parseInt(args.interval ?? '60')) * 1000,
    once: !!args.once,
    reserve: !!args.reserve,
    dryRunReserve: !!args['dry-run-reserve'],
    loginOnly,
    loginTimeout: Math.max(30, parseInt(args['login-timeout'] ?? '300')) * 1000,
    port: parseInt(args.port ?? '9222'),
    telegram: !args['no-telegram'],
    warnings: [],
  };
  config.totalPassengers = config.adults + config.children + config.infants + config.seniors;

  if (loginOnly) return { config };

  const problem = firstProblem(config);
  if (problem) return { error: problem };

  // 텔레그램 정보가 없어도 실행은 막지 않는다. 콘솔 출력만 남기고 계속한다.
  if (config.telegram && !creds.hasTelegram) config.telegram = false;
  config.warnings = credentialWarnings(creds, { reserve: config.reserve });
  if (config.reserve && !config.telegram) {
    config.warnings.push('예약이 성공해도 텔레그램 알림을 보낼 수 없으니 터미널을 지켜보세요.');
  }
  return { config };
};
