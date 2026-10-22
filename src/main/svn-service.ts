import { spawn, type ChildProcess } from 'node:child_process';
import { access, lstat, readdir, realpath, stat, readFile, readlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { XMLParser } from 'fast-xml-parser';
import type { CommittedPath, Credentials, DeletionPreview, ErrorCode, HistoryEntry, HistoryPage, MutationResult, OperationProgress, WorkingChange, WorkingCopyInfo, WorkingStatus } from '../shared/types';

export class SvnServiceError extends Error {
  constructor(public code: ErrorCode, message: string, public detail?: string, public authTarget?: string) { super(message); this.name = 'SvnServiceError'; }
}
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, trimValues: false });
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const value = (v: unknown): string => v === undefined || v === null ? '' : typeof v === 'object' ? String((v as Record<string, unknown>)['#text'] ?? '') : String(v);
const invalid = (message: string): never => { throw new SvnServiceError('INVALID_ARGUMENT', message); };
const peg = (p: string) => `${p}@`;
let mutationActive = false;
const outputLimit = 24 * 1024 * 1024;

export async function discoverSvn(preferred?: string): Promise<{ path: string; version: string }> {
  const candidates = preferred ? [preferred] : ['/opt/homebrew/bin/svn', '/usr/local/bin/svn', '/usr/bin/svn', ...String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(p => path.join(p, 'svn'))];
  for (const binary of [...new Set(candidates)]) {
    if (!path.isAbsolute(binary)) continue;
    try {
      await access(binary, constants.X_OK);
      const version = await new Promise<string>((resolve, reject) => {
        const child = spawn(binary, ['--version', '--quiet'], { shell: false, env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 5000);
        child.stdout.on('data', chunk => { out += String(chunk); if (out.length > 4096) child.kill(); });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); code === 0 && /^\d+\.\d+/.test(out.trim()) ? resolve(out.trim()) : reject(new Error('invalid executable')); });
      });
      return { path: binary, version };
    } catch { /* Try the next executable. */ }
  }
  throw new SvnServiceError('SVN_NOT_FOUND', 'SVN 실행 파일을 찾을 수 없습니다. 설치된 svn 실행 파일을 선택해 주세요.');
}

export class SvnService {
  private children = new Set<ChildProcess>();
  private cancelled = new WeakSet<ChildProcess>();
  private activeMutation = false;
  private mutationCancelled = false;
  constructor(private options: { binaryPath: string; onProgress?: (progress: OperationProgress) => void }) {}

  cancel(): void { if (this.activeMutation) this.mutationCancelled = true; for (const child of this.children) { this.cancelled.add(child); child.kill('SIGTERM'); const timer = setTimeout(() => { if (this.children.has(child)) child.kill('SIGKILL'); }, 2000); timer.unref(); } }

