#!/usr/bin/env node
/**
 * korail-watch — 코레일 공석 감시 → 텔레그램 알림
 *
 * 코레일(korail.com)은 dynaPath 안티매크로로 보호되어, 순수 HTTP 요청은 차단된다.
 * 그래서 (1) 자동화 플래그 없는 진짜 Chrome을 원격 디버깅으로 띄우고
 * (2) 조회를 한 번 실행해 dynaPath 신뢰 상태를 "예열"한 뒤
 * (3) 그 브라우저 컨텍스트 안에서 주기적으로 조회 API를 호출한다.
 *
 * 사용 예:
 *   node watch.js --date 2026-07-17 --time 12:00 --from 광명 --to 서대전 \
 *                 --adults 1 --infants 1 --interval 60
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chooseBestSeatOption } from './seat-selection.js';
import { buildReservationBody } from './reservation-params.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- .env ----------
const loadEnv = () => {
  const p = resolve(__dirname, '.env');
  const env = {};
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
};
const ENV = loadEnv();

// ---------- args ----------
const parseArgs = () => {
  const a = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      const v = (i + 1 < a.length && !a[i + 1].startsWith('--')) ? a[++i] : 'true';
      o[k] = v;
    }
  }
  return o;
};
const args = parseArgs();

const HELP = `
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
`;
if (args.help) { console.log(HELP); process.exit(0); }

const loginOnly = !!args.login;
const need = loginOnly ? [] : ['date', 'from', 'to'].filter(k => !args[k]);
if (need.length) { console.error(`누락된 필수 인자: ${need.map(k => '--' + k).join(', ')}\n${HELP}`); process.exit(1); }

const CFG = {
  date: args.date?.replace(/-/g, '') || '',            // YYYYMMDD
  from: args.from || '',
  to: args.to || '',
  hour: (args.time || '00:00').replace(':', '') + '00', // HHMMSS
  timeLabel: args.time || '00:00',
  // 출발시각 상한 (HHMM 정수). 미지정 시 제한 없음.
  depFrom: parseInt((args.time || '00:00').replace(':', '')),
  depTo: args['time-to'] ? parseInt(args['time-to'].replace(':', '')) : null,
  timeToLabel: args['time-to'] || null,
  adults: parseInt(args.adults ?? '1'),
  children: parseInt(args.children ?? '0'),
  infants: parseInt(args.infants ?? '0'),
  seniors: parseInt(args.seniors ?? '0'),
  seatClass: (args['seat-class'] || 'gen').toLowerCase(),
  trains: args.trains ? args.trains.split(',').map(s => s.trim()) : null,
  interval: Math.max(15, parseInt(args.interval ?? '60')) * 1000,
  once: !!args.once,
  reserve: !!args.reserve,
  dryRunReserve: !!args['dry-run-reserve'],
  loginOnly,
  loginTimeout: Math.max(30, parseInt(args['login-timeout'] ?? '300')) * 1000,
  port: parseInt(args.port ?? '9222'),
  telegram: !args['no-telegram'],
};
CFG.totalPassengers = CFG.adults + CFG.children + CFG.infants + CFG.seniors;

if (!CFG.loginOnly) {
  const passengerCounts = [CFG.adults, CFG.children, CFG.infants, CFG.seniors];
  if (passengerCounts.some(count => !Number.isInteger(count) || count < 0)) {
    console.error('승객 수는 0 이상의 정수여야 합니다.');
    process.exit(1);
  }
  if (!Number.isInteger(CFG.totalPassengers) || CFG.totalPassengers < 1 || CFG.totalPassengers > 9) {
    console.error('승객 수 합계는 1~9명이어야 합니다.');
    process.exit(1);
  }
  const dateMatch = args.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const validDate = dateMatch && (() => {
    const [, year, month, day] = dateMatch.map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  })();
  if (!validDate) {
    console.error('날짜는 실제 존재하는 YYYY-MM-DD 형식이어야 합니다.');
    process.exit(1);
  }
  const validTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!validTime(CFG.timeLabel) || (CFG.timeToLabel && !validTime(CFG.timeToLabel))) {
    console.error('시간은 HH:MM 형식(00:00~23:59)이어야 합니다.');
    process.exit(1);
  }
  if (CFG.from === CFG.to) {
    console.error('출발역과 도착역은 달라야 합니다.');
    process.exit(1);
  }
  if (!['gen', 'any', 'spe', 'standing'].includes(CFG.seatClass)) {
    console.error('--seat-class는 gen, any, spe, standing 중 하나여야 합니다.');
    process.exit(1);
  }
  if (CFG.reserve && CFG.dryRunReserve) {
    console.error('--reserve와 --dry-run-reserve는 함께 사용할 수 없습니다.');
    process.exit(1);
  }
  if (CFG.infants > CFG.adults && (CFG.reserve || CFG.dryRunReserve)) {
    console.error('좌석선택 예약에서는 유아를 성인과 붙이기 위해 성인 수가 유아 수 이상이어야 합니다.');
    process.exit(1);
  }
  if ((CFG.reserve || CFG.dryRunReserve) && CFG.seatClass === 'standing') {
    console.error('입석·자유석은 좌석을 직접 선택할 수 없어 자동 예약을 지원하지 않습니다.');
    process.exit(1);
  }
  if (CFG.reserve && CFG.telegram) {
    const telegramIds = ENV.TELEGRAM_CHAT_IDS || ENV.TELEGRAM_ADMIN_CHAT_ID;
    if (!ENV.TELEGRAM_BOT_TOKEN || !telegramIds) {
      console.error('자동 예약은 완료 알림을 위해 텔레그램 설정이 필요합니다. 테스트 시에만 --no-telegram을 명시하세요.');
      process.exit(1);
    }
  }
}

// ---------- telegram ----------
const tgSend = async (text) => {
  if (!CFG.telegram) { return; }
  const token = ENV.TELEGRAM_BOT_TOKEN;
  const ids = (ENV.TELEGRAM_CHAT_IDS || ENV.TELEGRAM_ADMIN_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token || !ids.length) { console.warn('[텔레그램] 토큰/chat_id 없음 (.env 확인)'); return; }
  for (const id of ids) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      const j = await r.json();
      if (!j.ok) console.warn(`[텔레그램] 전송 실패 chat=${id}:`, j.description);
    } catch (e) { console.warn('[텔레그램] 오류:', e.message); }
  }
};

// ---------- chrome ----------
const CHROME_CANDIDATES = process.platform === 'darwin'
  ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      (process.env.HOME || '') + '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ]
  : process.platform === 'linux'
  ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  : [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    ];
const findChrome = () => CHROME_CANDIDATES.find(p => p && existsSync(p));

const cdpAlive = async (port) => {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return r.ok; } catch { return false; }
};

let chromeProc = null;
const ensureChrome = async () => {
  if (await cdpAlive(CFG.port)) { console.log(`[Chrome] 포트 ${CFG.port}에 이미 실행 중 → 재사용`); return; }
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome 실행파일을 찾지 못했습니다. --port로 이미 실행 중인 크롬에 붙이세요.');
  const profile = resolve(__dirname, '.chrome-profile');
  mkdirSync(profile, { recursive: true });
  console.log(`[Chrome] 실행: ${chrome}`);
  chromeProc = spawn(chrome, [
    `--remote-debugging-port=${CFG.port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    // CDP 준비 직후 primeOnce()가 메인으로 이동한다. 여기서도 같은 주소를
    // 열면 두 navigation이 충돌해 간헐적으로 시작이 실패한다.
    'about:blank',
  ], { detached: false, stdio: 'ignore' });
  chromeProc.on('exit', (code) => { console.log(`[Chrome] 종료 (code ${code})`); });
  // wait for CDP
  const deadline = Date.now() + 30000;
  while (!(await cdpAlive(CFG.port))) {
    if (Date.now() > deadline) throw new Error('Chrome CDP 준비 실패(30s)');
    await new Promise(r => setTimeout(r, 300));
  }
  console.log('[Chrome] CDP 준비 완료');
};

// ---------- korail ----------
const buildParams = () => new URLSearchParams({
  Device: 'IP', Version: '190617001', radJobId: '1', txtMenuId: '11', selGoTrain: '05',
  txtGoAbrdDt: CFG.date, txtGoStart: CFG.from, txtGoEnd: CFG.to, txtGoHour: CFG.hour,
  txtPsgFlg_1: String(CFG.adults), txtPsgFlg_2: String(CFG.children),
  txtPsgFlg_3: String(CFG.seniors), txtPsgFlg_4: String(CFG.infants), txtPsgFlg_5: '0',
  txtSeatAttCd_2: '000', txtSeatAttCd_3: '000', txtSeatAttCd_4: '015',
  txtTrnGpCd: '109', adjStnScdlOfrFlg: 'N', rtYn: 'N', txtCardPsgCnt: '0',
}).toString();

// 브라우저 컨텍스트 안에서 코레일 API 호출
const fetchKorailApi = (page, path, body) => page.evaluate(async ({ path, body }) => {
  const resp = await fetch(`https://www.korail.com${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const text = await resp.text();
  try { return { ok: resp.ok, json: JSON.parse(text) }; }
  catch { return { ok: false, text: text.slice(0, 200) }; }
}, { path, body });

const fetchKorailGet = (page, path) => page.evaluate(async (path) => {
  const resp = await fetch(`https://www.korail.com${path}`);
  const text = await resp.text();
  try { return { ok: resp.ok, json: JSON.parse(text) }; }
  catch { return { ok: false, text: text.slice(0, 200) }; }
}, path);

const loginStatus = async (page) => {
  try {
    const res = await fetchKorailGet(page, '/ebizweb/common/loginCheck');
    const loggedIn = !!res.ok && res.json?.strResult === 'SUCC' && !res.json?.h_msg_cd;
    return { loggedIn, data: res.json || null };
  } catch {
    return { loggedIn: false, data: null };
  }
};

const loginWithCredentials = async (page) => {
  const memberId = ENV.KORAIL_ID || ENV.KORAIL_MEMBER_ID;
  const password = ENV.KORAIL_PW || ENV.KORAIL_PASSWORD;
  if (!memberId || !password) return false;

  console.log('[로그인] .env 자격정보로 로그인 중...');
  await page.goto('https://www.korail.com/ticket/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  const keySecurity = page.locator('#useKeySec');
  if (await keySecurity.isChecked().catch(() => false)) await keySecurity.uncheck();
  await page.locator('#id').fill(memberId);
  await page.locator('#password').fill(password);
  const response = page.waitForResponse(r => /\/ebizweb\/common\/loginProcess/i.test(r.url()), {
    timeout: 20000,
  }).catch(() => null);
  await page.getByRole('button', { name: '로그인', exact: true }).first().click();
  const loginResponse = await response;
  const loginData = await loginResponse?.json().catch(() => null);
  await page.waitForTimeout(2000);

  const status = await loginStatus(page);
  if (status.loggedIn) {
    console.log('[로그인] 완료 ✔');
    return true;
  }
  const message = loginData?.h_msg_txt || status.data?.h_msg_txt || '로그인에 실패했습니다.';
  throw new Error(`[로그인] 실패: ${message} (잘못된 정보로 반복 시도하지 않습니다.)`);
};

const ensureLoggedIn = async (page) => {
  const current = await loginStatus(page);
  if (current.loggedIn) {
    console.log('[로그인] 기존 로그인 세션 재사용 ✔');
    return true;
  }
  if (await loginWithCredentials(page)) return true;
  throw new Error('로그인이 필요합니다. .env에 KORAIL_ID/KORAIL_PW를 설정하세요.');
};

const waitForManualLogin = async (page) => {
  const current = await loginStatus(page);
  if (current.loggedIn) {
    console.log('[로그인] 이미 로그인되어 있습니다 ✔');
    return;
  }
  await page.goto('https://www.korail.com/ticket/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[로그인] Chrome 창에서 로그인해주세요. 최대 ${CFG.loginTimeout / 1000}초 기다립니다.`);
  const deadline = Date.now() + CFG.loginTimeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if ((await loginStatus(page)).loggedIn) {
      console.log('[로그인] 완료 — 전용 프로필에 세션이 저장되었습니다 ✔');
      return;
    }
  }
  throw new Error('수동 로그인 대기시간이 초과되었습니다.');
};

const fetchSchedule = (page, body) => fetchKorailApi(
  page,
  '/classes/com.korail.mobile.seatMovie.ScheduleView',
  body,
);

const apiFailed = (res) => !res.ok
  || !!res.json?.errCode
  || res.json?.strResult === 'FAIL'
  || /^(ERR|WRG)/.test(res.json?.h_msg_cd || '');

const apiErrorMessage = (res) => res.json?.errMsg
  || res.json?.h_msg_txt
  || res.text
  || 'unknown';

// 코레일 웹의 "좌석선택" 버튼과 같은 요청. 지정 승객 수가 함께 앉을 수 있는
// 좌석 조합이 하나라도 있어야 응답에 srcar_infos(선택 가능한 호차)가 생긴다.
const buildSeatMapParams = (t, psrmClCd) => new URLSearchParams({
  Device: 'IP',
  Version: '190617001',
  txtMenuId: '11',
  txtRunDt: t.h_run_dt || CFG.date,
  txtDptDt: t.h_dpt_dt || t.h_run_dt || CFG.date,
  txtTrnNo: t.h_trn_no || '',
  txtDptTm: t.h_dpt_tm || '',
  txtTrnClsfCd: t.h_trn_clsf_cd || '',
  txtTrnGpCd: t.h_trn_gp_cd || '',
  txtDptRsStnCd: t.h_dpt_rs_stn_cd || '',
  txtArvRsStnCd: t.h_arv_rs_stn_cd || '',
  txtPsrmClCd: psrmClCd, // 1=일반실, 2=특실
  txtSeatAttCd: t.h_seat_att_cd || '015',
  txtCustSrtCd: '',
  txtDptStnRunOrdr: t.h_dpt_stn_run_ordr || '',
  txtArvStnRunOrdr: t.h_arv_stn_run_ordr || '',
  txtTotPsgCnt: String(CFG.totalPassengers),
  langCode: 'ko',
  txtGdNo: t.txtGdNo || '',
}).toString();

const fetchSeatMap = (page, t, psrmClCd) => fetchKorailApi(
  page,
  '/classes/com.korail.mobile.research.TrainResearch',
  buildSeatMapParams(t, psrmClCd),
);

const buildSeatListParams = (t, psrmClCd, carNo) => new URLSearchParams({
  Device: 'IP',
  Version: '190617001',
  runDt: t.h_run_dt || CFG.date,
  trnNo: t.h_trn_no || '',
  trnClsfCd: t.h_trn_clsf_cd || '',
  trnGpCd: t.h_trn_gp_cd || '',
  dptRsStnCd: t.h_dpt_rs_stn_cd || '',
  arvRsStnCd: t.h_arv_rs_stn_cd || '',
  psrmClCd,
  seatAttCd: t.h_seat_att_cd || '015',
  dptStnRunOrdr: t.h_dpt_stn_run_ordr || '',
  arvStnRunOrdr: t.h_arv_stn_run_ordr || '',
  totPsgCnt: String(CFG.totalPassengers),
  srcarNo: String(carNo),
  langCode: 'ko',
  gdNo: t.txtGdNo || '',
}).toString();

const fetchSeatList = (page, t, psrmClCd, carNo) => fetchKorailApi(
  page,
  '/classes/com.korail.mobile.research.TResidualSeatsResearch.do',
  buildSeatListParams(t, psrmClCd, carNo),
);

const loadBestSeatOption = async (page, t, seat, cars) => {
  const numericCars = cars
    .map(car => ({ ...car, carNo: Number(car.h_srcar_no) }))
    .filter(car => Number.isFinite(car.carNo));
  if (!numericCars.length) return null;
  const midpoint = (Math.min(...numericCars.map(car => car.carNo))
    + Math.max(...numericCars.map(car => car.carNo))) / 2;
  numericCars.sort((a, b) => Math.abs(a.carNo - midpoint) - Math.abs(b.carNo - midpoint));

  const carSeatMaps = [];
  for (const car of numericCars) {
    let res = await fetchSeatList(page, t, seat.psrmClCd, car.carNo);
    if (apiFailed(res)) {
      console.warn(`[좌석선택] ${t.h_trn_no} ${car.carNo}호차 상세 조회 실패 → 재예열`);
      if (await primeUntilReady(page, 2)) res = await fetchSeatList(page, t, seat.psrmClCd, car.carNo);
    }
    if (apiFailed(res)) continue;
    carSeatMaps.push({
      carNo: car.carNo,
      seats: (res.json.seatList || []).map(item => ({ ...item, srcarNo: car.carNo })),
    });
  }

  return chooseBestSeatOption(carSeatMaps, {
    adults: CFG.adults,
    children: CFG.children,
    infants: CFG.infants,
    seniors: CFG.seniors,
  });
};

const buildReservationParams = (t, seat, option) => {
  const seats = option.seats.map(selected => ({
    ...selected,
    srcarNo: selected.srcarNo || option.carNo,
  }));
  return buildReservationBody({
    train: t,
    seatClassCode: seat.psrmClCd,
    seats,
    passengers: {
      adults: CFG.adults,
      children: CFG.children,
      infants: CFG.infants,
      seniors: CFG.seniors,
    },
    date: CFG.date,
  });
};

const reservationFailed = (res) => apiFailed(res)
  || !['SUCC', 'SUCC_NULL'].includes(res.json?.strResult)
  || res.json?.h_msg_cd === 'P058';

const reserveSelectedSeats = async (page, t, seat, option) => {
  const body = buildReservationParams(t, seat, option);
  let res = await fetchKorailApi(
    page,
    '/classes/com.korail.mobile.certification.TicketReservation',
    body,
  );
  if (res.json?.h_msg_cd === 'P058') {
    console.warn('[예약] 로그인 세션이 만료되어 다시 로그인합니다.');
    await ensureLoggedIn(page);
    res = await fetchKorailApi(
      page,
      '/classes/com.korail.mobile.certification.TicketReservation',
      body,
    );
  }
  if (reservationFailed(res)) {
    throw new Error(apiErrorMessage(res));
  }
  return res.json;
};

// raw fetch가 통과 상태인지 확인 (IRG000000이면 예열 완료)
const verify = async (page) => {
  const res = await fetchSchedule(page, buildParams());
  return !apiFailed(res) && res.json.h_msg_cd === 'IRG000000';
};

// dynaPath 예열 1회: 메인에서 조회 버튼 클릭 → SPA가 실제 조회를 수행하게 함
const primeOnce = async (page) => {
  await page.goto('https://www.korail.com/ticket/main', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  // SPA의 ScheduleView 응답을 기다려 예열 완료 신호로 사용
  const wait = page.waitForResponse(r => /ScheduleView/i.test(r.url()), { timeout: 12000 }).catch(() => null);
  try { await page.getByText('열차 조회하기', { exact: false }).first().click({ timeout: 8000 }); }
  catch { /* 버튼 못 찾으면 그냥 대기 */ }
  await wait;
  await page.waitForTimeout(1500);
};

