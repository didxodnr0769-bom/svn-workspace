import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { SettingsStore, CredentialStore } from './storage';
import { openInVSCode } from './editor';
import { discoverSvn, SvnService, SvnServiceError } from './svn-service';
import type { AppError, AppState, AuthOptions, CommittedPath, Credentials, Project, Result } from '../shared/types';

app.setName('SVN Workspace');
if (process.env.SVN_WORKSPACE_DATA_DIR) app.setPath('userData', path.resolve(process.env.SVN_WORKSPACE_DATA_DIR));
let window: BrowserWindow | null = null;
let settings: SettingsStore;
let credentials: CredentialStore;
let svn: { path: string; version: string } | null = null;
let service: SvnService | null = null;
let mutationRunning = false;
const appRoot = path.resolve(__dirname, '..');
const rendererURL = process.env.VITE_DEV_SERVER_URL;
const productionURL = pathToFileURL(path.join(appRoot, 'dist', 'index.html')).href;
const fail = (message: string): never => { throw new SvnServiceError('INVALID_ARGUMENT', message); };
function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) return fail(label + ' 값이 올바르지 않습니다.');
  return value;
}
function localPath(input: unknown): string {
  const value = text(input, '폴더').trim();
  const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) return fail('절대 경로 또는 ~/로 시작하는 폴더를 입력해 주세요.');
  return path.normalize(expanded);
}
function apiService(): SvnService { if (!service) throw new SvnServiceError('SVN_NOT_FOUND', 'SVN 실행 파일을 먼저 연결해 주세요.'); return service; }
function project(id: unknown): Project {
  const value = text(id, '프로젝트', 100);
  const found = settings.snapshot().projects.find(p => p.id === value);
  if (!found) return fail('작업 폴더를 다시 선택해 주세요.');
  return found;
}
function getCredentials(auth: unknown): Credentials | undefined {
  if (auth === undefined) return undefined;
  if (!auth || typeof auth !== 'object') return fail('인증 요청이 올바르지 않습니다.');
  const value = (auth as AuthOptions).credentials;
  if (!value) return undefined;
  const username = text(value.username, '아이디', 256).trim();
  const password = text(value.password, '비밀번호', 4096);
  if (!username || /[\r\n]/.test(username + password)) return fail('아이디와 비밀번호를 확인해 주세요.');
  return { username, password, remember: value.remember === true };
}
function normalizeError(error: unknown): AppError {
  if (error instanceof SvnServiceError) return { code: error.code, message: error.message, detail: error.detail, authTarget: error.authTarget };
  const native = error as NodeJS.ErrnoException;
  return { code: 'IO_ERROR', message: native?.code === 'ENOENT' ? '파일 또는 폴더를 찾을 수 없습니다. 위치를 확인해 주세요.' : '작업을 완료하지 못했습니다.', detail: error instanceof Error ? error.message : String(error) };
}
async function withAuth<T>(target: string, auth: unknown, fn: (value?: Credentials) => Promise<T>): Promise<T> {
  const supplied = getCredentials(auth);
  const selected = supplied ?? credentials.get(target);
  try {
    const result = await fn(selected);
    if (supplied) {
      try { await credentials.set(target, supplied); }
      catch {
        if (window) void dialog.showMessageBox(window, { type: 'info', message: '작업은 완료되었지만 로그인 정보를 저장하지 못했습니다.', detail: '현재 실행 중에는 계정을 유지합니다. 다음 실행 때 다시 로그인해 주세요.', buttons: ['확인'] });
      }
    }
    return result;
  } catch (error) {
    if (error instanceof SvnServiceError && error.code === 'AUTH_REQUIRED') {
      credentials.forgetSession(target);
      error.authTarget = target;
    }
    throw error;
  }
}
async function mutation<T>(fn: () => Promise<T>): Promise<T> {
  if (mutationRunning) throw new SvnServiceError('BUSY', '다른 SVN 작업이 끝난 뒤 다시 시도해 주세요.');
  mutationRunning = true;
  try { return await fn(); } finally { mutationRunning = false; }
}
function snapshot(): AppState {
  const data = settings.snapshot();
  return { projects: data.projects, activeProjectId: data.activeProjectId, svn, credentialStorageAvailable: credentials.available() };
}
async function configureSvn(preferred?: string): Promise<void> {
  svn = await discoverSvn(preferred);
  service = new SvnService({ binaryPath: svn.path, onProgress: progress => { if (window && !window.isDestroyed()) window.webContents.send('svn:progress', progress); } });
}
function validSender(event: IpcMainInvokeEvent): boolean {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  const url = event.senderFrame?.url;
  if (!url) return false;
  if (rendererURL) return url === rendererURL || url === rendererURL + '/';
  return url === productionURL || url.startsWith(productionURL + '#');
}
function handle(name: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle('svn:' + name, async (event, ...args): Promise<Result<unknown>> => {
    if (!validSender(event)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: '허용되지 않은 요청입니다.' } };
    try { return { ok: true, data: await fn(...args) }; }
    catch (error) { return { ok: false, error: normalizeError(error) }; }
  });
}
async function safeFile(root: string, relative: unknown): Promise<string> {
  const rel = text(relative, '파일');
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).some(p => p === '..' || p.toLowerCase() === '.svn')) return fail('작업 폴더 안의 파일만 열 수 있습니다.');
  const base = await fs.realpath(root);
  const target = await fs.realpath(path.resolve(base, rel));
  if (target === base || !target.startsWith(base + path.sep)) return fail('작업 폴더 안의 파일만 열 수 있습니다.');
  if (!(await fs.stat(target)).isFile()) return fail('파일을 선택해 주세요.');
  return target;
}
function setupIPC(): void {
  handle('bootstrap', () => snapshot());
  handle('chooseDirectory', async mode => {
    if (!window) return null;
    if (mode !== 'destination' && mode !== 'existing') return fail('폴더 선택 요청이 올바르지 않습니다.');
    const result = await dialog.showOpenDialog(window, mode === 'destination'
      ? { title: '체크아웃 받을 폴더 선택', buttonLabel: '이 폴더 사용', defaultPath: app.getPath('documents'), properties: ['openDirectory', 'createDirectory'] }
      : { title: 'SVN 작업 폴더 열기', buttonLabel: '작업 폴더 열기', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('chooseSvnExecutable', async () => {
    if (!window) return snapshot();
    if (mutationRunning) throw new SvnServiceError('BUSY', '작업이 끝난 뒤 SVN을 변경해 주세요.');
    const result = await dialog.showOpenDialog(window, { title: 'svn 실행 파일 선택', buttonLabel: '선택', defaultPath: '/opt/homebrew/bin/svn', properties: ['openFile', 'showHiddenFiles'] });
    if (!result.canceled && result.filePaths[0]) { await configureSvn(result.filePaths[0]); await settings.setSvnPath(svn!.path); }
    return snapshot();
  });
  handle('openProject', async input => {
    const folder = localPath(input);
    const info = await apiService().info(folder);
    return settings.add(info);
  });
  handle('selectProject', async id => { const selected = project(id); if (mutationRunning) throw new SvnServiceError('BUSY', '작업이 끝난 뒤 폴더를 바꿔 주세요.'); await settings.select(selected.id); });
  handle('renameProject', async (id, input) => {
    const selected = project(id);
    const name = text(input, '프로젝트 별칭', 128).trim();
    if (!name || /[\x00-\x1f\x7f]/.test(name)) return fail('별칭은 1~128자의 한 줄로 입력해 주세요.');
    return settings.rename(selected.id, name);
  });
  handle('removeProject', async id => {
    const selected = project(id);
    if (mutationRunning) throw new SvnServiceError('BUSY', '작업이 끝난 뒤 프로젝트를 목록에서 제거해 주세요.');
    await settings.remove(selected.id);
    return snapshot();
  });
  handle('openInVSCode', id => openInVSCode(project(id).path));
  handle('checkout', async (input, auth) => mutation(async () => {
    if (!input || typeof input !== 'object') return fail('체크아웃 정보를 입력해 주세요.');
    const url = text(input.url, '저장소 URL').trim();
    const destination = localPath(input.destination);
    const name = text(input.name, '작업 폴더 이름', 128).trim();
    return withAuth(url, auth, async account => {
      // Authenticate before checkout can create a partial working copy.
      await apiService().info(url, account);
      const result = await apiService().checkout({ url, destination }, account);
      const info = await apiService().info(destination);
      return { project: await settings.add(info, name), result };
    });
  }));
  handle('history', async (id, before, auth) => {
    const selected = project(id);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) return fail('리비전 번호가 올바르지 않습니다.');
    return withAuth(selected.url, auth, account => apiService().history(selected.path, { limit: 50, beforeRevision: before }, account));
  });
  handle('historicalDiff', async (id, revision, change, auth) => {
    const selected = project(id);
    if (!Number.isSafeInteger(revision) || revision < 1 || !change || typeof change !== 'object') return fail('커밋과 파일을 선택해 주세요.');
    const entry: CommittedPath = { path: text(change.path, '파일'), action: change.action, kind: change.kind };
    if (!['A', 'M', 'D', 'R'].includes(entry.action) || !['file', 'dir', 'unknown'].includes(entry.kind)) return fail('변경 파일 정보가 올바르지 않습니다.');
    return withAuth(selected.url, auth, account => apiService().historicalDiff(selected.path, revision, entry, account));
  });
  handle('status', id => apiService().status(project(id).path));
  handle('workingDiff', (id, relative) => apiService().workingDiff(project(id).path, text(relative, '파일')));
  handle('deletionPreview', (id, relative) => apiService().deletionPreview(project(id).path, text(relative, '폴더')));
  handle('update', (id, auth) => mutation(async () => { const selected = project(id); return withAuth(selected.url, auth, account => apiService().update(selected.path, account)); }));
  handle('commit', (id, files, message, auth) => mutation(async () => {
    const selected = project(id);
    if (!Array.isArray(files) || !files.length || files.length > 2000) return fail('커밋할 파일을 선택해 주세요.');
    const paths = [...new Set(files.map((file: unknown) => text(file, '파일')))];
    const body = text(message, '커밋 메시지', 100000);
    if (!body.trim()) return fail('커밋 메시지를 입력해 주세요.');
    return withAuth(selected.url, auth, account => apiService().commit(selected.path, paths, body, account));
  }));
  handle('resolve', (id, relative) => mutation(() => apiService().resolve(project(id).path, text(relative, '파일'))));
  handle('openFile', async (id, relative) => { const target = await safeFile(project(id).path, relative); const error = await shell.openPath(target); if (error) throw new SvnServiceError('IO_ERROR', '파일을 열지 못했습니다.', error); });
  handle('revealProject', async id => { const folder = project(id).path; await fs.access(folder); const error = await shell.openPath(folder); if (error) throw new SvnServiceError('IO_ERROR', '폴더를 열지 못했습니다.', error); });
  handle('cancelOperation', () => { service?.cancel(); });
}
function createWindow(): void {
  window = new BrowserWindow({ width: 1440, height: 900, minWidth: 1024, minHeight: 700, title: 'SVN Workspace', backgroundColor: '#f7f8fa', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 13 }, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== (rendererURL ?? productionURL)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = null; });
  if (rendererURL) void window.loadURL(rendererURL);
  else void window.loadFile(path.join(appRoot, 'dist', 'index.html'));
}
void app.whenReady().then(async () => {
  settings = new SettingsStore(app.getPath('userData'));
  credentials = new CredentialStore(app.getPath('userData'), safeStorage);
  await settings.load();
  await credentials.load();
  try { await configureSvn(settings.snapshot().svnPath); } catch { svn = null; }
  setupIPC();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'SVN Workspace', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '보기', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : [])] },
    { label: '윈도우', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ]));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}).catch(error => { dialog.showErrorBox('SVN Workspace를 시작하지 못했습니다', error instanceof Error ? error.message : String(error)); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => service?.cancel());
