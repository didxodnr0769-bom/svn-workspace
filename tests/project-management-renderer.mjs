import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
await mkdir(path.join(root, 'screenshots'), { recursive: true });
// A public temporary prefix keeps personal workspace names out of UI screenshots.
const temp = await mkdtemp('/private/tmp/svn-workspace-project-management-qa-');
const profile = path.join(temp, 'profile');
const existing = path.join(temp, 'plain-project');
const missing = path.join(temp, 'deleted-project');
const destination = path.join(temp, '선택 @폴더');
const binary = path.join(temp, 'fake-svn.cjs');
const callsFile = path.join(temp, 'svn-calls.jsonl');
const settingsFile = path.join(profile, 'settings.json');
const credentialsFile = path.join(profile, 'credentials.json');
await mkdir(profile);
await mkdir(path.join(existing, '.svn'), { recursive: true });
await mkdir(destination);
await writeFile(path.join(existing, 'keep.txt'), 'keep existing project exactly');
await writeFile(path.join(existing, '.svn', 'keep.txt'), 'mock metadata must remain');
const credentialsContents = JSON.stringify({ fixture: { username: 'demo', ciphertext: 'fixture-only' } });
await writeFile(credentialsFile, credentialsContents);
const project = (id, directory) => ({ id, name: '예제 프로젝트 ' + id, path: directory, url: 'https://example.invalid/svn/project', repositoryRoot: 'https://example.invalid/svn', relativeUrl: '^/project', uuid: 'fixture-uuid', revision: 1 });
await writeFile(settingsFile, JSON.stringify({ version: 1, projects: [project('A', missing), project('B', existing)], activeProjectId: 'A', svnPath: binary }));
await writeFile(binary, `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(args)+'\\n');
const out=text=>process.stdout.write(text);
const escape=text=>text.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
if(args[0]==='--version')out('1.14.5\\n');
else if(args[0]==='log'){
 if(args.some(arg=>arg.includes('deleted-project'))){process.stderr.write('svn: E155007: mock working folder is missing\\n');process.exitCode=1;}
 else out('<?xml version="1.0"?><log/>');
}
else if(args[0]==='info'){
 const target=args[2].replace(/@$/,'');
 out('<?xml version="1.0"?><info><entry kind="dir" path="'+escape(target)+'" revision="1"><url>https://example.invalid/svn/project</url><relative-url>^/project</relative-url><repository><root>https://example.invalid/svn</root><uuid>fixture-uuid</uuid></repository><wc-info><depth>infinity</depth></wc-info></entry></info>');
}
else if(args[0]==='checkout')setTimeout(()=>out('Checked out revision 1.\\n'),1500);
else {process.stderr.write('Unexpected mock SVN command');process.exitCode=1;}
`, { mode: 0o700 });

const env = { ...process.env, SVN_WORKSPACE_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
let app;
let page;
const errors = [];
const settings = async () => JSON.parse(await readFile(settingsFile, 'utf8'));
const readCalls = async () => {
  try { return (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const launch = async () => {
  app = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'dist-electron', 'main.cjs')], cwd: root, env });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(String(error)));
  await page.getByRole('combobox', { name: '현재 프로젝트' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.boot-screen'));
};
const selectedId = () => page.getByRole('combobox', { name: '현재 프로젝트' }).inputValue();
const removalDialog = () => page.getByRole('dialog', { name: '프로젝트를 목록에서 제거할까요?', exact: true });
const openRemoval = async () => {
  await page.getByRole('button', { name: '프로젝트 설정', exact: true }).click();
  await page.getByTitle('프로젝트 목록에서 제거', { exact: true }).click();
  await removalDialog().waitFor();
};
const removeCurrent = async () => {
  await openRemoval();
  await removalDialog().getByRole('button', { name: '목록에서 제거', exact: true }).click();
  await removalDialog().waitFor({ state: 'hidden' });
};
const fit = async locator => {
  const bounds = await locator.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0 && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, 'control must fit viewport');
};