// 예열이 실제로 통과할 때까지 반복 (콜드 스타트 시 보통 1~2회 필요)
const primeUntilReady = async (page, attempts = 5) => {
  for (let i = 1; i <= attempts; i++) {
    console.log(`[예열] dynaPath 신뢰 상태 확보 중... (${i}/${attempts})`);
    await primeOnce(page);
    if (await verify(page)) { console.log('[예열] 완료 ✔'); return true; }
  }
  console.warn('[예열] 실패 — 계속 차단 상태입니다.');
  return false;
};

const CLASS_FIELD = {
  gen: ['h_gen_rsv_nm', '일반실', '1'],
  spe: ['h_spe_rsv_nm', '특실', '2'],
  standing: ['h_stnd_rsv_nm', '입석·자유석', null],
};

const isSoldOut = (v) => !v || v === '매진' || v === '';

// 열차 하나에서 감시 대상 좌석이 예약 가능한지 판정
const availableSeats = (t) => {
  const out = [];
  if (CFG.seatClass === 'any') {
    if (t.h_rsv_psb_flg === 'Y') {
      if (!isSoldOut(t.h_gen_rsv_nm)) out.push({ label: '일반실', state: t.h_gen_rsv_nm, psrmClCd: '1' });
      if (!isSoldOut(t.h_spe_rsv_nm)) out.push({ label: '특실', state: t.h_spe_rsv_nm, psrmClCd: '2' });
      // 등급이 명시되지 않는 예약 가능 상태(입석 등)는 기본 any에서 공석으로 보지 않는다.
      // 입석·자유석만 감시하려면 --seat-class standing을 명시해야 한다.
    }
  } else {
    const [field, label, psrmClCd] = CLASS_FIELD[CFG.seatClass] || CLASS_FIELD.gen;
    if (!isSoldOut(t[field])) out.push({ label, state: t[field], psrmClCd });
  }
  return out;
};

