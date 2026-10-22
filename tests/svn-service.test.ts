import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SvnService, discoverSvn } from '../src/main/svn-service';

const exec = promisify(execFile);
const binary = process.env.SVN_BINARY || '/opt/homebrew/bin/svn';
const admin = process.env.SVNADMIN_BINARY || '/opt/homebrew/bin/svnadmin';
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svn-workspace-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repository');
  const wc = path.join(root, '작업 폴더');
  const peer = path.join(root, 'peer');
  await exec(admin, ['create', repo]);
  const url = pathToFileURL(repo).href;
  const service = new SvnService({ binaryPath: binary, onProgress() {} });
  await service.checkout({ url, destination: wc });
  const svn = (...args: string[]) => exec(binary, [...args, '--non-interactive'], { cwd: wc });
  const other = (...args: string[]) => exec(binary, [...args, '--non-interactive'], { cwd: peer });
  await writeFile(path.join(wc, 'alpha.txt'), 'alpha original\n');
  await writeFile(path.join(wc, 'beta.txt'), 'beta original\n');
  await writeFile(path.join(wc, '한글 공백@파일.txt'), 'special original\n');
  await svn('add', 'alpha.txt', 'beta.txt', '한글 공백@파일.txt@');
  await svn('commit', '-m', '[개발자] 첫 커밋', '--username', 'demo');
  await svn('update');
  await exec(binary, ['checkout', url, peer, '--non-interactive']);
  return { root, repo, wc, peer, url, svn, other, service };
}

test('discover, checkout, info, history pagination and historical diff', async t => {
  const { wc, service, svn } = await fixture(t);
  const discovered = await discoverSvn(binary);
  assert.ok(discovered);
  const info = await service.info(wc);
  assert.equal(info.revision, 1);
  assert.match(info.url, /^file:/);
  await writeFile(path.join(wc, 'alpha.txt'), 'alpha second\n');
  await svn('commit', 'alpha.txt', '-m', '두 번째 커밋');
  await svn('update');
  const page = await service.history(wc, { limit: 1 });
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].revision, 2);
  assert.equal(page.entries[0].message, '두 번째 커밋');
  assert.equal(page.hasMore, true);
  const next = await service.history(wc, { limit: 1, beforeRevision: 2 });
  assert.equal(next.entries[0].revision, 1);
  assert.equal(next.hasMore, false);
  const changed = page.entries[0].paths.find(p => p.path.endsWith('/alpha.txt'));
  assert.ok(changed);
  const diff = await service.historicalDiff(wc, 2, changed);
  assert.match(diff, /-alpha original/);
  assert.match(diff, /\+alpha second/);
});

test('selected commit preserves other modified and unversioned files including special paths', async t => {
  const { wc, service, svn } = await fixture(t);
  await writeFile(path.join(wc, 'alpha.txt'), 'alpha selected\n');
  await writeFile(path.join(wc, 'beta.txt'), 'beta keep local\n');
  await writeFile(path.join(wc, '한글 공백@파일.txt'), 'special changed\n');
  await mkdir(path.join(wc, '새 폴더@작업'));
  await writeFile(path.join(wc, '새 폴더@작업', '선택 @파일.txt'), 'selected new\n');
  await writeFile(path.join(wc, '새 폴더@작업', '선택 안함.txt'), 'never committed\n');
  const changes = await service.status(wc);
  assert.equal(changes.find(c => c.path === 'alpha.txt')?.status, 'modified');
  assert.match(await service.workingDiff(wc, '한글 공백@파일.txt'), /special changed/);
  const result = await service.commit(wc, ['alpha.txt', '한글 공백@파일.txt', '새 폴더@작업/선택 @파일.txt'], '[개발자] 선택 파일만');
  assert.equal(result.revision, 2);
  const remaining = await service.status(wc);
  assert.equal(remaining.find(c => c.path === 'beta.txt')?.status, 'modified');
  assert.equal(remaining.find(c => c.path === '새 폴더@작업/선택 안함.txt')?.status, 'unversioned');
  const page = await service.history(wc, { limit: 10 });
  assert.ok(page.entries[0].paths.some(p => p.path.endsWith('/선택 @파일.txt')));
  assert.ok(!page.entries[0].paths.some(p => p.path.endsWith('/선택 안함.txt') || p.path.endsWith('/beta.txt')));
  const { stdout } = await svn('status');
  assert.match(stdout, /beta.txt/);
});

