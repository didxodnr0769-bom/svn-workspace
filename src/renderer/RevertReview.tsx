import { AlertCircle, FileCode2, Folder, ShieldCheck } from 'lucide-react';
import type { RevertPreview } from '../shared/types';

export function RevertReviewContent({ preview }: { preview: RevertPreview }) {
  const descendants = preview.targets.reduce((count, target) => count + target.entries.length, 0);
  return <div className="modal-body revert-review">
    <p className="revert-warning"><AlertCircle size={18} />커밋하지 않은 변경 내용은 사라집니다.</p>
    <ul className="revert-targets" aria-label="되돌릴 항목">
      {preview.targets.map(target => <li key={target.path}>
        <div className="revert-target-heading">
          {target.kind === 'dir' ? <Folder size={17} /> : <FileCode2 size={17} />}
          <strong>{target.path}{target.kind === 'dir' ? '/' : ''}</strong>
          <span>{target.kind === 'dir' ? '폴더와 하위 항목 복원' : '내용·속성 복원'}</span>
        </div>
        {target.entries.length > 0 && <ul className="revert-descendants" aria-label={`${target.path} 함께 복원할 항목`}>
          {target.entries.map(entry => <li key={entry.path} style={{ paddingLeft: 14 + Math.min(12, entry.path.slice(target.path.length + 1).split('/').length - 1) * 16 }}>
            {entry.kind === 'dir' ? <Folder size={14} /> : <FileCode2 size={14} />}<span>{entry.path.slice(target.path.length + 1)}</span>
          </li>)}
        </ul>}
      </li>)}
    </ul>
    <p className="field-hint">선택 {preview.targets.length}개 · 하위 항목 {descendants}개 포함</p>
    <div className="info-note"><ShieldCheck size={18} /><div><p>새 파일·추가 예약 항목과 선택하지 않은 변경은 유지됩니다.</p>
      {preview.preservedPaths.length > 0 && <p className="revert-preserved">선택 항목 중 유지: {preview.preservedPaths.join(' · ')}</p>}
    </div></div>
  </div>;
}