// selectable: true=웹에서 좌석선택 가능, false=선택 가능한 호차 없음,
// null=통신/차단 오류라 판정 보류(기존 알림 상태도 유지)
const hasSelectableSeats = async (page, t, seat) => {
  if (!seat.psrmClCd) return { selectable: true, carCount: null, cars: [] };

  let res = await fetchSeatMap(page, t, seat.psrmClCd);
  if (apiFailed(res)) {
    console.warn(`[좌석검증] ${t.h_trn_no} ${seat.label} 조회 오류 → 재예열`);
    if (await primeUntilReady(page, 3)) res = await fetchSeatMap(page, t, seat.psrmClCd);
  }
  if (apiFailed(res)) {
    const detail = apiErrorMessage(res).slice(0, 80);
    console.warn(`[좌석검증] ${t.h_trn_no} ${seat.label} 판정 보류: ${detail}`);
    return { selectable: null, carCount: null, cars: [] };
  }

  const cars = res.json.srcar_infos?.srcar_info;
  return {
    selectable: Array.isArray(cars) && cars.length > 0,
    carCount: Array.isArray(cars) ? cars.length : 0,
    cars: Array.isArray(cars) ? cars : [],
  };
};

const alerted = new Set(); // "trnNo|label" 중복 알림 방지 (매진되면 해제)

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const rawTimeLabel = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return String(value || '');
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
};

