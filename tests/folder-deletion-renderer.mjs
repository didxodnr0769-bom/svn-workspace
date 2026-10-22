import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root,'work'), {recursive:true});
await mkdir(path.join(root,'screenshots'), {recursive:true});
const temp = await mkdtemp(path.join(root,'work','folder-deletion-qa-'));
const mainPath = path.join(temp,'main.cjs');
const fixture = String.raw`
const {contextBridge}=require('electron');
const ok=data=>({ok:true,data}); const calls=[]; const pending=[]; const behavior=new Map(); let revision=10;
const projects=['A','B'].map(id=>({id,name:'예제 프로젝트 '+id,path:'/mock/'+id,url:'https://example.invalid/'+id,repositoryRoot:'https://example.invalid/'+id,relativeUrl:'^/',uuid:id,revision:10}));
const change=(path,kind,status)=>({path,kind,status,props:'none',treeConflict:false});
const changes=[change('assets','dir','deleted'),change('assets/css','dir','deleted'),change('assets/css/기존 @스타일.scss','file','deleted'),change('assets/empty','dir','deleted'),change('assets/readme.txt','file','deleted'),change('removed','dir','missing'),change('empty','dir','deleted'),change('assets-other/keep.ts','file','modified'),change('notes.txt','file','modified'),change('ordinary-dir','dir','normal')];
const previews={assets:{path:'assets',entries:[{path:'assets/css',kind:'dir'},{path:'assets/css/기존 @스타일.scss',kind:'file'},{path:'assets/empty',kind:'dir'},{path:'assets/readme.txt',kind:'file'}]},removed:{path:'removed',entries:[{path:'removed/한글 @파일.txt',kind:'file'}]},empty:{path:'empty',entries:[]}};
const error=()=>({ok:false,error:{code:'SVN_ERROR',message:'삭제 범위 조회 실패 (예제)'}});
contextBridge.exposeInMainWorld('__qa',{calls:()=>calls.slice(),clear:()=>{calls.length=0;},setPreviewBehavior:(path,value)=>{behavior.set(path,value);},release:()=>{for(const resolve of pending.splice(0))resolve();}});
contextBridge.exposeInMainWorld('svn',{
 bootstrap:async()=>ok({projects,activeProjectId:'A',svn:{path:'/mock/svn',version:'mock'},credentialStorageAvailable:false}),
 selectProject:async id=>{calls.push({method:'selectProject',id});return ok(undefined);},
 history:async id=>ok({entries:[{revision,author:'demo',date:'2026-10-22T00:00:00Z',message:'예제 변경 '+id,paths:[{path:'/'+id+'/notes.txt',action:'M',kind:'file'}]}],hasMore:false}),
 historicalDiff:async()=>ok('Index: notes.txt\n-before\n+after'),
 status:async id=>{calls.push({method:'status',id});return ok(id==='B'?[change('notes.txt','file','modified')]:changes);},
 deletionPreview:async(id,path)=>{calls.push({method:'deletionPreview',id,path});const current=behavior.get(path)||'success';if(current.startsWith('delay-')){behavior.delete(path);return new Promise(resolve=>pending.push(()=>resolve(current==='delay-error'?error():ok(previews[path]))));}return current==='error'?error():ok(previews[path]);},
 workingDiff:async(id,path)=>{calls.push({method:'workingDiff',id,path});return ok('Index: '+path+'\n--- '+path+'\n+++ /dev/null\n@@ -1 +0,0 @@\n-예제 삭제 내용 '+path);},
 commit:async(id,paths,message)=>{calls.push({method:'commit',id,paths,message});revision++;return ok({revision,output:'Committed revision '+revision+'.',files:paths.map(path=>({path,action:'D'})),conflicts:[]});},
 onProgress:()=>()=>{},chooseDirectory:async()=>ok(null),cancelOperation:async()=>ok(undefined),
 renameProject:async()=>{throw Error('Not used');},openInVSCode:async()=>ok(undefined),
 checkout:async()=>{throw Error('Real mutation forbidden');},update:async()=>{throw Error('Real mutation forbidden');},resolve:async()=>{throw Error('Real mutation forbidden');}
});`;
await writeFile(path.join(temp,'preload.cjs'),fixture);
await writeFile(mainPath,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temp,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:900,minWidth:1024,minHeight:700,webPreferences:{preload:__dirname+'/preload.cjs',contextIsolation:true,sandbox:true}});w.loadFile(${JSON.stringify(path.join(root,'dist/index.html'))});});app.on('window-all-closed',()=>app.quit());`);
if(process.argv.includes('--prepare')) console.log(JSON.stringify({mainPath,temp}));
else {
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;let app;
 try {
  app=await _electron.launch({executablePath:require('electron'),args:[mainPath],env});
  const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  const preview=page.getByRole('region',{name:'폴더 삭제 미리보기'});
  const submit=page.getByTitle('선택한 항목 서버에 커밋',{exact:true});
  const review=page.getByRole('dialog',{name:'폴더 삭제 범위 확인'});
  const outcome=page.getByRole('dialog',{name:'커밋 완료'});
  const row=p=>page.getByRole('checkbox',{name:p+' 커밋 선택',exact:true});
  const choose=p=>page.getByTitle(p+' · '+(p==='removed'?'누락 · 삭제 반영':'삭제'),{exact:true}).click();
  const calls=()=>page.evaluate(()=>window.__qa.calls());
  const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const open=async()=>{await page.getByTitle('커밋할 파일과 메시지 작성',{exact:true}).click();await row('assets').waitFor();await preview.getByText('하위 파일 2개 · 하위 폴더 2개',{exact:true}).waitFor();};
  const message=body=>page.locator('#commit-message').fill(body);
  const switchProject=async id=>{await page.getByRole('combobox',{name:'현재 프로젝트'}).selectOption(id);await page.locator('.history-item').filter({hasText:'예제 변경 '+id}).waitFor();};
  await page.locator('.history-item').waitFor();await open();
  assert.ok(await row('assets').isEnabled());assert.ok(await row('removed').isEnabled());assert.ok(await row('ordinary-dir').isDisabled());
  assert.equal(await row('assets/css/기존 @스타일.scss').count(),0,'descendants are not separate targets');
  assert.ok(await row('assets-other/keep.ts').isVisible(),'prefix siblings remain separate');
  const tree=preview.getByRole('list',{name:'assets 함께 삭제되는 항목'});
  assert.equal(await tree.locator('li').count(),4);await tree.getByText('empty',{exact:true}).waitFor();
  await preview.getByRole('button',{name:'assets/css/기존 @스타일.scss 삭제 내용 보기',exact:true}).click();
  await preview.locator('.diff-code').filter({hasText:'-예제 삭제 내용 assets/css/기존 @스타일.scss'}).waitFor();
  assert.ok((await calls()).some(c=>c.method==='workingDiff'&&c.path==='assets/css/기존 @스타일.scss'));
  await row('assets').check();await message('예제 폴더 삭제');assert.ok(await submit.isEnabled());
  await page.screenshot({path:path.join(root,'screenshots/11-folder-deletion.png'),scale:'css'});
  await submit.click();await review.waitFor();
  assert.equal((await calls()).filter(c=>c.method==='commit').length,0,'review precedes mutation');
  assert.equal(await review.getByRole('list').locator('li').count(),4);
  await page.screenshot({path:path.join(root,'screenshots/12-folder-deletion-review.png'),scale:'css'});
  await review.getByRole('button',{name:'취소',exact:true}).click();await review.waitFor({state:'hidden'});
  assert.equal((await calls()).filter(c=>c.method==='commit').length,0,'cancel does not commit');
  assert.ok(await row('assets').isChecked());assert.equal(await page.locator('#commit-message').inputValue(),'예제 폴더 삭제');
  await submit.click();await review.getByRole('button',{name:'삭제 포함 커밋',exact:true}).click();await outcome.waitFor();
  const committed=(await calls()).find(c=>c.method==='commit');assert.deepEqual(committed.paths,['assets']);assert.equal(committed.message,'예제 폴더 삭제');
  assert.ok(!committed.paths.includes('notes.txt')&&!committed.paths.includes('assets-other/keep.ts'),'unselected siblings excluded');
  await outcome.getByRole('button',{name:'확인',exact:true}).click();await open();
  await choose('removed');await preview.getByText('하위 파일 1개 · 하위 폴더 0개',{exact:true}).waitFor();
  await preview.getByRole('button',{name:'removed/한글 @파일.txt 삭제 내용 보기',exact:true}).waitFor();
  await row('removed').check();await row('notes.txt').check();await message('누락 폴더와 선택 파일');
  await submit.click();await review.getByText('하위 파일 1개 · 하위 폴더 0개',{exact:true}).waitFor();
  await review.getByRole('button',{name:'삭제 포함 커밋',exact:true}).click();await outcome.waitFor();
  assert.deepEqual((await calls()).filter(c=>c.method==='commit').at(-1).paths,['removed','notes.txt']);
  await outcome.getByRole('button',{name:'확인',exact:true}).click();await open();
  await choose('empty');await preview.getByText('하위 파일 0개 · 하위 폴더 0개',{exact:true}).waitFor();
  await preview.getByText('하위 항목이 없는 빈 폴더입니다.',{exact:true}).waitFor();
  // Late preview failures must not contaminate a different folder or project.
  await page.evaluate(()=>window.__qa.setPreviewBehavior('assets','delay-error'));await choose('assets');await preview.getByRole('status').waitFor();
  await choose('empty');await preview.getByText('하위 파일 0개 · 하위 폴더 0개',{exact:true}).waitFor();
  await page.evaluate(()=>window.__qa.release());await settle();assert.equal(await preview.getByRole('alert').count(),0);
  await page.evaluate(()=>window.__qa.setPreviewBehavior('assets','delay-error'));await choose('assets');await preview.getByRole('status').waitFor();
  await switchProject('B');await page.evaluate(()=>window.__qa.release());await settle();
  assert.equal(await preview.count(),0);assert.equal(await page.getByRole('alert').count(),0);
  await switchProject('A');await open();
  const all=page.getByRole('checkbox',{name:'커밋 가능한 모든 항목 선택',exact:true});
  await all.check();for(const p of ['assets','removed','empty','notes.txt'])assert.ok(await row(p).isChecked());
  assert.ok(!await row('ordinary-dir').isChecked());await all.uncheck();assert.ok(!await row('assets').isChecked());
  await row('assets').check();await preview.getByText('하위 파일 2개 · 하위 폴더 2개',{exact:true}).waitFor();
  await preview.getByRole('button',{name:'assets/readme.txt 삭제 내용 보기',exact:true}).click();await preview.locator('.diff-code').waitFor();
  await message('작은 창에서도 삭제 확인');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1024,700));await page.waitForFunction(()=>innerWidth===1024);
  const fit=async loc=>{const b=await loc.boundingBox();const v=await page.evaluate(()=>({w:innerWidth,h:innerHeight}));assert.ok(b&&b.width>0&&b.height>0&&b.x>=0&&b.y>=0&&b.x+b.width<=v.w+1&&b.y+b.height<=v.h+1,'required region fits viewport');};
  await fit(submit);await fit(preview);await fit(page.locator('#commit-message'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),1024);
  await page.screenshot({path:path.join(root,'screenshots/13-folder-deletion-compact.png'),scale:'css'});
  await submit.click();await review.waitFor();await fit(review);await fit(review.getByRole('button',{name:'삭제 포함 커밋',exact:true}));
  await review.getByRole('button',{name:'취소',exact:true}).click();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,900));await page.waitForFunction(()=>innerWidth===1440);
  // A failed current deletion-scope refresh must block review and mutation.
  await page.evaluate(()=>{window.__qa.clear();window.__qa.setPreviewBehavior('assets','error');});
  await choose('empty');await choose('assets');await preview.getByRole('alert').filter({hasText:'삭제 범위 조회 실패'}).waitFor();
  await submit.click();await page.getByRole('alert').filter({hasText:'삭제 범위 조회 실패'}).first().waitFor();await settle();
  assert.equal(await review.count(),0);assert.equal((await calls()).filter(c=>c.method==='commit').length,0);
  // Ordinary-file commits still bypass deletion review.
  await switchProject('B');await page.getByTitle('커밋할 파일과 메시지 작성',{exact:true}).click();await row('notes.txt').waitFor();await row('notes.txt').check();await message('일반 파일 수정');
  await page.evaluate(()=>window.__qa.clear());await submit.click();await outcome.waitFor();assert.equal(await review.count(),0);
  const plain=(await calls()).find(c=>c.method==='commit');assert.deepEqual(plain.paths,['notes.txt']);assert.equal(plain.id,'B');assert.deepEqual(errors,[]);
  console.log('PASS: scheduled/missing/empty folder selection, descendant tree and file diff, review/cancel/confirm, root-only targets and sibling exclusion, preview errors and stale responses, compact viewport, ordinary-file commit.');
 } finally {await app?.close();await rm(temp,{recursive:true,force:true});}
}
