export type ErrorCode = 'AUTH_REQUIRED' | 'CERTIFICATE' | 'SVN_NOT_FOUND' | 'BUSY' | 'CANCELLED' | 'INVALID_ARGUMENT' | 'SVN_ERROR' | 'IO_ERROR';
export interface AppError { code: ErrorCode; message: string; detail?: string; authTarget?: string }
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };
export interface Credentials { username: string; password: string; remember?: boolean }
export interface WorkingCopyInfo { path: string; url: string; repositoryRoot: string; relativeUrl: string; uuid: string; revision: number }
export interface Project extends WorkingCopyInfo { id: string; name: string }
export interface AppState { projects: Project[]; activeProjectId: string | null; svn: { path: string; version: string } | null; credentialStorageAvailable: boolean }
export interface CommittedPath { path: string; action: 'A' | 'M' | 'D' | 'R'; kind: 'file' | 'dir' | 'unknown'; copyFromPath?: string; copyFromRevision?: number }
export interface HistoryEntry { revision: number; author: string; date: string; message: string; paths: CommittedPath[] }
export interface HistoryPage { entries: HistoryEntry[]; hasMore: boolean }
export type WorkingStatus = 'modified' | 'added' | 'deleted' | 'missing' | 'unversioned' | 'conflicted' | 'replaced' | 'normal' | 'obstructed' | 'incomplete';
export interface WorkingChange { path: string; status: WorkingStatus; props: string; treeConflict: boolean; kind: 'file' | 'dir' | 'unknown' }
export interface DeletionEntry { path: string; kind: 'file' | 'dir' | 'unknown' }
export interface DeletionPreview { path: string; entries: DeletionEntry[] }
export interface OperationFile { path: string; action: string }
export interface MutationResult { revision?: number; output: string; files: OperationFile[]; conflicts: string[] }
export interface OperationProgress { operation: 'checkout' | 'update' | 'commit' | 'resolve'; message: string }
export interface CheckoutInput { url: string; destination: string; name: string }
export interface CheckoutResult { project: Project; result: MutationResult }
export interface AuthOptions { credentials?: Credentials }
export interface SvnAPI {
  bootstrap(): Promise<Result<AppState>>;
  chooseDirectory(mode: 'existing' | 'destination'): Promise<Result<string | null>>;
  chooseSvnExecutable(): Promise<Result<AppState>>;
  openProject(path: string, auth?: AuthOptions): Promise<Result<Project>>;
  selectProject(id: string): Promise<Result<void>>;
  renameProject(id: string, name: string): Promise<Result<Project>>;
  removeProject(id: string): Promise<Result<AppState>>;
  openInVSCode(id: string): Promise<Result<void>>;
  checkout(input: CheckoutInput, auth?: AuthOptions): Promise<Result<CheckoutResult>>;
  history(id: string, beforeRevision?: number, auth?: AuthOptions): Promise<Result<HistoryPage>>;
  historicalDiff(id: string, revision: number, change: CommittedPath, auth?: AuthOptions): Promise<Result<string>>;
  status(id: string): Promise<Result<WorkingChange[]>>;
  workingDiff(id: string, path: string): Promise<Result<string>>;
  deletionPreview(id: string, path: string): Promise<Result<DeletionPreview>>;
  update(id: string, auth?: AuthOptions): Promise<Result<MutationResult>>;
  commit(id: string, paths: string[], message: string, auth?: AuthOptions): Promise<Result<MutationResult>>;
  resolve(id: string, path: string): Promise<Result<MutationResult>>;
  openFile(id: string, path: string): Promise<Result<void>>;
  revealProject(id: string): Promise<Result<void>>;
  cancelOperation(): Promise<Result<void>>;
  onProgress(listener: (progress: OperationProgress) => void): () => void;
}
declare global { interface Window { svn: SvnAPI } }