const reservationPaymentLabel = (data) => data.h_pay_limit_msg
  || (data.h_stl_lmt_tm ? rawTimeLabel(String(data.h_stl_lmt_tm).slice(-6)) : '')
  || '코레일 예약내역에서 확인';

const notifyReservationComplete = async (t, seat, option, data) => {
  const name = `${t.h_trn_clsf_nm || 'KTX'} ${t.h_trn_no}`;
  const seatLabels = option.seats.map(item => `${option.carNo}호차 ${item.seat_spec}`).join(', ');
  const payment = reservationPaymentLabel(data);
  const pnr = data.h_pnr_no || data.str_pnr_no || '';
  const msg = [
    '<b>✅ 코레일 예약 완료</b>',
    `${escapeHtml(CFG.from)} → ${escapeHtml(CFG.to)}  ${escapeHtml(args.date)}`,
    '',
    `🚄 <b>${escapeHtml(name)}</b>  ${escapeHtml(t.h_dpt_tm_qb || rawTimeLabel(t.h_dpt_tm))}→${escapeHtml(t.h_arv_tm_qb || rawTimeLabel(t.h_arv_tm))}`,
    `좌석: ${escapeHtml(seat.label)} / ${escapeHtml(seatLabels)}`,
    pnr ? `예약번호: ${escapeHtml(pnr)}` : '',
    `결제기한: ${escapeHtml(payment)}`,
    '',
    '👉 기한 내 코레일 앱/웹에서 결제하세요.',
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
  console.log(`  → 예약 완료: ${name} ${seatLabels} | 결제기한 ${payment}${pnr ? ` | 예약번호 ${pnr}` : ''}`);
  await tgSend(msg);
};

const cycle = async (page) => {
  const body = buildParams();
  let res = await fetchSchedule(page, body);
  // 토큰 만료/차단 시 재예열 후 재시도
  if (apiFailed(res)) {
    console.warn('[감시] 신뢰 상태 만료 → 재예열');
    await primeUntilReady(page, 3);
    res = await fetchSchedule(page, body);
  }
  if (apiFailed(res)) {
    console.warn(`[감시] 조회 실패(다음 주기 재시도): ${apiErrorMessage(res).slice(0, 80)}`);
    return { reserved: false };
  }
  const allTrains = res.json.trn_infos?.trn_info || [];
  // 출발시각 범위 필터 (--time ~ --time-to)
  const trains = allTrains.filter(t => {
    const dep = parseInt((t.h_dpt_tm || '0').slice(0, 4)); // HHMM
    if (dep < CFG.depFrom) return false;
    if (CFG.depTo != null && dep > CFG.depTo) return false;
    return true;
  });
  const now = new Date().toLocaleTimeString('ko-KR');
  const hits = [];
  const statusLine = [];
  for (const t of trains) {
    const no = t.h_trn_no;
    if (CFG.trains && !CFG.trains.includes(no)) continue;
    const name = `${t.h_trn_clsf_nm || 'KTX'} ${no}`;
    const candidates = availableSeats(t);
    const seats = [];
    let verificationUnknown = false;
    for (const seat of candidates) {
      const verified = await hasSelectableSeats(page, t, seat);
      if (verified.selectable === true) {
        const selectable = { ...seat, carCount: verified.carCount, cars: verified.cars };
        seats.push(selectable);
        if (CFG.reserve || CFG.dryRunReserve) {
          const option = await loadBestSeatOption(page, t, selectable, verified.cars);
          if (!option) continue;
          const specs = option.seats.map(item => item.seat_spec).join(', ');
          console.log(`[좌석선택] ${name} ${selectable.label} → ${option.carNo}호차 ${specs} | 인접쌍 ${option.metrics.pairCount} | 순방향 ${option.metrics.forwardCount} | 4인동반석 ${option.metrics.fourFacingCount}`);
          if (CFG.dryRunReserve) return { reserved: false, dryRun: true, option };
          try {
            const reservation = await reserveSelectedSeats(page, t, selectable, option);
            await notifyReservationComplete(t, selectable, option, reservation);
            return { reserved: true, reservation, train: t, seat: selectable, option };
          } catch (error) {
            console.warn(`[예약] ${name} ${selectable.label} 실패: ${error.message}`);
            if (/로그인이 필요|KORAIL_(?:ID|PW|MEMBER)|\[로그인\] 실패/.test(error.message)) {
              await tgSend(`<b>⚠️ 코레일 자동 예약 중단</b>\n로그인 갱신 실패: ${escapeHtml(error.message)}\n\n다시 로그인한 뒤 감시를 재시작하세요.`);
              return { reserved: false, fatal: true, error };
            }
            // 응답 자체를 받지 못했다면 예약 성공 여부가 불명확하므로 중복 예약을
            // 피하기 위해 자동 재시도하지 않고 프로세스를 멈춘다.
            if (/page\.evaluate|fetch|network|통신/i.test(error.message)) {
              await tgSend(`<b>⚠️ 코레일 예약 결과 확인 필요</b>\n${escapeHtml(name)} 예약 요청 중 응답이 끊겼습니다.\n중복 예약 방지를 위해 감시를 중단했습니다. 코레일 예약내역을 직접 확인하세요.`);
              return { reserved: false, fatal: true, error };
            }
          }
        }
      }
      if (verified.selectable === null) verificationUnknown = true;
    }
    const marker = seats.length ? '🟢' : verificationUnknown ? '?' : candidates.length ? '🟡' : '·';
    statusLine.push(`${no}:${marker}`);
    for (const seat of seats) {
      const key = `${no}|${seat.label}`;
      if (!alerted.has(key)) {
        alerted.add(key);
        hits.push({ name, no, dep: t.h_dpt_tm_qb, arv: t.h_arv_tm_qb, label: seat.label,
          carCount: seat.carCount, seatSelectable: !!seat.psrmClCd,
          price: (t.h_rsv_psb_nm || '').split('\n')[0] });
      }
    }
    // 매진 또는 좌석조합 불가로 바뀌면 등급별 알림을 해제한다.
    // 검증 자체가 실패한 경우에는 상태를 보류해 중복 알림을 막는다.
    if (!verificationUnknown) {
      const selectableLabels = new Set(seats.map(seat => seat.label));
      for (const label of ['일반실', '특실', '입석·자유석', '예약가능']) {
        if (!selectableLabels.has(label)) alerted.delete(`${no}|${label}`);
      }
    }
  }
  const rangeLabel = CFG.timeToLabel ? `${CFG.timeLabel}~${CFG.timeToLabel}` : `${CFG.timeLabel}~`;
  console.log(`[${now}] ${CFG.from}→${CFG.to} ${CFG.date} ${rangeLabel} | 대상 ${trains.length}/${allTrains.length}개 | ${statusLine.join(' ')}`);

  if (hits.length) {
    const lines = hits.map(h => `🚄 <b>${h.name}</b>  ${h.dep}→${h.arv}\n   ${h.label} ${h.seatSelectable ? `좌석선택 가능${h.carCount ? ` (${h.carCount}개 호차)` : ''}` : '예약가능'} ${h.price ? '(' + h.price + ')' : ''}`);
    const msg = `<b>🟢 코레일 공석 발생!</b>\n${CFG.from} → ${CFG.to}  ${args.date} ${rangeLabel}\n\n${lines.join('\n')}\n\n👉 코레일 앱/웹에서 서둘러 예매하세요.`;
    const action = CFG.telegram ? '텔레그램 전송' : '콘솔 알림(--no-telegram)';
    console.log(`  → 공석! ${action}:`, hits.map(h => `${h.name}(${h.label})`).join(', '));
    await tgSend(msg);
  }
  return { reserved: false };
};

// ---------- main ----------
let activeBrowser = null;
let shuttingDown = false;

const closeResources = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await activeBrowser?.close(); } catch {}
  if (chromeProc) { try { chromeProc.kill(); } catch {} }
};