test('new directory files are selectable and previews respect ignore patterns and binary data', async t => {
  const { wc, service, svn } = await fixture(t);
  await svn('propset', 'svn:global-ignores', '*.secret\nignore-*', '.');
  const folder = path.join(wc, 'new-folder');
  await mkdir(path.join(folder, 'nested'), { recursive: true });
  await mkdir(path.join(folder, 'node_modules'));
  await mkdir(path.join(folder, '.git'));
  await mkdir(path.join(folder, 'ignore-folder'));
  await writeFile(path.join(folder, 'nested', '한글 @파일.txt'), '새 파일 내용\n');
  await writeFile(path.join(folder, 'keep.secret'), 'ignored by inherited property\n');
  await writeFile(path.join(folder, 'node_modules', 'package.js'), 'ignored dependency');
  await writeFile(path.join(folder, '.git', 'config'), 'ignored git metadata');
  await writeFile(path.join(folder, 'ignore-folder', 'file.txt'), 'ignored directory');
  await writeFile(path.join(folder, 'binary.dat'), Buffer.from([0, 1, 2]));
  const status = await service.status(wc);
  const paths = status.filter(c => c.status === 'unversioned').map(c => c.path);
  assert.ok(paths.includes('new-folder/nested/한글 @파일.txt'));
  assert.ok(paths.includes('new-folder/binary.dat'));
  assert.ok(!paths.some(p => /keep.secret|node_modules|\.git|ignore-folder/.test(p)));
  assert.match(await service.workingDiff(wc, 'new-folder/nested/한글 @파일.txt'), /\+새 파일 내용/);
  assert.match(await service.workingDiff(wc, 'new-folder/binary.dat'), /바이너리/);
});

test('missing file commits deletion and deletion history still shows contents', async t => {
  const { wc, service } = await fixture(t);
  await rm(path.join(wc, '한글 공백@파일.txt'));
  assert.equal((await service.status(wc)).find(c => c.path === '한글 공백@파일.txt')?.status, 'missing');
  const result = await service.commit(wc, ['한글 공백@파일.txt'], '파일 삭제');
  assert.equal(result.revision, 2);
  const page = await service.history(wc, { limit: 5 });
  const deleted = page.entries[0].paths.find(p => p.action === 'D');
  assert.ok(deleted);
  const diff = await service.historicalDiff(wc, 2, deleted);
  assert.match(diff, /-special original/);
});

async function folderDeletionFixture(t: TestContext) {
  const fixtureData = await fixture(t);
  const folder = '삭제 폴더@예제';
  const absolute = path.join(fixtureData.wc, folder);
  await mkdir(path.join(absolute, 'nested', 'empty'), { recursive: true });
  await writeFile(path.join(absolute, 'first.txt'), 'first contents\n');
  await writeFile(path.join(absolute, 'nested', '한글 @파일.txt'), 'nested contents\n');
  await fixtureData.svn('add', `${folder}@`);
  await fixtureData.svn('commit', '-m', '예제 폴더 추가', '--username', 'demo');
  await fixtureData.svn('update');
  return { ...fixtureData, folder, absolute };
}

test('scheduled folder deletion previews all descendants without mutation and commits only selected deletion', async t => {
  const { wc, folder, absolute, service, svn } = await folderDeletionFixture(t);
  await svn('delete', `${folder}@`);
  await writeFile(path.join(wc, 'alpha.txt'), 'keep unrelated local change\n');
  const before = await svn('status');
  const preview = await service.deletionPreview(wc, folder);
  assert.equal(preview.path, folder);
  assert.deepEqual(preview.entries, [
    { path: `${folder}/first.txt`, kind: 'file' },
    { path: `${folder}/nested`, kind: 'dir' },
    { path: `${folder}/nested/empty`, kind: 'dir' },
    { path: `${folder}/nested/한글 @파일.txt`, kind: 'file' },
  ]);
  assert.equal((await svn('status')).stdout, before.stdout);
  const result = await service.commit(wc, [`${folder}/nested/한글 @파일.txt`, folder, `${folder}/nested`, folder], '선택 폴더 삭제');
  assert.equal(result.revision, 3);
  const remaining = await service.status(wc);
  assert.deepEqual(remaining.map(change => [change.path, change.status]), [['alpha.txt', 'modified']]);
  assert.equal(await readFile(path.join(wc, 'alpha.txt'), 'utf8'), 'keep unrelated local change\n');
  const latest = (await service.history(wc)).entries[0];
  assert.deepEqual(latest.paths.map(change => [change.path, change.action]), [[`/${folder}`, 'D']]);
  await assert.rejects(readFile(path.join(absolute, 'first.txt')));
});

