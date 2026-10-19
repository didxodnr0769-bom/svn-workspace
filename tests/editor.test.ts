import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openInVSCode } from '../src/main/editor';
import { SvnServiceError } from '../src/main/svn-service';

test('VS Code receives one absolute directory argument without interpreting shell characters', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svn-editor-'));
  try {
    const directory = path.join(root, '한글 프로젝트 $(touch marker); @trunk');
    const binary = path.join(root, 'fake code');
    const log = path.join(root, 'arguments.json');
    await mkdir(directory);
    await writeFile(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
    await chmod(binary, 0o700);
    await openInVSCode(directory, { candidates: [path.join(root, 'missing-code'), root, binary] });
    assert.deepEqual(JSON.parse(await readFile(log, 'utf8')), ['--new-window', await realpath(directory)]);
    await assert.rejects(readFile(path.join(root, 'marker')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing or non-directory projects fail before attempting to launch an editor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svn-editor-'));
  try {
    const file = path.join(root, 'file');
    await writeFile(file, 'fixture');
    for (const folder of [path.join(root, 'missing'), file, 'relative/path']) {
      await assert.rejects(openInVSCode(folder, { candidates: [] }), error => error instanceof SvnServiceError && error.code === 'IO_ERROR' && error.message.includes('프로젝트 폴더'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unavailable VS Code CLI gives an actionable installation message', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svn-editor-'));
  try {
    await assert.rejects(openInVSCode(root, { candidates: [] }), error => error instanceof SvnServiceError && error.code === 'IO_ERROR' && error.message.includes('PATH'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a CLI failure is reported as an application error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'svn-editor-'));
  try {
    const binary = path.join(root, 'code');
    await writeFile(binary, '#!/bin/sh\nexit 1\n');
    await chmod(binary, 0o700);
    await assert.rejects(openInVSCode(root, { candidates: [binary] }), error => error instanceof SvnServiceError && error.code === 'IO_ERROR' && error.message.includes('열지 못했습니다'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
