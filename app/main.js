/**
 * Electron 셸 — 설정 화면과 감시 엔진을 한 창에 담는다.
 *
 * 조회는 여전히 **외부의 진짜 Chrome + CDP**로 한다. Electron 내장 창(BrowserWindow)으로
 * 같은 예열·조회를 하면 korail.com의 dynaPath가 macro_err1로 막는 것을 실측으로 확인했다
 * (UA·sec-ch-ua를 위조해도 막힘). 그래서 여기서는 창과 트레이, 알림, 로그 중계만 맡고
 * 브라우저 일은 chrome.js에 그대로 맡긴다.
 */
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, shell } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile, resolveCredentials } from '../env-config.js';
import { buildRunRequest } from '../watch-request.js';
import { createWatcher } from '../watcher.js';

const APP_ID = 'kr.re.ktl.korail-watch';
const appDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(appDir, '..');

// 패키징하면 소스는 asar 안이라 쓰기도 못 하고 크롬 프로필도 둘 수 없다.
// 개발 중에는 CLI와 같은 자리를 써서 로그인 세션과 .env를 그대로 공유한다.
// PORTABLE_EXECUTABLE_DIR은 electron-builder portable 빌드가 넣어주는,
// 사용자가 exe를 둔 폴더다. 거기에 .env를 놓는 게 포터블 앱에서 자연스럽다.
const envCandidates = () => (app.isPackaged
  ? [process.env.PORTABLE_EXECUTABLE_DIR, app.getPath('userData')]
  : [projectDir]);
const envPath = () => {
  const found = envCandidates().find(dir => dir && existsSync(join(dir, '.env')));
  return join(found ?? envCandidates().at(-1) ?? projectDir, '.env');
};
const profileDir = () => (app.isPackaged
  ? join(app.getPath('userData'), 'chrome-profile')
  : join(projectDir, '.chrome-profile'));

let win = null;
let tray = null;
let watcher = null;
let quitting = false;
let lastStatus = '';

// ---------- 창 ----------
const showWindow = () => {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
};

const createWindow = () => {
  win = new BrowserWindow({
    width: 1060,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: '#f5f7fb',
    icon: join(appDir, 'icon.png'),
    title: '코레일 좌석 감시',
    webPreferences: {
      preload: join(appDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.loadFile(join(projectDir, 'launcher.html'));

  // 화면 안에서 열리는 바깥 링크는 기본 브라우저로 보낸다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 감시 중에 창을 닫으면 종료가 아니라 트레이로 내린다.
  win.on('close', (event) => {
    if (quitting || !watcher) return;
    event.preventDefault();
    win.hide();
    notify('감시는 계속 돌고 있습니다', '트레이 아이콘에서 창을 다시 열 수 있습니다.');
  });
};

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

// ---------- 트레이 ----------
const trayTooltip = () => (watcher
  ? `코레일 감시 중${lastStatus ? `\n${lastStatus}` : ''}`
  : '코레일 좌석 감시 — 대기 중');

const refreshTray = () => {
  if (!tray) return;
  tray.setToolTip(trayTooltip().slice(0, 127));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: watcher ? '● 감시 중' : '○ 대기 중', enabled: false },
    ...(lastStatus ? [{ label: lastStatus.slice(0, 90), enabled: false }] : []),
    { type: 'separator' },
    { label: '창 열기', click: showWindow },
    { label: '감시 중지', enabled: !!watcher, click: () => { stopWatcher(); } },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ]));
};

const createTray = () => {
  const icon = nativeImage.createFromPath(join(appDir, 'tray-icon.png'));
  tray = new Tray(icon);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  refreshTray();
};

// ---------- OS 알림 ----------
const notify = (title, body) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, icon: join(appDir, 'icon.png') });
  notification.on('click', showWindow);
  notification.show();
};

