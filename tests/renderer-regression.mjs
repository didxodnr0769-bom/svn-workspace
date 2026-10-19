import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'work'), {recursive:true});
const temp = await mkdtemp(path.join(root,'work','renderer-qa-'));
const requireResize = process.argv.includes('--resize');
const baseline = process.argv.includes('--baseline');
const fixture = `
const {contextBridge}=require('electron');
const calls=[]; const pending=[]; let held=false; let diffBehavior='success';
const ok=data=>({ok:true,data});
const projects=['A','B'].map(id=>({id,name:'Project '+id,path:'/mock/'+id,url:'https://example.invalid/'+id,repositoryRoot:'https://example.invalid/'+id,relativeUrl:'^/',uuid:id,revision:id==='A'?1029:3427}));
const entry=id=>({revision:id==='A'?1029:3427,author:id,date:'2026-10-16T00:00:00Z',message:id+' commit',paths:[{path:'/'+id+'/file.ts',action:'M',kind:'file'}]});
const fail=()=>({ok:false,error:{code:'SVN_ERROR',message:'Wrong project diff',detail:'E160013'}});
async function historicalDiff(id,revision,change){
 calls.push({method:'historicalDiff',id,revision,path:change.path});
 if(revision!==entry(id).revision||change.path!==entry(id).paths[0].path) return fail();
 if(diffBehavior==='delay-error'){diffBehavior='success';return new Promise(resolve=>pending.push(()=>resolve(fail())));}
 if(diffBehavior==='delay-reject'){diffBehavior='success';return new Promise((_,reject)=>pending.push(()=>reject(Error('stale transport failure'))));}
 return ok('Index: '+id+'\\n-old '+id+'\\n+new '+id);
}
contextBridge.exposeInMainWorld('__qa',{
 calls:()=>calls.slice(),clear:()=>{calls.length=0;},holdHistory:()=>{held=true;},
 holdDiff:kind=>{diffBehavior=kind;},release:()=>{held=false;for(const resolve of pending.splice(0))resolve();}
});
contextBridge.exposeInMainWorld('svn',{
 bootstrap:async()=>ok({projects,activeProjectId:'A',svn:{path:'/mock/svn',version:'mock'},credentialStorageAvailable:false}),
 selectProject:async id=>{calls.push({method:'selectProject',id});return ok(undefined);},
 history:async(id,before)=>{calls.push({method:'history',id,before});const value=ok({entries:[entry(id)],hasMore:false});return held?new Promise(resolve=>pending.push(()=>resolve(value))):value;},
 renameProject:async(id,name)=>{calls.push({method:'renameProject',id,name});const p=projects.find(p=>p.id===id);p.name=name;return ok({...p});},
 openInVSCode:async id=>{calls.push({method:'openInVSCode',id});return ok(undefined);},
 historicalDiff,
 status:async id=>ok([{path:id+'/working.ts',status:'modified',props:'none',treeConflict:false,kind:'file'}]),
 workingDiff:async(id,p)=>{calls.push({method:'workingDiff',id,path:p});return p.startsWith(id+'/')?ok('-old\\n+working '+id):fail();},
 onProgress:()=>()=>{},
 chooseDirectory:async()=>ok(null),cancelOperation:async()=>ok(undefined),
 checkout:async()=>{throw Error('Mutation forbidden in renderer QA');},
 update:async()=>{throw Error('Mutation forbidden in renderer QA');},
 commit:async()=>{throw Error('Mutation forbidden in renderer QA');},
 resolve:async()=>{throw Error('Mutation forbidden in renderer QA');}
});`;
await writeFile(path.join(temp,'preload.cjs'),fixture);
await writeFile(path.join(temp,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temp,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:900,webPreferences:{preload:__dirname+'/preload.cjs',contextIsolation:true,sandbox:true}});w.loadFile(${JSON.stringify(path.join(root,'dist/index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
 app=await _electron.launch({executablePath:require('electron'),args:[path.join(temp,'main.cjs')],env});
 const page=await app.firstWindow(); const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.locator('.diff-code').filter({hasText:'+new A'}).waitFor();
 await page.evaluate(()=>{window.__qa.clear();window.__qa.holdHistory();});
 await page.getByRole('combobox',{name:'현재 프로젝트'}).selectOption('B');
 await page.waitForFunction(()=>window.__qa.calls().some(c=>c.method==='history'&&c.id==='B'));
 // Drain effects without depending on a fast B history response.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const mixed=await page.evaluate(()=>window.__qa.calls().filter(c=>c.method==='historicalDiff'&&c.id==='B'&&c.revision===1029));
 if(baseline){assert.equal(mixed.length,1,'baseline should reproduce B + A revision');console.log('REPRODUCED:',JSON.stringify(mixed));}
 else assert.deepEqual(mixed,[],'must never request B with A revision/path');
 await page.evaluate(()=>window.__qa.release());
 await page.locator('.diff-code').filter({hasText:'+new B'}).waitFor();
 if(baseline){console.log('persisting alert:',await page.locator('[role=alert]').innerText());}
 else {
  assert.equal(await page.locator('[role=alert]').count(),0);
  await page.getByTitle('커밋할 파일과 메시지 작성',{exact:true}).click();
  await page.locator('.diff-code').filter({hasText:'+working B'}).waitFor();
  await page.evaluate(()=>{window.__qa.clear();window.__qa.holdHistory();});
  await page.getByRole('combobox',{name:'현재 프로젝트'}).selectOption('A');
  await page.waitForFunction(()=>window.__qa.calls().some(c=>c.method==='history'&&c.id==='A'));
  assert.equal((await page.evaluate(()=>window.__qa.calls())).filter(c=>c.method==='workingDiff'&&c.id==='A'&&c.path.startsWith('B/')).length,0);
  await page.evaluate(()=>window.__qa.release());
  await page.locator('.diff-code').filter({hasText:'+new A'}).waitFor();
  for(const behavior of ['delay-error','delay-reject']){
   await page.evaluate(kind=>{window.__qa.holdDiff(kind);},behavior);
   await page.getByRole('combobox',{name:'현재 프로젝트'}).selectOption('B');
   await page.waitForFunction(()=>document.querySelector('.diff-body')?.textContent.includes('불러오는 중'));
   await page.getByRole('combobox',{name:'현재 프로젝트'}).selectOption('A');
   await page.locator('.diff-code').filter({hasText:'+new A'}).waitFor();
   await page.evaluate(()=>window.__qa.release());
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await page.locator('[role=alert]').count(),0,'stale error must not escape');
  }
  if(requireResize){
   const splitter=page.getByRole('separator',{name:'커밋 목록 너비 조절'});
   await splitter.waitFor();
   const history=page.locator('.history-panel');
   const before=(await history.boundingBox()).width;const rect=await splitter.boundingBox();
   await page.mouse.move(rect.x+rect.width/2,rect.y+80);await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+150,rect.y+80,{steps:8});await page.mouse.up();
   const after=(await history.boundingBox()).width;assert.ok(after>before+120,{before,after});
   await page.reload();await page.locator('.history-item').waitFor();
   assert.ok(Math.abs((await history.boundingBox()).width-after)<2,'width restored on reload');
   await splitter.focus();await page.keyboard.press('ArrowLeft');assert.ok((await history.boundingBox()).width<after,'keyboard resizing');
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1024,700));
   await page.waitForFunction(()=>innerWidth===1024);
   assert.ok((await page.locator('.detail-panel').boundingBox()).width>=599,'detail minimum width');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),1024);
   await page.screenshot({path:path.join(root,'screenshots/07-resize-compact.png'),scale:'css'});
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,900));
   await page.waitForFunction(()=>innerWidth===1440);
   await page.screenshot({path:path.join(root,'screenshots/08-resize-history.png'),scale:'css'});
  }
  await page.getByRole('button',{name:'프로젝트 설정',exact:true}).click();
  await page.getByTitle('프로젝트 별칭 변경',{exact:true}).click();
  const aliasDialog=page.getByRole('dialog',{name:'프로젝트 별칭 변경'});
  await aliasDialog.locator('#project-alias').fill('');
  assert.ok(await aliasDialog.getByRole('button',{name:'저장',exact:true}).isDisabled());
  await aliasDialog.locator('#project-alias').fill('예제 프로젝트 · 운영');
  await aliasDialog.getByRole('button',{name:'저장',exact:true}).click();
  await aliasDialog.waitFor({state:'hidden'});
  assert.equal(await page.locator('select[aria-label="현재 프로젝트"] option:checked').textContent(),'예제 프로젝트 · 운영 (A)');
  assert.equal(await page.getByRole('combobox',{name:'현재 프로젝트'}).getAttribute('title'),'/mock/A');
  await page.getByRole('button',{name:'VS Code로 열기',exact:true}).click();
  assert.ok((await page.evaluate(()=>window.__qa.calls())).some(c=>c.method==='openInVSCode'&&c.id==='A'));
  await page.getByRole('button',{name:'프로젝트 설정',exact:true}).click();
  await page.getByTitle('프로젝트 별칭 변경',{exact:true}).click();
  await aliasDialog.getByRole('button',{name:'폴더명으로 초기화'}).click();
  assert.equal(await aliasDialog.locator('#project-alias').inputValue(),'A');
  await aliasDialog.getByRole('button',{name:'취소',exact:true}).click();
  assert.equal(await page.locator('select[aria-label="현재 프로젝트"] option:checked').textContent(),'예제 프로젝트 · 운영 (A)');
  await page.screenshot({path:path.join(root,'screenshots/09-project-alias-editor.png'),scale:'css'});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1024,700));
  await page.waitForFunction(()=>innerWidth===1024);
  const editorRect=await page.getByRole('button',{name:'VS Code로 열기',exact:true}).boundingBox();
  const actionRect=await page.getByTitle('새 저장소 체크아웃',{exact:true}).boundingBox();
  assert.ok(editorRect.x+editorRect.width<actionRect.x,'toolbar controls must not overlap');
  await page.screenshot({path:path.join(root,'screenshots/10-project-toolbar-compact.png'),scale:'css'});
  assert.deepEqual(errors,[]);console.log('PASS: project isolation, working-file isolation, late errors/rejections, project aliases, VS Code launch routing'+(requireResize?', pointer/keyboard resize, persistence, minimum native window':''));
 }
} finally {await app?.close();await rm(temp,{recursive:true,force:true});}
