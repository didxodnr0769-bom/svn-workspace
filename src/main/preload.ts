import { contextBridge, ipcRenderer } from 'electron';
import type { SvnAPI, OperationProgress } from '../shared/types';
const api: SvnAPI = {
  bootstrap: () => ipcRenderer.invoke('svn:bootstrap'),
  chooseDirectory: mode => ipcRenderer.invoke('svn:chooseDirectory', mode),
  chooseSvnExecutable: () => ipcRenderer.invoke('svn:chooseSvnExecutable'),
  openProject: (path, auth) => ipcRenderer.invoke('svn:openProject', path, auth),
  selectProject: id => ipcRenderer.invoke('svn:selectProject', id),
  renameProject: (id, name) => ipcRenderer.invoke('svn:renameProject', id, name),
  removeProject: id => ipcRenderer.invoke('svn:removeProject', id),
  openInVSCode: id => ipcRenderer.invoke('svn:openInVSCode', id),
  checkout: (input, auth) => ipcRenderer.invoke('svn:checkout', input, auth),
  history: (id, before, auth) => ipcRenderer.invoke('svn:history', id, before, auth),
  historicalDiff: (id, revision, change, auth) => ipcRenderer.invoke('svn:historicalDiff', id, revision, change, auth),
  status: id => ipcRenderer.invoke('svn:status', id),
  workingDiff: (id, path) => ipcRenderer.invoke('svn:workingDiff', id, path),
  deletionPreview: (id, path) => ipcRenderer.invoke('svn:deletionPreview', id, path),
  update: (id, auth) => ipcRenderer.invoke('svn:update', id, auth),
  commit: (id, paths, message, auth) => ipcRenderer.invoke('svn:commit', id, paths, message, auth),
  resolve: (id, path) => ipcRenderer.invoke('svn:resolve', id, path),
  openFile: (id, path) => ipcRenderer.invoke('svn:openFile', id, path),
  revealProject: id => ipcRenderer.invoke('svn:revealProject', id),
  cancelOperation: () => ipcRenderer.invoke('svn:cancelOperation'),
  onProgress: listener => {
    const handler = (_event: unknown, progress: OperationProgress) => listener(progress);
    ipcRenderer.on('svn:progress', handler);
    return () => ipcRenderer.removeListener('svn:progress', handler);
  },
};
contextBridge.exposeInMainWorld('svn', api);
