import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, FileCode2, Folder, LoaderCircle } from 'lucide-react';
import type { DeletionPreview } from '../shared/types';

export function deletionSummary(preview: DeletionPreview): string {
  const files = preview.entries.filter(entry => entry.kind === 'file').length;
  const folders = preview.entries.filter(entry => entry.kind === 'dir').length;
  const unknown = preview.entries.length - files - folders;
  return `하위 파일 ${files}개 · 하위 폴더 ${folders}개${unknown ? ` · 기타 ${unknown}개` : ''}`;
}

export function DeletionTree({ preview, selectedPath, onSelect }: { preview: DeletionPreview; selectedPath?: string; onSelect?: (path: string) => void }) {
  return <ul className="deletion-tree" aria-label={`${preview.path} 함께 삭제되는 항목`}>
    {!preview.entries.length && <li className="deletion-empty">하위 항목이 없는 빈 폴더입니다.</li>}
    {preview.entries.map(entry => {
      const relative = entry.path.slice(preview.path.length + 1);
      const segments = relative.split('/');
      const contents = <><span className="deletion-mark">D</span>{entry.kind === 'dir' ? <Folder size={15} /> : <FileCode2 size={15} />}<span className="deletion-name">{segments.at(-1)}</span><span className="deletion-kind">{entry.kind === 'dir' ? '폴더' : entry.kind === 'file' ? '파일' : '항목'}</span></>;
      const style = { paddingLeft: 12 + Math.min(segments.length - 1, 12) * 16 };
      return <li key={entry.path}>{onSelect && entry.kind === 'file' ? <button className={`deletion-entry ${selectedPath === entry.path ? 'selected' : ''}`} style={style} title={entry.path} aria-label={`${entry.path} 삭제 내용 보기`} aria-pressed={selectedPath === entry.path} onClick={() => onSelect(entry.path)}>{contents}</button> : <div className="deletion-entry" style={style} title={entry.path}>{contents}</div>}</li>;
    })}
  </ul>;
}

export function FolderDeletion({ projectId, path, refreshKey, renderDiff }: { projectId: string; path: string; refreshKey: object; renderDiff: (text: string, loading: boolean, path?: string) => ReactNode }) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [selectedPath, setSelectedPath] = useState<string>();
  const [diff, setDiff] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  useEffect(() => {
    let current = true;
    setLoading(true); setPreview(null); setFailure(''); setSelectedPath(undefined); setDiff('');
    void window.svn.deletionPreview(projectId, path).then(result => {
      if (!current) return;
      if (result.ok) setPreview(result.data); else setFailure(result.error.message);
    }).catch(() => { if (current) setFailure('삭제 범위를 불러오지 못했습니다. 새로고침 후 다시 확인해 주세요.'); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [projectId, path, refreshKey]);
  useEffect(() => {
    let current = true;
    setDiff(''); setDiffLoading(!!selectedPath);
    if (selectedPath) void window.svn.workingDiff(projectId, selectedPath).then(result => {
      if (!current) return;
      setDiff(result.ok ? result.data : result.error.message);
    }).catch(() => { if (current) setDiff('파일 변경 내용을 불러오지 못했습니다.'); }).finally(() => { if (current) setDiffLoading(false); });
    return () => { current = false; };
  }, [projectId, selectedPath, refreshKey]);
  return <section className="folder-deletion" aria-label="폴더 삭제 미리보기">
    <div className="deletion-overview">
      <div className="deletion-heading"><Folder size={19} /><div><strong title={path}>{path}</strong><span>폴더와 하위 항목을 함께 삭제합니다.</span></div></div>
      {loading ? <p className="deletion-status" role="status"><LoaderCircle size={16} className="spin" />삭제될 항목을 불러오는 중</p> : failure ? <p className="deletion-status deletion-error" role="alert"><AlertCircle size={16} />{failure}</p> : preview && <><p className="deletion-summary">{deletionSummary(preview)}</p><DeletionTree preview={preview} selectedPath={selectedPath} onSelect={setSelectedPath} /></>}
    </div>
    {selectedPath ? renderDiff(diff, diffLoading, selectedPath) : <div className="deletion-help">{preview?.entries.some(entry => entry.kind === 'file') ? '위 목록에서 파일을 선택하면 삭제되는 내용을 확인할 수 있어요.' : '커밋하면 이 폴더의 삭제가 저장소에 반영됩니다.'}</div>}
  </section>;
}
