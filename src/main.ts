import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Store } from './store.js';
import { AppController } from './controller.js';
import { stopAsideProcesses } from './adapters/aside-client.js';
import { stopAsideTaskProcesses } from './adapters/aside-tasks.js';
import { runSmoke, smokeServices } from './smoke.js';
import { runAppLiveCheck } from './app-live-check.js';

const smoke = process.argv.includes('--smoke-test');
const liveCheck = process.argv.includes('--live-check');
if (smoke && liveCheck) throw new Error('검증 모드를 동시에 실행할 수 없습니다.');
if (smoke || liveCheck) app.setPath('userData', mkdtempSync(join(tmpdir(), 'auto-flow-check-')));
let store: Store;
let controller: AppController;
let window: BrowserWindow | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let quitting = false;
const rendererUrl = pathToFileURL(join(__dirname, 'renderer/index.html')).href;
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '작업에 실패했습니다.';
  return message.replace(/https?:\/\/[^\s]+/g, '[주소 생략]').slice(0, 350);
}
async function start() {
  const data = app.getPath('userData');
  mkdirSync(data, { recursive: true });
  store = new Store(join(data, 'auto-flow.sqlite'));
  const mocks = smoke ? smokeServices() : undefined;
  controller = new AppController(store, mocks?.workflow, mocks?.browserFor, url => shell.openExternal(url));
  ipcMain.handle('auto-flow:execute', async (event, input: unknown) => {
    if (quitting || !window || window.isDestroyed() || event.sender.isDestroyed()) throw new Error('앱이 종료 중입니다.');
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== rendererUrl) throw new Error('허용되지 않은 요청입니다.');
    if (liveCheck && input && typeof input === 'object' && 'type' in input && ['approve', 'runJob', 'issueLink', 'checkJob', 'reconcile'].includes(String(input.type))) {
      throw new Error('실제 생성 검증 모드에서는 발급·승인·게시를 실행할 수 없습니다.');
    }
    try { return await controller.execute(input); }
    catch (error) { throw new Error(safeError(error)); }
  });
  window = new BrowserWindow({ width: 1320, height: 900, minWidth: 900, minHeight: 650, backgroundColor: '#101827', show: !smoke,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.on('render-process-gone', () => { if (!quitting) store.setPaused(true); });
  await window.loadURL(rendererUrl);
  if (smoke) {
    await runSmoke(window);
    if (mocks!.publicationCalls() !== 2) throw new Error('모의 게시 횟수가 승인된 두 채널과 다릅니다.');
    app.quit();
  } else if (liveCheck) {
    const index = process.argv.indexOf('--live-check-input');
    const input = index >= 0 ? process.argv[index + 1] : undefined;
    if (!input) throw new Error('실제 검증용 상품 JSON 경로가 필요합니다.');
    await runAppLiveCheck(window, input);
    app.quit();
  } else timer = setInterval(() => { void controller.tick().catch(() => { if (!quitting) store.setPaused(true); }); }, 5000);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(start).catch(error => {
    console.error('START_FAILED', safeError(error));
    if (!smoke && !liveCheck) dialog.showErrorBox('Auto Flow 시작 오류', safeError(error));
    stopAsideProcesses(); stopAsideTaskProcesses(); store?.close(); app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    if (timer) clearInterval(timer);
    stopAsideProcesses(); stopAsideTaskProcesses();
    store?.close(); app.exit(0);
  });
}
