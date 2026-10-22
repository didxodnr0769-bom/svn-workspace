import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore, CredentialStore } from '../src/main/storage';
import type { WorkingCopyInfo } from '../src/shared/types';

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svn-workspace-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function encryption(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text: string) => Buffer.from(Buffer.from(text).map(byte => byte ^ 0xa7)),
    decryptString: (bytes: Buffer) => Buffer.from(bytes.map(byte => byte ^ 0xa7)).toString('utf8'),
  };
}
const info = (directory: string): WorkingCopyInfo => ({ path: directory, url: 'https://example.test/svn/project', repositoryRoot: 'https://example.test/svn', relativeUrl: '^/project', uuid: 'fixture-uuid', revision: 7 });

test('settings reload restores projects, selected project, SVN binary and canonical-path deduplication', async t => {
  const root = await temporary(t);
  const settings = path.join(root, 'settings');
  const a = path.join(root, '작업 A');
  const b = path.join(root, '작업 B');
  await mkdir(a);
  await mkdir(b);
  const store = new SettingsStore(settings);
  await store.load();
  assert.deepEqual(store.snapshot().projects, []);
  const first = await store.add(info(a), '프로젝트 A');
  const second = await store.add(info(b), '프로젝트 B');
  const alias = path.join(root, 'alias');
  await symlink(a, alias);
  const again = await store.add({ ...info(alias), revision: 8 });
  assert.equal(again.id, first.id);
  assert.equal(again.name, '프로젝트 A');
  assert.equal(again.path, await realpath(a));
  assert.equal(store.snapshot().projects.length, 2);
  await store.select(second.id);
  await store.setSvnPath('/opt/homebrew/bin/svn');
  const restarted = new SettingsStore(settings);
  await restarted.load();
  assert.equal(restarted.snapshot().activeProjectId, second.id);
  assert.equal(restarted.snapshot().svnPath, '/opt/homebrew/bin/svn');
  assert.equal(restarted.snapshot().projects.find(p => p.id === first.id)?.revision, 8);
  const snapshot = restarted.snapshot();
  snapshot.projects.length = 0;
  assert.equal(restarted.snapshot().projects.length, 2);
});

test('invalid saved selection falls back to a valid project and malformed JSON starts empty', async t => {
  const root = await temporary(t);
  const wc = path.join(root, 'wc');
  await mkdir(wc);
  const store = new SettingsStore(root);
  const project = await store.add(info(wc));
  const saved = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
  saved.activeProjectId = 'missing';
  saved.projects.push({ id: 'bad', path: '../outside', name: 'bad', url: 'file:///tmp' });
  await writeFile(path.join(root, 'settings.json'), JSON.stringify(saved));
  const restarted = new SettingsStore(root);
  await restarted.load();
  assert.equal(restarted.snapshot().activeProjectId, project.id);
  assert.equal(restarted.snapshot().projects.length, 1);
  await writeFile(path.join(root, 'settings.json'), '{broken JSON');
  const recovered = new SettingsStore(root);
  await recovered.load();
  assert.deepEqual(recovered.snapshot().projects, []);
});

test('remembered credentials persist as ciphertext and decrypt in a new store instance', async t => {
  const root = await temporary(t);
  const secret = 'fixture-only-password-한글';
  const target = 'https://example.test/svn/project';
  const store = new CredentialStore(root, encryption());
  await store.load();
  await store.set(target, { username: 'demo', password: secret, remember: true });
  const file = path.join(root, 'credentials.json');
  const contents = await readFile(file, 'utf8');
  assert.ok(!contents.includes(secret));
  assert.ok(!contents.includes(target));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const restarted = new CredentialStore(root, encryption());
  await restarted.load();
  assert.deepEqual(restarted.get(target + '/'), { username: 'demo', password: secret, remember: true });
  const copy = restarted.get(target)!;
  copy.password = 'mutated outside';
  assert.equal(restarted.get(target)?.password, secret);
});

test('session-only credentials remove previous persistence and disappear after restart', async t => {
  const root = await temporary(t);
  const target = 'svn://example.test/repo';
  const store = new CredentialStore(root, encryption());
  await store.set(target, { username: 'demo', password: 'saved-before', remember: true });
  await store.set(target, { username: 'demo', password: 'session-only', remember: false });
  assert.equal(store.get(target)?.password, 'session-only');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'credentials.json'), 'utf8')), {});
  const restarted = new CredentialStore(root, encryption());
  await restarted.load();
  assert.equal(restarted.get(target), undefined);
  store.forgetSession(target);
  assert.equal(store.get(target), undefined);
});

test('unavailable encryption rejects persistence while retaining credentials only for this session', async t => {
  const root = await temporary(t);
  const store = new CredentialStore(root, encryption(false));
  const target = 'svn://example.test/repo';
  assert.equal(store.available(), false);
  await assert.rejects(store.set(target, { username: 'demo', password: 'ephemeral', remember: true }), /암호화/);
  assert.equal(store.get(target)?.password, 'ephemeral');
  const restarted = new CredentialStore(root, encryption(false));
  await restarted.load();
  assert.equal(restarted.get(target), undefined);
});