  private async run(args: string[], credentials?: Credentials, operation?: OperationProgress['operation'], target?: string): Promise<string> {
    if (this.activeMutation && this.mutationCancelled) throw new SvnServiceError('CANCELLED', '작업을 취소했습니다. 현재 작업 폴더 상태를 확인해 주세요.');
    if (credentials && (!credentials.username || /[\r\n\0]/.test(credentials.username + credentials.password))) invalid('계정 정보에 줄바꿈이나 잘못된 문자를 사용할 수 없습니다.');
    const auth = credentials ? ['--username', credentials.username, '--password-from-stdin'] : [];
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.binaryPath, [...args, '--non-interactive', '--no-auth-cache', ...auth], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' } });
      this.children.add(child);
      let stdout = '', stderr = '', bytes = 0, exceeded = false;
      const clean = (text: string) => credentials?.password ? text.split(credentials.password).join('[비밀번호 숨김]') : text;
      const read = (chunk: Buffer, error: boolean) => {
        bytes += chunk.length;
        if (bytes > outputLimit) { exceeded = true; child.kill(); return; }
        const text = chunk.toString('utf8');
        if (error) stderr += text; else stdout += text;
        if (operation) for (const line of clean(text).split(/\r?\n/).filter(Boolean)) this.options.onProgress?.({ operation, message: line.slice(0, 1000) });
      };
      // Decode streams incrementally so multibyte filenames survive chunk boundaries.
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => read(Buffer.from(chunk), false)); child.stderr.on('data', chunk => read(Buffer.from(chunk), true));
      child.stdin.on('error', () => {});
      child.stdin.end(credentials ? `${credentials.password}\n` : '');
      child.on('error', error => { this.children.delete(child); reject(new SvnServiceError('IO_ERROR', 'SVN을 실행하지 못했습니다.', clean(error.message))); });
      child.on('close', code => {
        this.children.delete(child);
        if (this.cancelled.has(child)) return reject(new SvnServiceError('CANCELLED', '작업을 취소했습니다. 현재 작업 폴더 상태를 확인해 주세요.'));
        if (exceeded) return reject(new SvnServiceError('SVN_ERROR', '결과가 너무 큽니다. 조회 범위나 파일 크기를 줄여 주세요.'));
        if (code === 0) return resolve(stdout);
        const detail = clean(stderr || stdout).slice(0, 8000);
        if (/E230001|certificate verification failed|Server certificate verification failed/i.test(detail)) return reject(new SvnServiceError('CERTIFICATE', '저장소 인증서를 확인할 수 없습니다. SVN 인증서 설정을 확인해 주세요.', detail, target));
        if (/E170001|E215004|E220003|Authentication failed|authorization failed|No more credentials|could not authenticate|Can't get password/i.test(detail)) return reject(new SvnServiceError('AUTH_REQUIRED', '저장소 계정 인증이 필요합니다.', detail, target));
        reject(new SvnServiceError('SVN_ERROR', 'SVN 작업을 완료하지 못했습니다.', detail));
      });
    });
  }

  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    if (mutationActive) throw new SvnServiceError('BUSY', '다른 SVN 작업이 진행 중입니다. 완료한 뒤 다시 시도해 주세요.');
    mutationActive = true;
    this.activeMutation = true; this.mutationCancelled = false;
    try { return await action(); } finally { mutationActive = false; this.activeMutation = false; }
  }

  private checkUrl(url: string): void {
    if (!/^(https?|svn|svn\+ssh|file):\/\//i.test(url) || /[\r\n\0]/.test(url)) invalid('올바른 SVN 저장소 URL을 입력해 주세요.');
    try { const parsed = new URL(url); if (parsed.password || parsed.username) invalid('URL에 계정 정보를 넣지 말고 로그인 창을 이용해 주세요.'); } catch (error) { if (error instanceof SvnServiceError) throw error; invalid('올바른 SVN 저장소 URL을 입력해 주세요.'); }
  }

  private async local(root: string, relative = ''): Promise<string> {
    if (!path.isAbsolute(root) || /\0/.test(root + relative)) invalid('올바른 작업 폴더 경로가 필요합니다.');
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..' || p.toLowerCase() === '.svn')) invalid('작업 폴더 내부 파일만 선택할 수 있습니다.');
    const base = await realpath(root);
    const full = path.resolve(base, relative);
    if (full !== base && !full.startsWith(base + path.sep)) invalid('작업 폴더 외부 경로를 사용할 수 없습니다.');
    // Check parents, while allowing a versioned symlink itself to be operated on as a file.
    let ancestor = relative ? path.dirname(full) : full;
    while (true) {
      try { const real = await realpath(ancestor); if (real !== base && !real.startsWith(base + path.sep)) invalid('작업 폴더 외부를 가리키는 경로를 사용할 수 없습니다.'); break; }
      catch (error) { if (error instanceof SvnServiceError) throw error; const parent = path.dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; }
    }
    return full;
  }

  async info(target: string, credentials?: Credentials): Promise<WorkingCopyInfo> {
    const remote = /^[a-z][a-z+.-]*:\/\//i.test(target);
    if (remote) this.checkUrl(target); else target = await this.local(target);
    const document = xml.parse(await this.run(['info', '--xml', peg(target)], credentials, undefined, target));
    const entry = array<Record<string, any>>(document.info?.entry)[0];
    if (!entry) throw new SvnServiceError('SVN_ERROR', 'SVN 작업 폴더 정보를 읽을 수 없습니다.');
    return { path: remote ? '' : target, url: value(entry.url), repositoryRoot: value(entry.repository?.root), relativeUrl: value(entry['relative-url']), uuid: value(entry.repository?.uuid), revision: Number(entry.revision) };
  }

  async checkout(input: { url: string; destination: string }, credentials?: Credentials): Promise<MutationResult> {
    this.checkUrl(input.url);
    if (!path.isAbsolute(input.destination) || /[\0\r\n]/.test(input.destination)) invalid('체크아웃할 절대 경로를 선택해 주세요.');
    return this.mutate(async () => {
      try { if (!(await stat(input.destination)).isDirectory() || (await readdir(input.destination)).length) invalid('체크아웃 대상은 비어 있는 폴더여야 합니다.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return this.result(await this.run(['checkout', peg(input.url), input.destination], credentials, 'checkout', input.url));
    });
  }

  async history(root: string, options?: { limit?: number; beforeRevision?: number }, credentials?: Credentials): Promise<HistoryPage> {
    const local = await this.local(root);
    const limit = Math.max(1, Math.min(100, Math.floor(options?.limit ?? 50)));
    const before = options?.beforeRevision;
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) return { entries: [], hasMore: false };
    const args = ['log', '--xml', '--verbose', '--limit', String(limit + 1), '-r', `${before === undefined ? 'HEAD' : before - 1}:0`, peg(local)];
    const doc = xml.parse(await this.run(args, credentials, undefined, local));
    const entries: HistoryEntry[] = array<Record<string, any>>(doc.log?.logentry).map(entry => ({
      revision: Number(entry.revision), author: value(entry.author), date: value(entry.date), message: value(entry.msg),
      paths: array<Record<string, any>>(entry.paths?.path).map(p => ({ path: value(p), action: p.action as CommittedPath['action'], kind: p.kind === 'file' || p.kind === 'dir' ? p.kind : 'unknown', ...(p['copyfrom-path'] ? { copyFromPath: value(p['copyfrom-path']), copyFromRevision: Number(p['copyfrom-rev']) } : {}) })),
    }));
    return { entries: entries.slice(0, limit), hasMore: entries.length > limit };
  }

  async historicalDiff(root: string, revision: number, change: CommittedPath, credentials?: Credentials): Promise<string> {
    if (!Number.isSafeInteger(revision) || revision < 1 || !change.path.startsWith('/') || change.path.split('/').includes('..')) invalid('올바른 커밋과 파일을 선택해 주세요.');
    const info = await this.info(root, credentials);
    const url = info.repositoryRoot.replace(/\/$/, '') + change.path.split('/').map(encodeURIComponent).join('/');
    const at = change.action === 'D' ? revision - 1 : revision;
    return this.run(['diff', '--notice-ancestry', '-c', String(revision), `${url}@${at}`], credentials, undefined, info.url);
  }

  async status(root: string): Promise<WorkingChange[]> {
    const local = await this.local(root);
    const doc = xml.parse(await this.run(['status', '--xml', '--depth', 'infinity', peg(local)]));
    const entries = array<Record<string, any>>(doc.status?.target).flatMap(t => array<Record<string, any>>(t.entry));
    const accepted = new Set(['modified', 'added', 'deleted', 'missing', 'unversioned', 'conflicted', 'replaced', 'normal', 'obstructed', 'incomplete']);
    const changes: WorkingChange[] = [];
    for (const entry of entries) {
      const wc = entry['wc-status'];
      if (!wc || !accepted.has(wc.item) || (wc.item === 'normal' && wc.props !== 'modified' && wc['tree-conflicted'] !== 'true')) continue;
      const full = path.isAbsolute(entry.path) ? entry.path : path.resolve(local, entry.path);
      let kind: WorkingChange['kind'] = 'unknown';
      if (wc.item === 'deleted' || wc.item === 'missing') {
        // The filesystem may already be gone or contain a newly recreated item of a different kind.
        try { const details = xml.parse(await this.run(['info', '--xml', peg(full)])); const item = array<Record<string, any>>(details.info?.entry)[0]; kind = item?.kind === 'dir' ? 'dir' : item?.kind === 'file' ? 'file' : 'unknown'; }
        catch (error) { if (error instanceof SvnServiceError && error.code === 'CANCELLED') throw error; }
      } else {
        try { kind = (await lstat(full)).isDirectory() ? 'dir' : 'file'; } catch { /* Unknown paths are not selectable. */ }
      }
      if (wc.item === 'unversioned' && kind === 'dir') {
        if (!['.svn', '.git', 'node_modules'].includes(path.basename(full))) changes.push(...await this.unversionedFiles(local, full));
      }
      else changes.push({ path: path.relative(local, full), status: (wc['tree-conflicted'] === 'true' ? 'conflicted' : wc.item) as WorkingStatus, props: wc.props ?? 'none', treeConflict: wc['tree-conflicted'] === 'true', kind });
    }
    return changes;
  }

  async deletionPreview(root: string, relativePath: string): Promise<DeletionPreview> {
    const local = await this.local(root);
    const full = await this.local(local, relativePath);
    if (full === local) invalid('프로젝트 전체 대신 삭제된 하위 폴더를 선택해 주세요.');
    return this.folderDeletionPreview(local, path.relative(local, full), await this.status(local));
  }

  private async folderDeletionPreview(local: string, relativePath: string, changes: WorkingChange[]): Promise<DeletionPreview> {
    const change = changes.find(item => item.path === relativePath);
    if (!change || change.kind !== 'dir' || !['deleted', 'missing'].includes(change.status) || change.treeConflict) invalid('삭제되거나 누락된 폴더를 선택해 주세요.');
    const full = await this.local(local, relativePath);
    await this.ensureDeletionAbsent(full);
    // Read the local WC database, not the removed filesystem or the repository's latest tree.
    const doc = xml.parse(await this.run(['info', '--xml', '--depth', 'infinity', peg(full)]));
    const metadata = array<Record<string, any>>(doc.info?.entry);
    const selected = metadata.find(item => path.resolve(item.path ?? '') === full) ?? invalid('삭제할 폴더의 SVN 정보를 확인할 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.');
    if (selected.kind !== 'dir') invalid('삭제할 폴더의 SVN 정보를 확인할 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.');
    const project = await this.info(local);
    const expectedRootUrl = project.url.replace(/\/$/, '') + '/' + relativePath.split(path.sep).map(encodeURIComponent).join('/');
    if (decodeURIComponent(value(selected.url)) !== decodeURIComponent(expectedRootUrl)) invalid('전환된 SVN 폴더는 삭제 범위를 확인할 수 없습니다. 별도 SVN 도구에서 처리해 주세요.');
    const entries: DeletionPreview['entries'] = [];
    const seen = new Set<string>();
    for (const item of metadata) {
      const entryPath = path.resolve(item.path ?? '');
      if (entryPath !== full && !entryPath.startsWith(full + path.sep)) invalid('삭제 범위를 벗어나는 SVN 경로가 있습니다.');
      const entryRelative = path.relative(local, entryPath);
      if (await this.local(local, entryRelative) !== entryPath || seen.has(entryPath)) invalid('삭제할 SVN 경로가 올바르지 않습니다.');
      seen.add(entryPath);
      if (!['file', 'dir'].includes(item.kind)) invalid('삭제할 항목의 종류를 확인할 수 없습니다.');
      const expectedUrl = value(selected.url).replace(/\/$/, '') + (entryPath === full ? '' : '/' + path.relative(full, entryPath).split(path.sep).map(encodeURIComponent).join('/'));
      if (value(item.repository?.uuid) !== project.uuid || value(item.repository?.root) !== project.repositoryRoot || decodeURIComponent(value(item.url)) !== decodeURIComponent(expectedUrl)) invalid('전환된 SVN 경로가 있어 삭제 범위를 확인할 수 없습니다. 별도 SVN 도구에서 처리해 주세요.');
      if (item.kind === 'dir' && value(item['wc-info']?.depth) !== 'infinity') invalid('일부만 체크아웃된 폴더는 전체 삭제 범위를 확인할 수 없습니다. 별도 SVN 도구에서 처리해 주세요.');
      if (item['tree-conflict'] || item['wc-info']?.['tree-conflict']) invalid('트리 충돌을 해결한 후 폴더 삭제를 커밋해 주세요.');
      if (entryPath !== full) entries.push({ path: entryRelative, kind: item.kind });
    }
    entries.sort((a, b) => {
      const left = a.path.split(path.sep), right = b.path.split(path.sep);
      for (let i = 0; i < Math.min(left.length, right.length); i++) {
        if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
      }
      return left.length - right.length;
    });
    return { path: relativePath, entries };
  }

  private async ensureDeletionAbsent(full: string): Promise<void> {
    try { await lstat(full); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    invalid('삭제된 폴더 위치에 파일이나 폴더가 다시 생겼습니다. 새로고침 후 내용을 확인해 주세요.');
  }

  async workingDiff(root: string, relativePath: string): Promise<string> {
    const full = await this.local(root, relativePath);
    const change = (await this.status(root)).find(c => c.path === relativePath);
    if (change?.status === 'unversioned') {
      const stats = await lstat(full);
      if (stats.isDirectory()) return '폴더 안의 파일을 선택해 주세요.';
      if (stats.size > 1024 * 1024) return '1 MB보다 큰 새 파일은 미리보기를 제공하지 않습니다.';
      const data = stats.isSymbolicLink() ? Buffer.from(`link ${await readlink(full)}`) : await readFile(full);
      if (data.includes(0)) return '새 바이너리 파일입니다. 텍스트 비교를 제공하지 않습니다.';
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return 'UTF-8 텍스트가 아닌 새 파일입니다. 텍스트 비교를 제공하지 않습니다.'; }
      const lines = text.replace(/\n$/, '').split('\n');
      return `Index: ${relativePath}\n===================================================================\n--- /dev/null\n+++ ${relativePath}\t(새 파일)\n@@ -0,0 +1,${text ? lines.length : 0} @@\n${text ? lines.map(line => `+${line}`).join('\n') : ''}\n`;
    }
    // svn diff's local BASE form treats targets literally, unlike log/info.
    return this.run(['diff', '-r', 'BASE', full]);
  }

  private async unversionedFiles(root: string, directory: string): Promise<WorkingChange[]> {
    const defaults = '*.o *.lo *.la *.al .libs *.so *.so.[0-9]* *.a *.pyc *.pyo *.rej *~ #*# .#* .*.swp .DS_Store';
    let globalPatterns = defaults;
    try { const config = await readFile(path.join(os.homedir(), '.subversion', 'config'), 'utf8'); const section = config.match(/^\[miscellany\]([^]*?)(?=^\[|$(?![^]))/m)?.[1] ?? ''; globalPatterns = section.match(/^\s*global-ignores\s*=\s*(.*)$/m)?.[1] ?? defaults; } catch { /* SVN default configuration. */ }
    const properties = xml.parse(await this.run(['propget', '--xml', '--show-inherited-props', 'svn:global-ignores', peg(path.dirname(directory))]));
    const collectProperties = (node: unknown): string[] => {
      if (!node || typeof node !== 'object') return [];
      return Object.entries(node).flatMap(([key, content]) => key === 'property' || key === 'inherited_property' ? array(content).map(value) : collectProperties(content));
    };
    const inherited = collectProperties(properties).join('\n');
    const patterns = `${globalPatterns}\n${inherited}`.split(/\s+/).filter(Boolean).map(pattern => {
      let expression = '';
      for (let i = 0; i < pattern.length; i++) { const c = pattern[i]; if (c === '*') expression += '.*'; else if (c === '?') expression += '.'; else if (c === '[' && pattern.indexOf(']', i + 1) > i) { const end = pattern.indexOf(']', i + 1); expression += pattern.slice(i, end + 1); i = end; } else expression += c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'); }
      try { return new RegExp(`^${expression}$`); } catch { return /^$/; }
    });
    const files: WorkingChange[] = [];
    const excluded = new Set(['.svn', '.git', 'node_modules']);
    let visited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 20) throw new SvnServiceError('SVN_ERROR', '새 폴더의 깊이가 너무 큽니다. SVN ignore 설정으로 범위를 줄여 주세요.');
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (++visited > 3000) throw new SvnServiceError('SVN_ERROR', '새 폴더의 파일이 너무 많습니다. SVN ignore 설정으로 범위를 줄여 주세요.');
        if (excluded.has(entry.name) || patterns.some(p => p.test(entry.name))) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile() || entry.isSymbolicLink()) files.push({ path: path.relative(root, full), status: 'unversioned', props: 'none', treeConflict: false, kind: 'file' });
      }
    };
    await walk(directory, 0);
    return files;
  }

  async update(root: string, credentials?: Credentials): Promise<MutationResult> {
    const local = await this.local(root);
    return this.mutate(async () => { const result = this.result(await this.run(['update', '--accept', 'postpone', peg(local)], credentials, 'update', local)); result.conflicts = (await this.status(local)).filter(c => c.status === 'conflicted').map(c => c.path); return result; });
  }

  async commit(root: string, files: string[], message: string, credentials?: Credentials): Promise<MutationResult> {
    if (!message.trim() || message.includes('\0')) invalid('커밋 메시지를 입력해 주세요.');
    if (!files.length || files.some(f => !f || f === '.')) invalid('커밋할 파일을 선택해 주세요.');
    const local = await this.local(root);
    const selected = [...new Set(files)];
    const requestedPaths = [...new Set(await Promise.all(selected.map(file => this.local(local, file))))];
    if (requestedPaths.includes(local)) invalid('프로젝트 전체 대신 커밋할 항목을 선택해 주세요.');
    return this.mutate(async () => {
      const changes = await this.status(local);
      if (changes.some(c => c.status === 'conflicted')) invalid('충돌을 해결한 후 커밋해 주세요.');
      const deletingDirectories = requestedPaths.filter(full => changes.some(c => c.path === path.relative(local, full) && c.kind === 'dir' && ['deleted', 'missing'].includes(c.status)));
      // A directory deletion includes its descendants even with commit --depth empty.
      const fullPaths = requestedPaths.filter(full => !deletingDirectories.some(parent => full.startsWith(parent + path.sep)));
      const targets = new Set(fullPaths);
      for (const full of fullPaths) {
        const change = changes.find(c => c.path === path.relative(local, full));
        if (change?.kind === 'dir') {
          if (!deletingDirectories.includes(full)) invalid('삭제된 폴더 외에는 커밋할 파일을 각각 선택해 주세요.');
          await this.folderDeletionPreview(local, change.path, changes);
        } else if (change?.kind === 'unknown') invalid('항목의 종류를 확인할 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.');
        else {
          try { if ((await lstat(full)).isDirectory()) invalid('삭제된 폴더 외에는 커밋할 파일을 각각 선택해 주세요.'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
      for (let index = 0; index < fullPaths.length; index++) {
        const full = fullPaths[index];
        const relative = path.relative(local, full);
        const change = changes.find(c => c.path === relative);
        let isDirectory = false;
        try { isDirectory = (await lstat(full)).isDirectory(); } catch { /* Missing versioned file. */ }
        if (isDirectory) invalid('폴더 전체 대신 커밋할 파일을 각각 선택해 주세요.');
        if (change?.kind === 'dir') {
          await this.ensureDeletionAbsent(full);
          if (change.status === 'missing') await this.run(['delete', peg(full)]);
          continue;
        }
        if (change?.status === 'missing') await this.run(['delete', '--force', peg(full)]);
        if (change?.status === 'unversioned' || !change) {
          if (!change) {
            try { await this.run(['info', '--xml', peg(full)]); continue; }
            catch (error) { if (!(error instanceof SvnServiceError) || !/E155010|E155007|W155010/.test(error.detail ?? '')) throw error; }
          }
          const parents: string[] = [];
          for (let p = path.dirname(full); p !== local; p = path.dirname(p)) parents.unshift(p);
          for (const parent of parents) {
            const parentStatus = changes.find(c => c.path === path.relative(local, parent));
            if (parentStatus?.status === 'added') targets.add(parent);
            else {
              try { await this.run(['info', '--xml', peg(parent)]); }
              catch (error) { if (!(error instanceof SvnServiceError) || !/E155010|E155007|W155010/.test(error.detail ?? '')) throw error; await this.run(['add', '--depth', 'empty', peg(parent)]); targets.add(parent); }
            }
          }
          await this.run(['add', '--depth', 'empty', peg(full)]);
        }
        // Existing scheduled additions can also have newly added ancestor directories.
        for (let p = path.dirname(full); p !== local; p = path.dirname(p)) if (changes.some(c => c.path === path.relative(local, p) && c.status === 'added')) targets.add(p);
      }
      for (const full of fullPaths.filter(full => deletingDirectories.includes(full))) await this.ensureDeletionAbsent(full);
      return this.result(await this.run(['commit', '--depth', 'empty', '-m', message, ...[...targets].map(peg)], credentials, 'commit', local));
    });
  }

  async resolve(root: string, relativePath: string): Promise<MutationResult> {
    const full = await this.local(root, relativePath);
    return this.mutate(async () => {
      const change = (await this.status(root)).find(c => c.path === relativePath);
      if (!change || change.status !== 'conflicted') invalid('충돌 상태의 파일을 선택해 주세요.');
      if (change!.treeConflict) invalid('트리 충돌은 이 버전에서 지원하지 않습니다. 터미널에서 해결해 주세요.');
      return this.result(await this.run(['resolve', '--accept', 'working', '--depth', 'empty', peg(full)], undefined, 'resolve'));
    });
  }

  private result(output: string): MutationResult {
    const revision = [...output.matchAll(/(?:Committed revision|(?:Updated to|At|Checked out) revision) (\d+)\./g)].at(-1)?.[1];
    const files = output.split(/\r?\n/).flatMap(line => { const match = line.match(/^([ADUCGER ][ UCG]?)[ +B]*\s+(.+)$/) ?? line.match(/^(Adding|Deleting|Sending|Replacing)\s+(.+)$/); return match ? [{ action: match[1].trim(), path: match[2].trim() }] : []; });
    return { ...(revision ? { revision: Number(revision) } : {}), output, files, conflicts: files.filter(f => f.action.includes('C')).map(f => f.path) };
  }
}
