/**
 * 진짜 Chrome을 원격 디버깅으로 띄우고 CDP로 붙는다.
 *
 * korail.com의 dynaPath는 자동화 플래그가 붙은 브라우저(헤드리스·Playwright가
 * 직접 띄운 크로미움·Electron 내장 창)를 모두 막는다. 실측으로 통과가 확인된
 * 유일한 경로가 "사용자 프로필로 평범하게 뜬 Chrome + CDP 접속"이라 이 방식을 쓴다.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const moduleDir = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PROFILE_DIR = resolve(moduleDir, '.chrome-profile');

export const CHROME_CANDIDATES = process.platform === 'darwin'
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

export const findChrome = () => CHROME_CANDIDATES.find(path => path && existsSync(path));

export const cdpAlive = async (port) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
};

/** 이미 그 포트에 크롬이 떠 있으면 재사용하고, 없으면 새로 띄운다. */
export const ensureChrome = async ({ port, profileDir = DEFAULT_PROFILE_DIR, log = () => {} }) => {
  if (await cdpAlive(port)) {
    log(`[Chrome] 포트 ${port}에 이미 실행 중 → 재사용`);
    return null;
  }
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome 실행파일을 찾지 못했습니다. --port로 이미 실행 중인 크롬에 붙이세요.');
  mkdirSync(profileDir, { recursive: true });
  log(`[Chrome] 실행: ${chrome}`);
  const proc = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    // CDP 준비 직후 예열이 메인으로 이동한다. 여기서도 같은 주소를
    // 열면 두 navigation이 충돌해 간헐적으로 시작이 실패한다.
    'about:blank',
  ], { detached: false, stdio: 'ignore' });
  proc.on('exit', (code) => { log(`[Chrome] 종료 (code ${code})`); });

  const deadline = Date.now() + 30000;
  while (!(await cdpAlive(port))) {
    if (Date.now() > deadline) throw new Error('Chrome CDP 준비 실패(30s)');
    await new Promise(done => setTimeout(done, 300));
  }
  log('[Chrome] CDP 준비 완료');
  return proc;
};

/**
 * 감시 엔진이 쓰는 세션 하나: 코레일을 띄울 page와 뒷정리 함수.
 * playwright는 여기서만 불러온다 — 엔진 테스트가 가짜 page를 쓰기 때문에
 * 이 모듈을 건드리지 않으면 무거운 의존성도 따라오지 않는다.
 */
export const openChromeSession = async ({ port, profileDir, log = () => {} }) => {
  const { chromium } = await import('playwright-core');
  const proc = await ensureChrome({ port, profileDir, log });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find(item => item.url().includes('korail'))
    || context.pages()[0]
    || await context.newPage();

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await browser.close(); } catch {}
    if (proc) { try { proc.kill(); } catch {} }
  };
  return { page, close };
};
