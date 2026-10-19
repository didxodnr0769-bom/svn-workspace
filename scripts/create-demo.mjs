import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || 'work/demo');
try { await access(root); throw new Error(`Destination already exists: ${root}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(root, { recursive: true });
const binary = process.env.SVN_BINARY || '/opt/homebrew/bin/svn';
const admin = process.env.SVNADMIN_BINARY || '/opt/homebrew/bin/svnadmin';
const repo = path.join(root, 'repository');
const wc = path.join(root, 'workspace');
const peer = path.join(root, 'peer');
execFileSync(admin, ['create', repo]);
const svn = (...args) => execFileSync(binary, [...args, '--non-interactive'], { cwd: wc, encoding: 'utf8' });
execFileSync(binary, ['checkout', pathToFileURL(repo).href, wc]);
await mkdir(path.join(wc, 'src'));
await writeFile(path.join(wc, 'README.md'), '# SVN Workspace Demo\n\n개인용 SVN 앱을 위한 예제 프로젝트입니다.\n');
await writeFile(path.join(wc, 'src', 'greeting.ts'), "export const greeting = '안녕하세요';\nexport const showWelcome = true;\n");
await writeFile(path.join(wc, 'src', 'theme.ts'), "export const accent = '#7668ad';\nexport const spacing = 12;\n");
svn('add', 'README.md', 'src');
svn('commit', '-m', '[개발자] 예제 프로젝트 초기 구성', '--username', 'demo');
await writeFile(path.join(wc, 'src', 'greeting.ts'), "export const greeting = 'SVN Workspace에 오신 것을 환영합니다';\nexport const showWelcome = true;\n");
svn('commit', 'src/greeting.ts', '-m', '[개발자] 시작 안내 문구 개선', '--username', 'demo');
await writeFile(path.join(wc, 'src', 'theme.ts'), "export const accent = '#7668ad';\nexport const spacing = 16;\n");
svn('commit', 'src/theme.ts', '-m', '[동료] 화면 기본 간격 조정', '--username', 'colleague');
svn('update');
execFileSync(binary, ['checkout', pathToFileURL(repo).href, peer]);
await writeFile(path.join(wc, 'src', 'greeting.ts'), "export const greeting = '오늘의 변경 사항을 확인해 보세요';\nexport const showWelcome = true;\n");
await writeFile(path.join(wc, 'README.md'), '# SVN Workspace Demo\n\n개인용 SVN 앱을 위한 예제 프로젝트입니다.\n\n선택한 파일만 커밋해 보세요.\n');
await writeFile(path.join(wc, 'src', '새 파일 @demo.ts'), "export const newFeature = '체크아웃, 업데이트, 커밋';\n");
console.log(JSON.stringify({ root, repository: repo, url: pathToFileURL(repo).href, workspace: wc, peer }, null, 2));
