import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SvnServiceError } from './svn-service';

interface EditorOptions {
  /** Explicit candidates allow isolated tests without opening the installed editor. */
  candidates?: string[];
}

function defaultCandidates(): string[] {
  return [
    '/opt/homebrew/bin/code',
    '/usr/local/bin/code',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    path.join(os.homedir(), 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'),
    ...String(process.env.PATH ?? '').split(path.delimiter).filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, 'code')),
  ];
}

export async function openInVSCode(folder: string, options: EditorOptions = {}): Promise<void> {
  let directory: string;
  try {
    if (!path.isAbsolute(folder) || folder.includes('\0')) throw new Error('invalid path');
    directory = await realpath(folder);
    if (!(await stat(directory)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new SvnServiceError('IO_ERROR', '프로젝트 폴더를 찾을 수 없습니다. 폴더가 이동하거나 삭제되지 않았는지 확인해 주세요.');
  }

  let executable: string | undefined;
  for (const candidate of new Set(options.candidates ?? defaultCandidates())) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) { executable = candidate; break; }
    } catch { /* Try the next installed CLI. */ }
  }
  if (!executable) {
    throw new SvnServiceError('IO_ERROR', 'VS Code를 찾을 수 없습니다. Visual Studio Code를 응용 프로그램 폴더에 설치하거나 code 명령어를 PATH에 등록해 주세요.');
  }

  const env = { ...process.env };
  // Do not inherit another Electron app's runtime or a VS Code remote terminal target.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'VSCODE_NODE_OPTIONS', 'VSCODE_NODE_REPL_EXTERNAL_MODULE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_CWD']) delete env[key];
  env.PATH = [...new Set([...(env.PATH ?? '').split(path.delimiter).filter(Boolean), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter);

  await new Promise<void>((resolve, reject) => {
    execFile(executable, ['--new-window', directory], { shell: false, env, timeout: 15000, maxBuffer: 64 * 1024 }, error => {
      if (!error) return resolve();
      reject(new SvnServiceError('IO_ERROR', 'VS Code를 열지 못했습니다. VS Code 설치 상태를 확인한 뒤 다시 시도해 주세요.'));
    });
  });
}
