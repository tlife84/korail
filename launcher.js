#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWatchArgs, formatWatchCommand } from './launcher-options.js';
import { readEnvFile, resolveCredentials, buildCredentialEnv, credentialWarnings } from './env-config.js';

const projectDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(projectDir, 'launcher.html'), 'utf8');
const envPath = resolve(projectDir, '.env');
const host = '127.0.0.1';
let watcherStarted = false;
let pendingUiClose = null;

const cancelPendingUiClose = () => {
  if (!pendingUiClose) return;
  clearTimeout(pendingUiClose);
  pendingUiClose = null;
};

const scheduleUiClose = () => {
  if (watcherStarted || pendingUiClose) return;
  pendingUiClose = setTimeout(() => {
    pendingUiClose = null;
    if (watcherStarted) return;
    console.log('[UI] 설정 화면이 닫혀 런처를 종료합니다.');
    server.close(() => process.exit(0));
  }, 1000);
};

const isSameOrigin = request => {
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).hostname === host; } catch { return false; }
};

const sendJson = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

const readJson = request => new Promise((resolveBody, reject) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => {
    body += chunk;
    if (body.length > 64 * 1024) reject(new Error('요청 내용이 너무 큽니다.'));
  });
  request.on('end', () => {
    try { resolveBody(JSON.parse(body)); }
    catch { reject(new Error('입력값을 읽지 못했습니다.')); }
  });
  request.on('error', reject);
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}`);
  if (request.method === 'GET' && url.pathname === '/') {
    cancelPendingUiClose();
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(html);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/defaults') {
    if (!isSameOrigin(request)) {
      sendJson(response, 403, { ok: false, error: '이 설정 화면에서만 사용할 수 있습니다.' });
      return;
    }
    cancelPendingUiClose();
    const saved = resolveCredentials({}, readEnvFile(envPath));
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, {
      ok: true,
      korailId: saved.korailId,
      korailPw: saved.korailPw,
      telegramToken: saved.telegramToken,
      telegramChatIds: saved.telegramChatIds.join(','),
      fromEnvFile: Object.fromEntries(
        Object.entries(saved.sources).map(([field, source]) => [field, source === 'file']),
      ),
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/close') {
    response.writeHead(204);
    response.end();
    scheduleUiClose();
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/run') {
    if (watcherStarted) {
      sendJson(response, 409, { ok: false, error: '이미 감시 프로그램을 실행했습니다.' });
      return;
    }
    if (!isSameOrigin(request)) {
      sendJson(response, 403, { ok: false, error: '이 설정 화면에서만 사용할 수 있습니다.' });
      return;
    }
    try {
      const input = await readJson(request);
      const args = buildWatchArgs(input);
      // 비밀번호·토큰은 명령줄 인자가 아니라 환경변수로 넘긴다.
      // 인자는 작업 관리자와 명령어 미리보기에 그대로 노출된다.
      const credentialEnv = buildCredentialEnv(input);
      const warnings = credentialWarnings(resolveCredentials(credentialEnv), {
        reserve: input.mode === 'reserve',
      });
      const command = formatWatchCommand(args);
      watcherStarted = true;
      cancelPendingUiClose();
      console.log(`\n[UI] 실행 명령\n${command}\n`);
      for (const warning of warnings) console.warn(`[UI] 경고: ${warning}`);
      const child = spawn(process.execPath, [resolve(projectDir, 'watch.js'), ...args], {
        cwd: projectDir,
        stdio: 'inherit',
        env: { ...process.env, ...credentialEnv },
      });
      child.on('error', error => {
        console.error(`[UI] 감시 프로그램을 시작하지 못했습니다: ${error.message}`);
        process.exitCode = 1;
      });
      child.on('close', code => process.exit(code ?? 1));
      sendJson(response, 202, { ok: true, command, warnings });
      setTimeout(() => server.close(), 500);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
    return;
  }
  response.writeHead(404);
  response.end('Not Found');
});

const openBrowser = url => {
  const target = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const opener = spawn(target[0], target[1], { detached: true, stdio: 'ignore' });
  opener.unref();
  opener.on('error', () => console.log(`[UI] 브라우저에서 직접 여세요: ${url}`));
};

const requestedPort = Number(process.env.KORAIL_UI_PORT || 0);
server.listen(Number.isInteger(requestedPort) ? requestedPort : 0, host, () => {
  const address = server.address();
  const url = `http://${host}:${address.port}/`;
  console.log('코레일 감시 설정 화면을 엽니다.');
  console.log(`자동으로 열리지 않으면 브라우저에서 ${url} 를 여세요.`);
  if (process.env.KORAIL_UI_NO_OPEN !== '1') openBrowser(url);
});

server.on('error', error => {
  console.error(`[UI] 서버를 시작하지 못했습니다: ${error.message}`);
  process.exit(1);
});