try {
  await launch();
  assert.equal(await selectedId(), 'A');
  await page.getByRole('alert').filter({ hasText: '파일 또는 폴더를 찾을 수 없습니다' }).waitFor();
  const original = await settings();
  await openRemoval();
  await fit(removalDialog());
  await page.screenshot({ path: path.join(root, 'screenshots', '16-project-removal.png'), scale: 'css' });
  await removalDialog().getByRole('button', { name: '취소', exact: true }).click();
  await removalDialog().waitFor({ state: 'hidden' });
  assert.deepEqual(await settings(), original, 'cancel preserves saved entries');
  await removeCurrent();
  await page.waitForFunction(() => document.querySelector('select[aria-label="현재 프로젝트"]')?.value === 'B');
  assert.deepEqual((await settings()).projects.map(project => project.id), ['B']);
  assert.equal((await settings()).activeProjectId, 'B');
  await assert.rejects(access(missing), { code: 'ENOENT' });
  await app.close(); app = undefined;
  await launch();
  assert.equal(await selectedId(), 'B', 'remaining active project restores after restart');
  assert.equal(await page.getByRole('combobox', { name: '현재 프로젝트' }).locator('option').count(), 1);

  // Invoke the real main-process picker and record its native API options.
  await app.evaluate(({ dialog }, selectedPath) => {
    globalThis.__qaDialogs = [];
    globalThis.__qaCancelPicker = false;
    dialog.showSaveDialog = async () => { throw Error('Checkout must use a directory picker'); };
    dialog.showOpenDialog = async (...args) => {
      globalThis.__qaDialogs.push(args.at(-1));
      return globalThis.__qaCancelPicker ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [selectedPath] };
    };
  }, destination);
  await page.getByTitle('새 저장소 체크아웃', { exact: true }).click();
  const checkout = page.getByRole('dialog', { name: '새 프로젝트 체크아웃' });
  await checkout.waitFor();
  await page.locator('#checkout-url').fill('https://example.invalid/svn/project');
  await page.locator('#checkout-name').fill('예제 체크아웃');
  await page.getByTitle('체크아웃 받을 폴더 선택', { exact: true }).click();
  await page.waitForFunction(expected => document.querySelector('#checkout-destination')?.value === expected, destination);
  assert.equal(await page.locator('#checkout-destination').inputValue(), destination, 'chosen directory is used exactly');
  const options = await app.evaluate(() => globalThis.__qaDialogs.at(-1));
  assert.ok(options.properties.includes('openDirectory'));
  assert.ok(options.properties.includes('createDirectory'));
  assert.ok(!JSON.stringify(options).includes('work-web'), 'no forced default child folder');
  await page.locator('#checkout-destination').fill(destination + '-manual');
  await app.evaluate(() => { globalThis.__qaCancelPicker = true; });
  await page.getByTitle('체크아웃 받을 폴더 선택', { exact: true }).click();
  assert.equal(await page.locator('#checkout-destination').inputValue(), destination + '-manual', 'picker cancel preserves typed path');
  await app.evaluate(() => { globalThis.__qaCancelPicker = false; });
  await page.getByTitle('체크아웃 받을 폴더 선택', { exact: true }).click();
  await page.waitForFunction(expected => document.querySelector('#checkout-destination')?.value === expected, destination);
  assert.equal(await page.locator('#checkout-destination').inputValue(), destination);
  await fit(checkout);
  await page.screenshot({ path: path.join(root, 'screenshots', '15-checkout-location.png'), scale: 'css' });
  await checkout.getByTitle('체크아웃 시작', { exact: true }).click();
  for (let attempt = 0; attempt < 100 && !(await readCalls()).some(args => args[0] === 'checkout'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  const command = (await readCalls()).find(args => args[0] === 'checkout');
  assert.ok(command, 'fake checkout command was received');
  assert.equal(command[2], destination, 'actual SVN service gets the exact selected path');
  const busyRemoval = await page.evaluate(() => window.svn.removeProject('B'));
  assert.equal(busyRemoval.ok, false);
  assert.equal(busyRemoval.error.code, 'BUSY', 'project removal is rejected while checkout runs');
  const resultDialog = page.getByRole('dialog', { name: '체크아웃 완료', exact: true });
  await resultDialog.waitFor();
  await resultDialog.getByRole('button', { name: '확인', exact: true }).click();
  assert.equal((await settings()).projects.length, 2);
  const checkedOutId = await selectedId();
  assert.notEqual(checkedOutId, 'B');
  assert.equal((await settings()).projects.find(project => project.id === checkedOutId).path.normalize('NFC'), destination.normalize('NFC'));
  await removeCurrent();
  await page.waitForFunction(() => document.querySelector('select[aria-label="현재 프로젝트"]')?.value === 'B');
  assert.ok((await stat(destination)).isDirectory(), 'removing checkout registration leaves selected directory intact');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 700));
  await page.waitForFunction(() => innerWidth === 1024);
  await openRemoval();
  await fit(removalDialog());
  await fit(removalDialog().getByRole('button', { name: '목록에서 제거', exact: true }));
  await page.keyboard.press('Escape');
  await removalDialog().waitFor({ state: 'hidden' });
  await removeCurrent();
  await page.waitForFunction(() => document.querySelector('select[aria-label="현재 프로젝트"]')?.disabled === true);
  assert.deepEqual((await settings()).projects, []);
  assert.equal((await settings()).activeProjectId, null);
  assert.ok(await page.getByTitle('서버의 최신 변경 사항 받기', { exact: true }).isDisabled());
  assert.ok(await page.getByTitle('커밋할 파일과 메시지 작성', { exact: true }).isDisabled());
  assert.equal(await readFile(path.join(existing, 'keep.txt'), 'utf8'), 'keep existing project exactly');
  assert.equal(await readFile(path.join(existing, '.svn', 'keep.txt'), 'utf8'), 'mock metadata must remain');
  assert.equal(await readFile(credentialsFile, 'utf8'), credentialsContents, 'saved credentials are untouched');
  assert.equal((await settings()).svnPath, binary);
  const beforeUnknown = await settings();
  const unknown = await page.evaluate(() => window.svn.removeProject('unknown'));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'INVALID_ARGUMENT');
  assert.deepEqual(await settings(), beforeUnknown);
  await app.close(); app = undefined;
  await launch();
  assert.equal(await selectedId(), '');
  assert.ok(await page.getByRole('combobox', { name: '현재 프로젝트' }).isDisabled());
  const calls = await readCalls();
  assert.ok(calls.every(args => ['--version', 'log', 'info', 'checkout'].includes(args[0])), 'no delete/update/commit command is sent');
  assert.deepEqual(errors, []);
  console.log('PASS: exact checkout folder with native picker and cancel, real IPC path forwarding, busy-removal guard, missing-project removal/cancel/restart, intact existing files/metadata/credentials, final empty list and unknown-ID guard, compact dialog layout.');
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
