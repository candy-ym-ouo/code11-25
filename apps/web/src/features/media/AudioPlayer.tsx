import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWaveform, mediaSrc } from '../../lib/media';
import { formatDuration } from '../../lib/format';
import type { Media } from '../../api/types';
import { api, ApiError } from '../../api/client';
import { Button, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5];

export function AudioPlayer({ media, fid, onChanged }: { media: Media; fid?: string; onChanged?: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState((media.durationMs ?? 0) / 1000);
  const [rate, setRate] = useState(1);
  const [showTranscript, setShowTranscript] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { push } = useToast();

  const reprocess = async () => {
    if (!fid) return;
    setRetrying(true);
    try {
      await api.post(`/families/${fid}/media/${media.id}/reprocess`);
      push('已重新加入处理队列，稍后自动刷新', 'success');
      onChanged?.();
    } catch (err) {
      push(err instanceof ApiError ? err.message : '重试失败', 'error');
    } finally {
      setRetrying(false);
    }
  };

  const waveform = useQuery({
    queryKey: ['waveform', media.id],
    queryFn: () => fetchWaveform(media),
    enabled: Boolean(media.waveformUrl),
    staleTime: Infinity,
  });

  // 波形与进度绘制：已播放部分用主色，未播放部分用浅色
  useEffect(() => {
    const canvas = canvasRef.current;
    const peaks = waveform.data?.peaks;
    if (!canvas || !peaks || peaks.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const barWidth = Math.max(1, width / peaks.length - 1);
    const progressRatio = duration > 0 ? current / duration : 0;
    peaks.forEach((peak, i) => {
      const x = (i / peaks.length) * width;
      const h = Math.max(2, peak * (height - 8));
      const played = i / peaks.length <= progressRatio;
      ctx.fillStyle = played ? '#2F4858' : '#c9c2b6';
      ctx.fillRect(x, (height - h) / 2, barWidth, h);
    });
  }, [waveform.data, current, duration]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  const seekBy = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + seconds));
  };

  const onWaveformClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const audio = audioRef.current;
    const canvas = canvasRef.current;
    if (!audio || !canvas || !Number.isFinite(audio.duration)) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
  };

  return (
    <div className="audio-player">
      <div className="audio-player__head">
        <Button size="sm" variant="primary" onClick={toggle} aria-label={playing ? '暂停' : '播放'}>
          {playing ? '暂停' : '播放'}
        </Button>
        <span className="audio-player__name" title={media.originalName}>
          {media.caption || media.originalName}
        </span>
        {media.status === 'processing' ? <Tag tone="warn">处理中</Tag> : null}
        {media.status === 'failed' ? <Tag tone="warn">处理失败（原始录音仍保留）</Tag> : null}
        {fid && (media.status === 'failed' || media.status === 'processing') ? (
          <Button size="sm" variant="ghost" loading={retrying} onClick={() => void reprocess()}>
            {media.status === 'failed' ? '重试处理' : '重新入队'}
          </Button>
        ) : null}
      </div>

      {waveform.data?.peaks?.length ? (
        <canvas
          ref={canvasRef}
          className="waveform"
          onClick={onWaveformClick}
          role="img"
          aria-label="录音波形，点击可跳转播放位置"
        />
      ) : (
        <div className="waveform waveform--empty">
          {media.hasWaveform ? '正在生成波形…' : '这段录音已保存原始文件，暂无波形数据'}
        </div>
      )}

      <audio
        ref={audioRef}
        src={mediaSrc(media.rawUrl)}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onEnded={() => setPlaying(false)}
      />

      <div className="audio-player__controls">
        <span>
          {formatDuration(current * 1000)} / {formatDuration(duration * 1000)}
        </span>
        <Button size="sm" variant="ghost" onClick={() => seekBy(-15)}>
          −15 秒
        </Button>
        <Button size="sm" variant="ghost" onClick={() => seekBy(15)}>
          +15 秒
        </Button>
        <label className="row" style={{ gap: 4 }}>
          <span className="muted">倍速</span>
          <select
            className="input"
            style={{ minHeight: 32, width: 84, padding: '2px 8px' }}
            value={rate}
            onChange={(e) => {
              const next = Number(e.target.value);
              setRate(next);
              if (audioRef.current) audioRef.current.playbackRate = next;
            }}
          >
            {PLAYBACK_RATES.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </label>
        {media.transcript ? (
          <button type="button" className="transcript-toggle" onClick={() => setShowTranscript((v) => !v)}>
            {showTranscript ? '收起听写稿' : '看听写稿'}
          </button>
        ) : null}
      </div>

      {showTranscript && media.transcript ? <div className="transcript">{media.transcript}</div> : null}
    </div>
  );
}