// ---------- 감시 ----------
const stopWatcher = async () => {
  if (!watcher) return;
  const running = watcher;
  running.stop();
  // 진행 중인 주기를 기다리지 않는다. 브라우저를 닫으면 조회가 즉시 끊기고
  // 루프는 이미 stop 상태라 그대로 마무리된다 (CLI의 Ctrl+C와 같은 방식).
  await running.close();
};

const endMessage = ({ code, reason }) => {
  if (reason === 'reserved') return ['예약 완료 — 감시를 마쳤습니다', '결제는 자동으로 하지 않습니다. 기한 내에 직접 결제하세요.'];
  if (reason === 'fatal') return ['감시를 중단했습니다', '예약을 안전하게 끝내지 못했습니다. 코레일 예약내역을 확인하세요.'];
  if (reason === 'error') return ['감시를 시작하지 못했습니다', '로그를 확인하세요.'];
  if (reason === 'stopped') return ['감시를 중지했습니다', '설정을 바꿔 다시 시작할 수 있습니다.'];
  return [`감시가 끝났습니다 (${reason})`, `종료 코드 ${code}`];
};

const startWatcher = (request, input) => {
  // shell: 'app'은 엔진이 만드는 문구를 터미널이 아니라 화면 기준으로 바꾼다.
  const config = { ...request.config, profileDir: profileDir(), shell: 'app' };
  const running = createWatcher({ config, creds: request.creds });
  watcher = running;
  lastStatus = '';

  running.on('log', entry => send('korail:log', entry));
  running.on('status', status => {
    lastStatus = status.text;
    send('korail:status', status);
    refreshTray();
  });
  running.on('found', payload => {
    send('korail:found', payload);
    notify('🟢 코레일 공석 발생', payload.hits.map(hit => `${hit.name} ${hit.label}`).join(', '));
  });
  running.on('reserved', payload => {
    send('korail:reserved', payload);
    notify('✅ 코레일 예약 완료', payload.summary);
  });
  running.on('error', ({ error }) => {
    send('korail:log', { level: 'error', text: `치명적 오류: ${error.message || error}` });
  });

  running.start().then((outcome) => {
    watcher = null;
    lastStatus = '';
    send('korail:end', outcome);
    const [title, body] = endMessage(outcome);
    notify(title, body);
    refreshTray();
    // 예약까지 자동으로 끝났으면 창을 띄워 결제 안내를 바로 보게 한다.
    if (outcome.reason === 'reserved' || outcome.reason === 'fatal') showWindow();
  });

  refreshTray();
  return { reserve: input.mode === 'reserve' };
};

// ---------- IPC ----------
ipcMain.handle('korail:defaults', () => {
  const saved = resolveCredentials({}, readEnvFile(envPath()));
  return {
    ok: true,
    korailId: saved.korailId,
    korailPw: saved.korailPw,
    telegramToken: saved.telegramToken,
    telegramChatIds: saved.telegramChatIds.join(','),
    fromEnvFile: Object.fromEntries(
      Object.entries(saved.sources).map(([field, source]) => [field, source === 'file']),
    ),
  };
});

ipcMain.handle('korail:run', (_event, input) => {
  if (watcher) return { ok: false, error: '이미 감시를 실행 중입니다.' };
  const request = buildRunRequest(input ?? {});
  if (request.error) return { ok: false, error: request.error };
  startWatcher(request, input ?? {});
  return { ok: true, command: request.command, warnings: request.warnings };
});

ipcMain.handle('korail:stop', async () => {
  if (!watcher) return { ok: false, error: '실행 중인 감시가 없습니다.' };
  await stopWatcher();
  return { ok: true };
});

// ---------- 수명 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.setAppUserModelId(APP_ID);

  app.whenReady().then(() => {
    createWindow();
    createTray();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });

  app.on('window-all-closed', () => {
    if (!watcher && process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (event) => {
    if (!watcher) return;
    // 크롬을 남겨두고 죽지 않도록 정리한 뒤 다시 종료한다.
    event.preventDefault();
    quitting = true;
    await stopWatcher();
    app.quit();
  });
}
