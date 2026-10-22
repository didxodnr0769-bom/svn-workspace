import type { WorkingChange } from './types';

export const isFolderDeletion = (change: WorkingChange) => change.kind === 'dir' && ['deleted', 'missing'].includes(change.status);
export const canCommitChange = (change: WorkingChange) => !change.treeConflict && (change.kind === 'file' || isFolderDeletion(change)) && ['modified', 'added', 'deleted', 'missing', 'unversioned', 'replaced', 'normal'].includes(change.status);

// A folder deletion already includes every descendant, even if status lists them too.
export function topLevelChanges(changes: WorkingChange[]): WorkingChange[] {
  const folders = changes.filter(isFolderDeletion);
  return changes.filter(change => !folders.some(folder => change.path.startsWith(folder.path + '/')));
}
