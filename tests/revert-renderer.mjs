import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const temp = await mkdtemp('/private/tmp/svn-workspace-revert-demo-');
const repository = path.join(temp, 'repository');
const workspace = path.join(temp, 'demo-project');
const profile = path.join(temp, 'profile');
const binary = process.env.SVN_BINARY || '/opt/homebrew/bin/svn';
const admin = process.env.SVNADMIN_BINARY || '/opt/homebrew/bin/svnadmin';
const folder = '이전 @화면';
const url = pathToFileURL(repository).href;
const run = (...args) => execFileSync(binary, [...args, '--non-interactive', '--no-auth-cache', '--config-dir', path.join(temp, 'svn-config')], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (name, contents) => writeFile(path.join(workspace, name), contents);
const read = name => readFile(path.join(workspace, name), 'utf8');
let app;
try {
  execFileSync(admin, ['create', repository]);
  execFileSync(binary, ['checkout', url, workspace, '--non-interactive'], { stdio: 'pipe' });
  await mkdir(path.join(workspace, folder, 'styles'), { recursive: true });
  await mkdir(path.join(workspace, '누락 폴더'));
  await write('welcome.ts', "export const greeting = '기준 안내 문구';\n");
  await write('README.md', '# 예제 프로젝트\n');
  await write(path.join(folder, 'styles', 'theme.css'), '.demo { padding: 12px; }\n');
  await write(path.join(folder, 'welcome.txt'), '복원할 예제 안내\n');
  await write('누락 폴더/notes.txt', '누락 폴더도 복원합니다.\n');
  run('add', 'welcome.ts', 'README.md', folder + '@', '누락 폴더');
  run('commit', '-m', '[개발자] 되돌리기 체험용 예제 구성', '--username', 'demo');
  run('update');
  await write('welcome.ts', "export const greeting = '되돌릴 로컬 안내 문구';\n");
  await write('README.md', '# 예제 프로젝트\n\n유지할 문서 변경입니다.\n');
  await write('features.ts', "export const feature = '유지할 새 파일';\n");
  await write('added.txt', '추가 예약 상태와 내용을 유지합니다.\n');
  run('add', 'added.txt');
  run('delete', folder + '@');
  await rm(path.join(workspace, '누락 폴더'), { recursive: true });
  await mkdir(profile);
  await mkdir(path.join(root, 'screenshots'), { recursive: true });
  const id = createHash('sha256').update(workspace).digest('hex').slice(0, 20);
  const project = { id, name: '예제 프로젝트 · 되돌리기 체험', path: workspace, url, repositoryRoot: url, relativeUrl: '^/', uuid: run('info', '--show-item', 'repos-uuid', '.').trim(), revision: 1 };
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ version: 1, projects: [project], activeProjectId: id, svnPath: binary }));
  const env = { ...process.env, SVN_WORKSPACE_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  app = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'dist-electron/main.cjs')], cwd: root, env });
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.locator('.history-item').waitFor();
  await page.getByTitle('커밋할 파일과 메시지 작성', { exact: true }).click();
  const box = name => page.getByRole('checkbox', { name: name + ' 커밋 선택', exact: true });
  const revert = page.getByRole('button', { name: '선택 항목 되돌리기', exact: true });
  const dialog = page.getByRole('dialog', { name: '선택한 변경을 되돌릴까요?', exact: true });
  const openReview = async () => { await revert.click(); await dialog.waitFor(); };
  const confirm = async count => { await dialog.getByRole('button', { name: count + '개 항목 되돌리기', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); await page.locator('.revert-success').waitFor(); };
  const status = async () => { const result = await page.evaluate(id => window.svn.status(id), id); assert.ok(result.ok); return result.data; };
  const fit = async locator => {
    const b = await locator.boundingBox();
    const v = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    assert.ok(b && b.width > 0 && b.height > 0 && b.x >= 0 && b.y >= 0 && b.x + b.width <= v.w + 1 && b.y + b.height <= v.h + 1, 'required control fits viewport');
  };
  await box('welcome.ts').waitFor();

  if (process.argv.includes('--preview')) {
    await box('welcome.ts').check(); await box(folder).check();
    await page.getByTitle('welcome.ts · 수정', { exact: true }).click();
    await page.locator('.diff-code').filter({ hasText: '되돌릴 로컬 안내 문구' }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await page.screenshot({ path: path.join(root, 'screenshots/21-revert-live-preview.png'), scale: 'css' });
    console.log('READY: isolated demo app is open on the commit screen. No real project or account is connected.');
    await new Promise(resolve => page.once('close', resolve));
  } else {
    const preservedReadme = await read('README.md');
    const initial = run('status');
    await box('features.ts').check(); await box('added.txt').check();
    assert.ok(await revert.isDisabled(), 'new files alone cannot be reverted');
    await box('features.ts').uncheck(); await box('added.txt').uncheck();
    await box('welcome.ts').check(); await box(folder).check();
    await page.locator('#commit-message').fill('유지할 커밋 메시지 초안');
    await fit(revert);
    await page.screenshot({ path: path.join(root, 'screenshots/17-revert-selection.png'), scale: 'css' });
    await openReview();
    await dialog.getByRole('list', { name: folder + ' 함께 복원할 항목', exact: true }).getByText('styles/theme.css', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(run('status'), initial, 'preview and cancel never mutate the working copy');
    await assert.rejects(access(path.join(workspace, folder)), { code: 'ENOENT' });

    await openReview();
    await write('welcome.ts', "export const greeting = '확인 이후 새로 수정한 내용';\n");
    await dialog.getByRole('button', { name: '2개 항목 되돌리기', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('alert').filter({ hasText: '확인 이후' }).waitFor();
    assert.match(await read('welcome.ts'), /확인 이후 새로 수정한 내용/);
    await assert.rejects(access(path.join(workspace, folder)), { code: 'ENOENT' });
    assert.equal(await page.locator('.revert-success').count(), 0);
    // The rejected operation is finished before another confirmation is requested.
    await page.getByRole('status').filter({ hasText: '선택 항목 되돌리기 중' }).waitFor({ state: 'hidden' });
    await openReview();
    await fit(dialog); await fit(dialog.getByRole('button', { name: '2개 항목 되돌리기', exact: true }));
    await page.screenshot({ path: path.join(root, 'screenshots/18-revert-review.png'), scale: 'css' });
    await confirm(2);
    assert.equal(await read('welcome.ts'), "export const greeting = '기준 안내 문구';\n");
    assert.equal(await read(path.join(folder, 'styles', 'theme.css')), '.demo { padding: 12px; }\n');
    assert.equal(await read('README.md'), preservedReadme);
    assert.match(await read('features.ts'), /유지할 새 파일/);
    assert.match(await read('added.txt'), /추가 예약 상태/);
    await box('welcome.ts').waitFor({ state: 'hidden' });
    await box(folder).waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#commit-message').inputValue(), '유지할 커밋 메시지 초안');
    await page.screenshot({ path: path.join(root, 'screenshots/19-revert-complete.png'), scale: 'css' });

    await box('누락 폴더').check(); await openReview(); await confirm(1);
    assert.match(await read('누락 폴더/notes.txt'), /누락 폴더도 복원/);
    await box('누락 폴더').waitFor({ state: 'hidden' });
    await box('README.md').check(); await box('features.ts').check(); await box('added.txt').check();
    await openReview();
    await dialog.getByText('선택 항목 중 유지: added.txt · features.ts', { exact: true }).waitFor();
    await confirm(1);
    assert.equal(await read('README.md'), '# 예제 프로젝트\n');
    const remaining = await status();
    assert.deepEqual(remaining.map(item => [item.path, item.status]).sort(), [['added.txt', 'added'], ['features.ts', 'unversioned']]);
    assert.equal(run('info', '--show-item', 'revision', '.').trim(), '1', 'revert never creates a repository revision');

    await write('welcome.ts', "export const greeting = '작은 창 검증';\n");
    await page.getByTitle('로컬 변경 사항 새로고침', { exact: true }).click();
    await box('welcome.ts').check();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 700));
    await page.waitForFunction(() => innerWidth === 1024);
    await fit(revert); await fit(page.getByTitle('선택한 항목 서버에 커밋', { exact: true }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1024);
    await openReview(); await fit(dialog); await fit(dialog.getByRole('button', { name: '1개 항목 되돌리기', exact: true }));
    await page.screenshot({ path: path.join(root, 'screenshots/20-revert-compact.png'), scale: 'css' });
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.match(await read('welcome.ts'), /작은 창 검증/);
    for (const files of [['../outside.txt'], ['.svn/wc.db'], ['.']]) {
      const result = await page.evaluate(({ id, files }) => window.svn.revertPreview(id, files), { id, files });
      assert.equal(result.ok, false); assert.equal(result.error.code, 'INVALID_ARGUMENT');
    }
    assert.deepEqual(errors, []);
    console.log('PASS: real SVN + IPC selection, folder descendants, cancel, stale-content rejection, file/deleted/missing-folder restoration, new/added/unselected preservation, message draft, no new revision, invalid paths, 1024x700 controls and modal.');
  }
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