const main = async () => {
  if (CFG.loginOnly) console.log('=== 코레일 로그인 세션 준비 ===');
  else {
    const rangeLabel = CFG.timeToLabel ? `${CFG.timeLabel}~${CFG.timeToLabel}` : `${CFG.timeLabel} 이후`;
    const mode = CFG.reserve ? '자동 예약' : CFG.dryRunReserve ? '예약 시뮬레이션' : '알림 감시';
    console.log(`=== 코레일 공석 감시 시작 (${mode}) ===`);
    console.log(`조건: ${CFG.from}→${CFG.to} ${args.date} ${rangeLabel} | 어른${CFG.adults} 어린이${CFG.children} 유아${CFG.infants} 경로${CFG.seniors} | 좌석:${CFG.seatClass} | 주기:${CFG.interval / 1000}s`);
    if (CFG.reserve) console.log('안전장치: 첫 예약 1건이 성공하면 즉시 감시를 종료합니다. 결제는 자동으로 진행하지 않습니다.');
  }
  await ensureChrome();
  activeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${CFG.port}`);
  const ctx = activeBrowser.contexts()[0];
  let page = ctx.pages().find(p => p.url().includes('korail')) || ctx.pages()[0] || await ctx.newPage();

  if (CFG.loginOnly) {
    await waitForManualLogin(page);
    await closeResources();
    return;
  }

  await primeUntilReady(page);
  if (CFG.reserve) {
    await ensureLoggedIn(page);
    // 자동 로그인 과정에서 로그인 화면으로 이동했을 수 있으므로 다시 예열한다.
    await primeUntilReady(page);
  }

  let timer = null;
  const shutdown = async (exitCode = 0) => {
    if (timer) clearTimeout(timer);
    console.log('\n종료 중...');
    await closeResources();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  const runCycle = async () => {
    let result;
    try {
      result = await cycle(page);
    } catch (error) {
      console.warn('[cycle 오류]', error.message);
      result = { reserved: false };
    }
    if (result?.reserved) return shutdown(0);
    if (result?.fatal) return shutdown(2);
    if (CFG.once) return shutdown(0);
    timer = setTimeout(runCycle, CFG.interval);
  };

  await runCycle();
};

main().catch(async (e) => {
  console.error('치명적 오류:', e.message || e);
  await closeResources();
  process.exit(1);
});