test('project alias persists independently of folders, SVN identity and project selection', async t => {
  const root = await temporary(t);
  const a = path.join(root, 'a', 'trunk'); const b = path.join(root, 'b', 'trunk');
  await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
  await writeFile(path.join(a, 'unchanged.txt'), 'keep exactly');
  const settings = path.join(root, 'app-settings'); const store = new SettingsStore(settings);
  const first = await store.add(info(a)); const second = await store.add(info(b));
  const renamed = await store.rename(first.id, '  예제 프로젝트 · 운영  ');
  assert.deepEqual(renamed, { ...first, name: '예제 프로젝트 · 운영' });
  assert.equal(store.snapshot().activeProjectId, second.id);
  assert.equal(await readFile(path.join(a, 'unchanged.txt'), 'utf8'), 'keep exactly');
  assert.ok((await stat(a)).isDirectory());
  const restarted = new SettingsStore(settings); await restarted.load();
  assert.deepEqual(restarted.snapshot().projects.find(p => p.id === first.id), renamed);
  assert.equal((await restarted.add(info(a))).name, renamed.name);
  assert.equal((await restarted.rename(first.id, path.basename(a))).name, 'trunk');
  await assert.rejects(restarted.rename(first.id, '   '));
  await assert.rejects(restarted.rename(first.id, 'a\nb'));
  await assert.rejects(restarted.rename('unknown', 'alias'));
  assert.equal(restarted.snapshot().projects.find(p => p.id === second.id)?.name, 'trunk');
});

test('removing a saved project preserves existing folders, selection and unrelated settings', async t => {
  const root = await temporary(t);
  const a = path.join(root, 'project-a'); const b = path.join(root, 'project-b');
  await mkdir(a); await mkdir(b);
  await writeFile(path.join(a, 'keep.txt'), 'project A stays');
  await writeFile(path.join(b, 'keep.txt'), 'project B stays');
  const settings = path.join(root, 'settings'); const store = new SettingsStore(settings);
  const first = await store.add(info(a)); const second = await store.add(info(b));
  await store.setSvnPath('/mock/bin/svn');
  const accounts = new CredentialStore(settings, encryption());
  await accounts.set(info(a).url, { username: 'demo', password: 'fixture-only-password', remember: true });
  const credentialFile = path.join(settings, 'credentials.json');
  const credentialsBefore = await readFile(credentialFile, 'utf8');

  await store.remove(first.id);
  assert.deepEqual(store.snapshot().projects, [second]);
  assert.equal(store.snapshot().activeProjectId, second.id);
  assert.equal(store.snapshot().svnPath, '/mock/bin/svn');
  assert.equal(await readFile(path.join(a, 'keep.txt'), 'utf8'), 'project A stays');
  assert.equal(await readFile(path.join(b, 'keep.txt'), 'utf8'), 'project B stays');
  assert.equal(await readFile(credentialFile, 'utf8'), credentialsBefore);
  const restarted = new SettingsStore(settings); await restarted.load();
  assert.deepEqual(restarted.snapshot(), store.snapshot());

  await restarted.remove(second.id);
  assert.deepEqual(restarted.snapshot().projects, []);
  assert.equal(restarted.snapshot().activeProjectId, null);
  assert.equal(restarted.snapshot().svnPath, '/mock/bin/svn');
  assert.equal(await readFile(path.join(b, 'keep.txt'), 'utf8'), 'project B stays');
  assert.equal(await readFile(credentialFile, 'utf8'), credentialsBefore);
  const empty = new SettingsStore(settings); await empty.load();
  assert.deepEqual(empty.snapshot(), restarted.snapshot());
});

test('removing an active project works after its directory is gone and unknown ids leave settings unchanged', async t => {
  const root = await temporary(t);
  const a = path.join(root, 'remaining'); const b = path.join(root, 'removed-on-disk');
  await mkdir(a); await mkdir(b);
  await writeFile(path.join(a, 'keep.txt'), 'unchanged');
  const settings = path.join(root, 'settings'); const store = new SettingsStore(settings);
  await store.load();
  const first = await store.add(info(a)); const second = await store.add(info(b));
  await rm(b, { recursive: true });

  await store.remove(second.id);
  assert.deepEqual(store.snapshot().projects, [first]);
  assert.equal(store.snapshot().activeProjectId, first.id);
  assert.equal(await readFile(path.join(a, 'keep.txt'), 'utf8'), 'unchanged');
  const restarted = new SettingsStore(settings); await restarted.load();
  assert.deepEqual(restarted.snapshot(), store.snapshot());
  const before = restarted.snapshot();
  const savedBefore = await readFile(path.join(settings, 'settings.json'), 'utf8');
  await assert.rejects(restarted.remove('unknown'), /등록된 프로젝트/);
  await assert.rejects(restarted.remove(second.id), /등록된 프로젝트/);
  assert.deepEqual(restarted.snapshot(), before);
  assert.equal(await readFile(path.join(settings, 'settings.json'), 'utf8'), savedBefore);
});
