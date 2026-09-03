/**
 * 렌더러(launcher.html)가 보는 유일한 창구.
 *
 * 화면 코드는 HTTP 런처에서도 그대로 돌아야 하므로, 여기서 노출하는 모양을
 * `fetch('/api/...')` 어댑터와 똑같이 맞춘다 — 실패는 예외, 성공은 결과 객체.
 * 샌드박스 프리로드라 CommonJS(.cjs)여야 한다.
 */
const { contextBridge, ipcRenderer } = require('electron');

/** main이 보내는 이벤트를 구독한다. 돌려주는 함수를 부르면 구독을 끊는다. */
const subscribe = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
};

const request = async (channel, payload) => {
  const result = await ipcRenderer.invoke(channel, payload);
  if (result && result.ok === false) throw new Error(result.error);
  return result;
};

contextBridge.exposeInMainWorld('korail', {
  // 이 값이 true면 화면이 실행 후 로그 패널로 전환한다(터미널이 없으므로).
  streaming: true,
  loadDefaults: () => request('korail:defaults'),
  run: (input) => request('korail:run', input),
  stop: () => request('korail:stop'),
  onLog: subscribe('korail:log'),
  onStatus: subscribe('korail:status'),
  onFound: subscribe('korail:found'),
  onReserved: subscribe('korail:reserved'),
  onEnd: subscribe('korail:end'),
});
