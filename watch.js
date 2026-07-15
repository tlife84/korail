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
  --port <n>              Chrome 원격 디버깅 포트 (기본 9222)
  --no-telegram           텔레그램 전송 안 함 (콘솔만)
  --help                  이 도움말
`;
if (args.help) { console.log(HELP); process.exit(0); }

const need = ['date', 'from', 'to'].filter(k => !args[k]);
if (need.length) { console.error(`누락된 필수 인자: ${need.map(k => '--' + k).join(', ')}\n${HELP}`); process.exit(1); }

const CFG = {
  date: args.date.replace(/-/g, ''),            // YYYYMMDD
  from: args.from,
  to: args.to,
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
  port: parseInt(args.port ?? '9222'),
  telegram: !args['no-telegram'],
};
CFG.totalPassengers = CFG.adults + CFG.children + CFG.infants + CFG.seniors;

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
    'https://www.korail.com/ticket/main',
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
  if (!seat.psrmClCd) return { selectable: true, carCount: null };

  let res = await fetchSeatMap(page, t, seat.psrmClCd);
  if (apiFailed(res)) {
    console.warn(`[좌석검증] ${t.h_trn_no} ${seat.label} 조회 오류 → 재예열`);
    if (await primeUntilReady(page, 3)) res = await fetchSeatMap(page, t, seat.psrmClCd);
  }
  if (apiFailed(res)) {
    const detail = apiErrorMessage(res).slice(0, 80);
    console.warn(`[좌석검증] ${t.h_trn_no} ${seat.label} 판정 보류: ${detail}`);
    return { selectable: null, carCount: null };
  }

  const cars = res.json.srcar_infos?.srcar_info;
  return {
    selectable: Array.isArray(cars) && cars.length > 0,
    carCount: Array.isArray(cars) ? cars.length : 0,
  };
};

const alerted = new Set(); // "trnNo|label" 중복 알림 방지 (매진되면 해제)

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
    return;
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
      if (verified.selectable === true) seats.push({ ...seat, carCount: verified.carCount });
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
};

// ---------- main ----------
const main = async () => {
  const rangeLabel = CFG.timeToLabel ? `${CFG.timeLabel}~${CFG.timeToLabel}` : `${CFG.timeLabel} 이후`;
  console.log('=== 코레일 공석 감시 시작 ===');
  console.log(`조건: ${CFG.from}→${CFG.to} ${args.date} ${rangeLabel} | 어른${CFG.adults} 어린이${CFG.children} 유아${CFG.infants} 경로${CFG.seniors} | 좌석:${CFG.seatClass} | 주기:${CFG.interval / 1000}s`);
  await ensureChrome();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CFG.port}`);
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find(p => p.url().includes('korail')) || ctx.pages()[0] || await ctx.newPage();
  await primeUntilReady(page);

  if (CFG.once) {
    await cycle(page);
    try { await browser.close(); } catch {}
    if (chromeProc) { try { chromeProc.kill(); } catch {} }
    process.exit(0);
  }

  await cycle(page);
  const timer = setInterval(() => cycle(page).catch(e => console.warn('[cycle 오류]', e.message)), CFG.interval);

  const shutdown = async () => {
    clearInterval(timer);
    console.log('\n종료 중...');
    try { await browser.close(); } catch {}
    if (chromeProc) { try { chromeProc.kill(); } catch {} }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