test('filesystem-missing folder retains complete metadata preview and can commit recursive deletion', async t => {
  const { wc, folder, absolute, service, svn } = await folderDeletionFixture(t);
  await rm(absolute, { recursive: true });
  const before = await svn('status');
  const preview = await service.deletionPreview(wc, folder);
  assert.equal(preview.entries.length, 4);
  assert.ok(preview.entries.some(entry => entry.path.endsWith('/empty') && entry.kind === 'dir'));
  assert.ok(preview.entries.some(entry => entry.path.endsWith('/한글 @파일.txt') && entry.kind === 'file'));
  assert.equal((await svn('status')).stdout, before.stdout);
  assert.equal((await service.status(wc)).find(change => change.path === folder)?.status, 'missing');
  assert.equal((await service.commit(wc, [folder], '누락 폴더 삭제 반영')).revision, 3);
  assert.deepEqual(await service.status(wc), []);
});

test('folder deletion rejects existing folders and escaped or root targets before mutation', async t => {
  const { wc, folder, absolute, service, svn } = await folderDeletionFixture(t);
  await svn('propset', 'example:note', 'changed', `${folder}@`);
  const before = await svn('status');
  await assert.rejects(service.commit(wc, [folder], '기존 폴더 차단'), { code: 'INVALID_ARGUMENT' });
  for (const target of ['', '.', './', '../outside', '/tmp/outside', 'alpha.txt']) {
    await assert.rejects(service.deletionPreview(wc, target), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(service.commit(wc, ['./'], '루트 차단'), { code: 'INVALID_ARGUMENT' });
  assert.equal((await svn('status')).stdout, before.stdout);
  assert.equal(await readFile(path.join(absolute, 'first.txt'), 'utf8'), 'first contents\n');
});

for (const recreatedKind of ['file', 'dir'] as const) {
  test(`scheduled folder deletion rejects a recreated ${recreatedKind} without discarding it`, async t => {
    const { wc, folder, absolute, service, svn } = await folderDeletionFixture(t);
    await svn('delete', `${folder}@`);
    if (recreatedKind === 'dir') {
      await mkdir(absolute);
      await writeFile(path.join(absolute, 'keep.txt'), 'preserve new contents\n');
    } else await writeFile(absolute, 'preserve new contents\n');
    const before = await svn('status');
    await assert.rejects(service.commit(wc, [folder], '재생성 항목 차단'), { code: 'INVALID_ARGUMENT' });
    assert.equal(await readFile(recreatedKind === 'dir' ? path.join(absolute, 'keep.txt') : absolute, 'utf8'), 'preserve new contents\n');
    assert.equal((await svn('status')).stdout, before.stdout);
    assert.equal((await service.history(wc)).entries[0].revision, 2);
  });
}

for (const deletionState of ['deleted', 'missing'] as const) {
  test(`folder deletion refuses incomplete sparse previews for ${deletionState} folders`, async t => {
    const { wc, folder, absolute, service, svn } = await folderDeletionFixture(t);
    await svn('update', '--set-depth', 'exclude', `${folder}/nested@`);
    if (deletionState === 'deleted') await svn('delete', `${folder}@`);
    else await rm(absolute, { recursive: true });
    const before = await svn('status');
    await assert.rejects(service.deletionPreview(wc, folder), error => {
      assert.equal((error as { code: string }).code, 'INVALID_ARGUMENT');
      assert.match((error as Error).message, /일부만 체크아웃/);
      return true;
    });
    await assert.rejects(service.commit(wc, [folder], '불완전 범위 차단'), { code: 'INVALID_ARGUMENT' });
    assert.equal((await svn('status')).stdout, before.stdout);
    assert.equal((await service.history(wc)).entries[0].revision, 2);
  });
}

test('folder deletion refuses a switched descendant rather than guessing its deletion scope', async t => {
  const { wc, folder, absolute, service, svn } = await folderDeletionFixture(t);
  await svn('copy', `${folder}/nested@`, 'alternate');
  await svn('commit', 'alternate', '-m', '예제 경로 복사', '--username', 'demo');
  await svn('update');
  await svn('switch', '^/alternate', `${folder}/nested`);
  await rm(absolute, { recursive: true });
  const before = await svn('status');
  await assert.rejects(service.deletionPreview(wc, folder), error => {
    assert.equal((error as { code: string }).code, 'INVALID_ARGUMENT');
    assert.match((error as Error).message, /전환된 SVN/);
    return true;
  });
  await assert.rejects(service.commit(wc, [folder], '전환 경로 차단'), { code: 'INVALID_ARGUMENT' });
  assert.equal((await svn('status')).stdout, before.stdout);
  assert.equal((await service.history(wc)).entries[0].revision, 3);
});

test('new and copied paths have revision-specific historical diffs', async t => {
  const { wc, service, svn } = await fixture(t);
  await writeFile(path.join(wc, 'added.txt'), 'brand new line\n');
  await svn('add', 'added.txt');
  await svn('copy', 'alpha.txt', 'copy.txt');
  await writeFile(path.join(wc, 'copy.txt'), 'copied then changed\n');
  await svn('commit', '-m', '추가와 복사');
  const page = await service.history(wc, { limit: 5 });
  const added = page.entries[0].paths.find(p => p.path === '/added.txt');
  const copied = page.entries[0].paths.find(p => p.path === '/copy.txt');
  assert.ok(added);
  assert.ok(copied);
  assert.equal(copied.copyFromPath, '/alpha.txt');
  assert.match(await service.historicalDiff(wc, 2, added), /\+brand new line/);
  assert.match(await service.historicalDiff(wc, 2, copied), /\+copied then changed/);
});

test('update receives peer commits, conflicts are retained until explicit resolution', async t => {
  const { wc, peer, service, other } = await fixture(t);
  await writeFile(path.join(peer, 'beta.txt'), 'peer beta update\n');
  await other('commit', 'beta.txt', '-m', '동료 수정');
  const updated = await service.update(wc);
  assert.equal(updated.revision, 2);
  assert.equal(await readFile(path.join(wc, 'beta.txt'), 'utf8'), 'peer beta update\n');
  await writeFile(path.join(wc, 'alpha.txt'), 'local alpha\n');
  await writeFile(path.join(peer, 'alpha.txt'), 'remote alpha\n');
  await other('commit', 'alpha.txt', '-m', '충돌 발생');
  await service.update(wc);
  assert.equal((await service.status(wc)).find(c => c.path === 'alpha.txt')?.status, 'conflicted');
  await writeFile(path.join(wc, 'alpha.txt'), 'resolved by user\n');
  await service.resolve(wc, 'alpha.txt');
  assert.equal((await service.status(wc)).find(c => c.path === 'alpha.txt')?.status, 'modified');
  assert.equal(await readFile(path.join(wc, 'alpha.txt'), 'utf8'), 'resolved by user\n');
});

test('checkout rejects nonempty destination without modifying it; file paths cannot escape working copy', async t => {
  const { root, wc, url, service } = await fixture(t);
  const occupied = path.join(root, 'occupied');
  await mkdir(occupied);
  await writeFile(path.join(occupied, 'keep.txt'), 'preserve me\n');
  await assert.rejects(service.checkout({ url, destination: occupied }), { code: 'INVALID_ARGUMENT' });
  assert.equal(await readFile(path.join(occupied, 'keep.txt'), 'utf8'), 'preserve me\n');
  await assert.rejects(service.workingDiff(wc, '../outside.txt'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(service.commit(wc, ['../outside.txt'], 'escape'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(service.resolve(wc, '../outside.txt'), { code: 'INVALID_ARGUMENT' });
  await symlink(occupied, path.join(wc, 'external'));
  await assert.rejects(service.workingDiff(wc, 'external/keep.txt'), { code: 'INVALID_ARGUMENT' });
});

test('a running mutation locks other mutations and cancellation releases the lock', async t => {
  const { root, wc } = await fixture(t);
  const fake = path.join(root, 'slow-svn');
  const started = path.join(root, 'started');
  await writeFile(fake, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(started)}, 'started');\nsetInterval(() => {}, 1000);\n`);
  await chmod(fake, 0o755);
  const service = new SvnService({ binaryPath: fake });
  const running = service.update(wc);
  const rejection = assert.rejects(running, { code: 'CANCELLED' });
  for (let i = 0; i < 100; i++) {
    try { await readFile(started); break; } catch { await new Promise(r => setTimeout(r, 10)); }
  }
  assert.equal(await readFile(started, 'utf8'), 'started');
  await assert.rejects(service.update(wc), { code: 'BUSY' });
  service.cancel();
  await rejection;
  const real = new SvnService({ binaryPath: binary });
  assert.equal((await real.update(wc)).revision, 1);
});

test('credentials use stdin and are removed from diagnostic errors', async t => {
  const { root } = await fixture(t);
  const fake = path.join(root, 'credential-svn');
  const captured = path.join(root, 'args.json');
  await writeFile(fake, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv));\nlet input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { process.stderr.write('E170001 Authentication failed: ' + input); process.exit(1); });\n`);
  await chmod(fake, 0o755);
  const service = new SvnService({ binaryPath: fake });
  const secret = 'random-fixture-secret-only';
  await assert.rejects(service.info('svn://127.0.0.1/example', { username: 'demo', password: secret }), error => {
    const e = error as Error & { code: string; detail: string };
    assert.equal(e.code, 'AUTH_REQUIRED');
    assert.ok(!JSON.stringify(e).includes(secret));
    assert.match(e.detail, /비밀번호 숨김/);
    return true;
  });
  const args = JSON.parse(await readFile(captured, 'utf8')) as string[];
  assert.ok(args.includes('--password-from-stdin'));
  assert.ok(!args.some(arg => arg.includes(secret)));
});

test('svnserve authentication prompts then retries with credentials', async t => {
  const { root, repo } = await fixture(t);
  await writeFile(path.join(repo, 'conf', 'svnserve.conf'), '[general]\nanon-access = none\nauth-access = write\npassword-db = passwd\nrealm = SVN Workspace test\n');
  await writeFile(path.join(repo, 'conf', 'passwd'), '[users]\ndemo = fixture-password\n');
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const server = spawn(path.join(path.dirname(admin), 'svnserve'), ['--daemon', '--foreground', '--root', root, '--listen-host', '127.0.0.1', '--listen-port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let serverError = '';
  server.stderr.on('data', chunk => serverError += String(chunk));
  t.after(async () => { if (server.exitCode === null && server.signalCode === null) { server.kill(); await once(server, 'exit'); } });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await new Promise<boolean>(resolve => { const socket = createConnection({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    if (ready) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(ready, `svnserve did not start: ${serverError}`);
  const service = new SvnService({ binaryPath: binary });
  const url = `svn://127.0.0.1:${port}/repository`;
  await assert.rejects(service.info(url), { code: 'AUTH_REQUIRED' });
  const info = await service.info(url, { username: 'demo', password: 'fixture-password' });
  assert.equal(info.revision, 1);
  const destination = path.join(root, 'authenticated');
  await assert.rejects(service.checkout({ url, destination }), { code: 'AUTH_REQUIRED' });
  assert.equal((await service.checkout({ url, destination }, { username: 'demo', password: 'fixture-password' })).revision, 1);
  await writeFile(path.join(destination, 'alpha.txt'), 'authenticated commit\n');
  await assert.rejects(service.commit(destination, ['alpha.txt'], '인증 재시도'), { code: 'AUTH_REQUIRED' });
  assert.equal((await service.commit(destination, ['alpha.txt'], '인증 재시도', { username: 'demo', password: 'fixture-password' })).revision, 2);
  await assert.rejects(service.update(destination), { code: 'AUTH_REQUIRED' });
  assert.equal((await service.update(destination, { username: 'demo', password: 'fixture-password' })).revision, 2);
});
