import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, EmptyState, Spinner, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { ImageGallery } from '../media/ImageGallery';
import { AudioPlayer } from '../media/AudioPlayer';
import { MediaStrip } from '../media/MediaStrip';
import { MediaUploader } from '../media/MediaUploader';
import { StoryThread } from './StoryThread';
import { ShareDialog } from '../share/ShareDialog';
import { VersionDialog } from './VersionDialog';
import { CATEGORY_ICONS, CATEGORY_LABELS, STATUS_LABELS, VISIBILITY_LABELS } from '../../lib/constants';
import { formatBytes, formatDateTime } from '../../lib/format';
import { mediaSrc } from '../../lib/media';
import type { ItemDetail } from '../../api/types';

export function ItemDetailPage() {
  const { fid, itemId } = useParams<{ fid: string; itemId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [shareOpen, setShareOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const query = useQuery({
    queryKey: ['item', fid, itemId],
    queryFn: () => api.get<{ item: ItemDetail }>(`/families/${fid}/items/${itemId}`),
    enabled: Boolean(fid && itemId),
    // 有媒体还在处理中（包括崩溃后被 worker 重新入队的）时持续轮询，处理完自动停止转圈
    refetchInterval: (q) =>
      q.state.data?.item.media.some((m) => m.status === 'processing') ? 3000 : false,
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['item', fid, itemId] });
    await queryClient.invalidateQueries({ queryKey: ['items', fid] });
  };

  const status = useMutation({
    mutationFn: (action: 'publish' | 'archive' | 'restore' | 'trash') =>
      api.post(`/families/${fid}/items/${itemId}/${action}`),
    onSuccess: async (_data, action) => {
      push(
        action === 'publish' ? '已发布，家人现在能看到了' : action === 'archive' ? '已归档' : action === 'trash' ? '已移入回收站' : '已恢复',
        'success',
      );
      await invalidate();
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '操作失败', 'error'),
  });

  const downloadMarkdown = async () => {
    const item = query.data?.item;
    if (!item) return;
    const lines = [
      `# ${item.title}`,
      '',
      `- 类别：${CATEGORY_LABELS[item.category]}`,
      `- 获得时间：${item.acquiredDisplay}`,
      `- 地点：${[item.placeProvince, item.placeCity, item.placeText].filter(Boolean).join(' ') || '未记录'}`,
      `- 来源人物：${item.people.map((p) => p.name).join('、') || '未记录'}`,
      '',
      '## 故事',
      '',
      item.storyText || '（暂无）',
      '',
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.title}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (query.isLoading) return <Spinner label="正在打开…" />;

  if (query.error || !query.data) {
    return (
      <EmptyState
        icon="🔒"
        title="看不到这条记录"
        description={query.error instanceof ApiError ? query.error.message : '它可能已经被删除，或者你没有查看权限。'}
        action={
          <Button onClick={() => navigate(`/f/${fid}/items`)}>返回物品列表</Button>
        }
      />
    );
  }

  const item = query.data.item;
  const images = item.media.filter((m) => m.kind === 'image');
  const audios = item.media.filter((m) => m.kind === 'audio');
  const documents = item.media.filter((m) => m.kind === 'document');
  const place = [item.placeCountry, item.placeProvince, item.placeCity, item.placeText].filter(Boolean).join(' ');

  return (
    <div className="stack">
      <div className="page-head no-print">
        <div>
          <div className="row" style={{ gap: 'var(--space-2)', marginBottom: 6 }}>
            <Tag>{CATEGORY_ICONS[item.category]} {CATEGORY_LABELS[item.category]}</Tag>
            {item.status !== 'published' ? <Tag tone="muted">{STATUS_LABELS[item.status]}</Tag> : null}
            {item.timeUncertain ? <Tag tone="warn">时间存疑</Tag> : null}
            <Tag tone="muted">{VISIBILITY_LABELS[item.visibility]}</Tag>
          </div>
          <h1 className="detail-title">{item.title}</h1>
          <p className="page-head__sub">
            建立者 {item.creator.displayName} · 最近更新 {formatDateTime(item.updatedAt)}
          </p>
        </div>
        <div className="page-head__actions">
          {item.permissions.canEdit ? (
            <Button onClick={() => navigate(`/f/${fid}/items/${item.id}/edit`)}>编辑</Button>
          ) : null}
          {item.status === 'draft' && item.permissions.canEdit ? (
            <Button variant="primary" loading={status.isPending} onClick={() => status.mutate('publish')}>
              发布
            </Button>
          ) : null}
          {item.status === 'published' && item.permissions.canEdit ? (
            <Button onClick={() => status.mutate('archive')}>归档</Button>
          ) : null}
          {item.status === 'archived' && item.permissions.canEdit ? (
            <Button onClick={() => status.mutate('publish')}>取消归档</Button>
          ) : null}
          <Button onClick={() => setShareOpen(true)}>分享</Button>
          <Button onClick={() => navigate(`/f/${fid}/items/${item.id}/print`)}>打印</Button>
          <Button onClick={() => void downloadMarkdown()}>导出 Markdown</Button>
          <Button onClick={() => setVersionOpen(true)}>版本（{item.versionCount}）</Button>
          {item.permissions.canDelete ? (
            <Button
              variant="danger"
              loading={status.isPending}
              onClick={() => {
                if (window.confirm('移入回收站后 30 天内还能恢复，确定吗？')) status.mutate('trash');
              }}
            >
              移入回收站
            </Button>
          ) : null}
        </div>
      </div>

      <div className="detail-grid">
        <div className="stack">
          {images.length > 0 ? (
            <section className="card">
              <h2 style={{ marginBottom: 'var(--space-3)' }}>照片（{images.length}）</h2>
              <ImageGallery media={images} />
            </section>
          ) : null}

          <section className="card">
            <h2 style={{ marginBottom: 'var(--space-3)' }}>背后的故事</h2>
            {item.storyHtml ? (
              // 服务端已用白名单净化（仅保留 p/strong/em/ul/ol/li/blockquote/a）
              <div className="story" dangerouslySetInnerHTML={{ __html: item.storyHtml }} />
            ) : (
              <p className="muted">
                还没有写下故事。{item.permissions.canEdit ? '点右上角「编辑」补上几句也好。' : ''}
              </p>
            )}
          </section>

          {audios.length > 0 ? (
            <section className="card">
              <h2 style={{ marginBottom: 'var(--space-3)' }}>录音（{audios.length}）</h2>
              <div className="stack">
                {audios.map((m) => (
                  <AudioPlayer key={m.id} media={m} fid={fid} onChanged={() => void invalidate()} />
                ))}
              </div>
            </section>
          ) : null}

          {documents.length > 0 ? (
            <section className="card">
              <h2 style={{ marginBottom: 'var(--space-3)' }}>扫描件与文件（{documents.length}）</h2>
              <div className="stack">
                {documents.map((m) => (
                  <div key={m.id} className="upload-item">
                    <span aria-hidden="true">📄</span>
                    <span className="upload-item__name">{m.caption || m.originalName}</span>
                    <span className="muted">{formatBytes(m.byteSize)}</span>
                    <a className="btn btn--sm" href={mediaSrc(m.rawUrl)} target="_blank" rel="noreferrer">
                      打开
                    </a>
                    <a className="btn btn--sm" href={mediaSrc(m.rawUrl)} download={m.originalName}>
                      下载
                    </a>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <StoryThread fid={fid!} item={item} />
        </div>

        <aside className="stack">
          <section className="card">
            <h2 style={{ marginBottom: 'var(--space-3)' }}>来历</h2>
            <div className="fact-list">
              <div className="fact">
                <span className="fact__label">获得时间</span>
                <span className="fact__value">
                  {item.acquiredDisplay}
                  {item.acquiredNote ? <span className="muted">（{item.acquiredNote}）</span> : null}
                </span>
              </div>
              <div className="fact">
                <span className="fact__label">地点</span>
                <span className="fact__value">{place || <span className="muted">未记录</span>}</span>
              </div>
              <div className="fact">
                <span className="fact__label">来源人物</span>
                <span className="fact__value">
                  {item.people.length === 0 ? (
                    <span className="muted">未记录</span>
                  ) : (
                    item.people.map((p) => (
                      <Link key={`${p.personId}-${p.role}`} to={`/f/${fid}/people/${p.personId}`} className="tag" style={{ marginRight: 6 }}>
                        {p.name}
                        {p.relation ? `·${p.relation}` : ''}
                      </Link>
                    ))
                  )}
                </span>
              </div>
              <div className="fact">
                <span className="fact__label">存放位置</span>
                <span className="fact__value">{item.storageLocation || <span className="muted">未记录</span>}</span>
              </div>
              <div className="fact">
                <span className="fact__label">保存状况</span>
                <span className="fact__value">{item.condition || <span className="muted">未记录</span>}</span>
              </div>
              {item.tags.length > 0 ? (
                <div className="fact">
                  <span className="fact__label">标签</span>
                  <span className="fact__value">
                    {item.tags.map((t) => (
                      <Tag key={t}>{t}</Tag>
                    ))}
                  </span>
                </div>
              ) : null}
            </div>
          </section>

          {item.permissions.canManageMedia ? (
            <section className="card no-print">
              <div className="card__head">
                <h2>图片与录音</h2>
                <Button size="sm" onClick={() => setUploadOpen((v) => !v)}>
                  {uploadOpen ? '收起' : '上传'}
                </Button>
              </div>
              <MediaStrip fid={fid!} media={item.media} editable onChange={() => void invalidate()} />
              {uploadOpen ? (
                <>
                  <hr className="divider" />
                  <MediaUploader fid={fid!} itemId={item.id} onUploaded={() => void invalidate()} />
                </>
              ) : null}
            </section>
          ) : null}

          {item.sharedWith.length > 0 ? (
            <section className="card">
              <h2 style={{ marginBottom: 'var(--space-3)' }}>额外授权</h2>
              <p className="muted" style={{ fontSize: 13 }}>
                除家庭成员外，这些家人也被单独授权查看：
              </p>
              <div className="row">
                {item.sharedWith.map((s) => (
                  <Tag key={s.userId}>
                    {s.displayName}
                    {s.canEdit ? '（可编辑）' : ''}
                  </Tag>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </div>

      <ShareDialog open={shareOpen} fid={fid!} itemIds={[item.id]} onClose={() => setShareOpen(false)} />
      <VersionDialog open={versionOpen} fid={fid!} itemId={item.id} onClose={() => setVersionOpen(false)} />
    </div>
  );
}

