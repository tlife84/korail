/**
 * `npm run app`이 부르는 실행기.
 *
 * electron 바이너리를 직접 부르지 않고 한 겹 감싸는 이유는 하나다:
 * ELECTRON_RUN_AS_NODE가 켜진 셸(VS Code 확장 호스트가 띄운 터미널 등)에서
 * electron을 실행하면 창을 띄우는 대신 그냥 Node로 동작한다. 그러면
 * `import { app } from 'electron'`이 "does not provide an export named 'app'"으로
 * 죽는데, 원인이 코드에 없어서 찾기가 아주 나쁘다. 그래서 여기서 지우고 띄운다.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [projectDir, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 0));
child.on('error', error => {
  console.error(`Electron을 실행하지 못했습니다: ${error.message}`);
  process.exit(1);
});
