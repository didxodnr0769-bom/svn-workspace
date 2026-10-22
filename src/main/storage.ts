import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Credentials, Project, WorkingCopyInfo } from '../shared/types';

interface Settings { version: 1; projects: Project[]; activeProjectId: string | null; svnPath?: string }
interface Encryption { isEncryptionAvailable(): boolean; encryptString(text: string): Buffer; decryptString(value: Buffer): string }
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return fallback; throw error; }
}
async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}
export class SettingsStore {
  private data: Settings = { version: 1, projects: [], activeProjectId: null };
  private writing = Promise.resolve();
  constructor(private directory: string) {}
  async load(): Promise<void> {
    const loaded = await readJson<Settings | null>(path.join(this.directory, 'settings.json'), this.data);
    const data = loaded && typeof loaded === 'object' ? loaded : this.data;
    this.data = { version: 1, projects: Array.isArray(data.projects) ? data.projects.filter(p => p && typeof p.id === 'string' && typeof p.path === 'string' && path.isAbsolute(p.path) && typeof p.url === 'string' && typeof p.name === 'string').slice(0, 100) : [], activeProjectId: typeof data.activeProjectId === 'string' ? data.activeProjectId : null, svnPath: typeof data.svnPath === 'string' ? data.svnPath : undefined };
    if (!this.data.projects.some(p => p.id === this.data.activeProjectId)) this.data.activeProjectId = this.data.projects[0]?.id ?? null;
  }
  snapshot(): Settings { return structuredClone(this.data); }
  private async save(): Promise<void> {
    const snapshot = this.snapshot();
    this.writing = this.writing.catch(() => {}).then(() => writeJson(path.join(this.directory, 'settings.json'), snapshot));
    await this.writing;
  }
  async add(info: WorkingCopyInfo, name?: string): Promise<Project> {
    const canonical = await fs.realpath(info.path);
    const id = createHash('sha256').update(canonical).digest('hex').slice(0, 20);
    const existing = this.data.projects.find(p => p.id === id);
    const project: Project = { ...info, path: canonical, id, name: name?.trim() || existing?.name || path.basename(canonical) };
    this.data.projects = [project, ...this.data.projects.filter(p => p.id !== id)].slice(0, 100);
    this.data.activeProjectId = id;
    await this.save();
    return project;
  }
  async select(id: string): Promise<void> { this.data.activeProjectId = id; await this.save(); }
  async rename(id: string, input: string): Promise<Project> {
    const name = input.trim();
    if (!name || name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('별칭은 1~128자의 한 줄로 입력해 주세요.');
    const existing = this.data.projects.find(project => project.id === id);
    if (!existing) throw new Error('등록된 프로젝트를 찾을 수 없습니다.');
    const updated = { ...existing, name };
    this.data.projects = this.data.projects.map(project => project.id === id ? updated : project);
    await this.save();
    return { ...updated };
  }
  async remove(id: string): Promise<void> {
    if (!this.data.projects.some(project => project.id === id)) throw new Error('등록된 프로젝트를 찾을 수 없습니다.');
    const projects = this.data.projects.filter(project => project.id !== id);
    this.data = { ...this.data, projects, activeProjectId: this.data.activeProjectId === id ? projects[0]?.id ?? null : this.data.activeProjectId };
    await this.save();
  }
  async setSvnPath(binary: string): Promise<void> { this.data.svnPath = binary; await this.save(); }
}
interface EncryptedCredential { username: string; ciphertext: string }
export class CredentialStore {
  private session = new Map<string, Credentials>();
  private saved: Record<string, EncryptedCredential> = {};
  private writing = Promise.resolve();
  constructor(private directory: string, private encryption: Encryption) {}
  async load(): Promise<void> {
    const loaded = await readJson<Record<string, EncryptedCredential> | null>(path.join(this.directory, 'credentials.json'), {});
    this.saved = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
  }
  available(): boolean { return this.encryption.isEncryptionAvailable(); }
  private key(target: string): string { return createHash('sha256').update(target.replace(/\/$/, '')).digest('hex'); }
  get(target: string): Credentials | undefined {
    const key = this.key(target);
    const active = this.session.get(key);
    if (active) return { ...active };
    const record = this.saved[key];
    if (!record || !this.available()) return undefined;
    try {
      const credentials = { username: record.username, password: this.encryption.decryptString(Buffer.from(record.ciphertext, 'base64')), remember: true };
      this.session.set(key, credentials);
      return { ...credentials };
    } catch { return undefined; }
  }
  async set(target: string, credentials: Credentials): Promise<void> {
    const key = this.key(target);
    this.session.set(key, { ...credentials });
    if (credentials.remember) {
      if (!this.available()) throw new Error('암호화 저장소를 사용할 수 없습니다.');
      this.saved[key] = { username: credentials.username, ciphertext: this.encryption.encryptString(credentials.password).toString('base64') };
    } else { delete this.saved[key]; }
    this.writing = this.writing.catch(() => {}).then(() => writeJson(path.join(this.directory, 'credentials.json'), this.saved));
    await this.writing;
  }
  forgetSession(target: string): void { this.session.delete(this.key(target)); }
}
