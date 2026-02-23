import JSZip from 'jszip';
import type { Chapter } from '../types';
import { getChapterCachedAudioEntries } from './ttsAudioStorage';

export interface ExportCachedTtsAudiobookOptions {
  bookId: string;
  bookTitle: string;
  chapters: Chapter[];
  chapterIndices: number[];
  includeSubtitles: boolean;
}

export interface ExportCachedTtsAudiobookChapterResult {
  chapterIndex: number;
  chapterTitle: string;
  audioFileName?: string;
  subtitleFileName?: string;
  exported: boolean;
  reason?: string;
}

export interface ExportCachedTtsAudiobookResult {
  zipBlob: Blob;
  zipFileName: string;
  chapterResults: ExportCachedTtsAudiobookChapterResult[];
  exportedCount: number;
  skippedCount: number;
}

const INVALID_FILENAME_CHARS_REGEX = /[<>:"/\\|?*\u0000-\u001F]/g;
const COLLAPSED_SPACE_REGEX = /\s+/g;

const normalizeSearchText = (raw: string) =>
  (raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029\u0085]/g, '\n')
    .replace(COLLAPSED_SPACE_REGEX, ' ')
    .trim();

const sanitizeFileName = (raw: string, fallback: string) => {
  const cleaned = (raw || '')
    .replace(INVALID_FILENAME_CHARS_REGEX, '_')
    .replace(COLLAPSED_SPACE_REGEX, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const safe = cleaned || fallback;
  return safe.slice(0, 96);
};

const padChapterNo = (index: number) => String(index + 1).padStart(3, '0');

const formatTimestampForFileName = (timestamp: number) => {
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${h}${min}${sec}`;
};

const formatSrtTimestamp = (seconds: number) => {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

const buildSrt = (cues: Array<{ start: number; end: number; text: string }>) => {
  const lines: string[] = [];
  cues.forEach((cue, idx) => {
    const text = cue.text.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').trim();
    if (!text) return;
    lines.push(String(idx + 1));
    lines.push(`${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}`);
    lines.push(text);
    lines.push('');
  });
  return lines.join('\n');
};

const getAudioContextCtor = () => {
  if (typeof AudioContext !== 'undefined') return AudioContext;
  const maybeWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
  return maybeWindow.webkitAudioContext || null;
};

const renderConcatenatedAudioBuffer = async (buffers: AudioBuffer[]) => {
  if (buffers.length === 0) return null;
  const sampleRate = Math.max(22050, ...buffers.map((buffer) => buffer.sampleRate));
  const channelCount = Math.max(1, ...buffers.map((buffer) => buffer.numberOfChannels));
  const totalDuration = buffers.reduce((sum, buffer) => sum + buffer.duration, 0);
  const totalFrames = Math.max(1, Math.ceil(totalDuration * sampleRate));

  const offline = new OfflineAudioContext(channelCount, totalFrames, sampleRate);
  let cursorTime = 0;
  buffers.forEach((buffer) => {
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start(cursorTime);
    cursorTime += buffer.duration;
  });
  return offline.startRendering();
};

const audioBufferToWavBlob = (audioBuffer: AudioBuffer) => {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const frameCount = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataByteLength = frameCount * blockAlign;
  const fileBuffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(fileBuffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  const channelData = Array.from({ length: channelCount }, (_, idx) => audioBuffer.getChannelData(idx));
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
      const pcm = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, Math.round(pcm), true);
      offset += bytesPerSample;
    }
  }

  return new Blob([fileBuffer], { type: 'audio/wav' });
};

interface OrderedChapterAudioEntry {
  chunkText: string;
  audioBlob: Blob;
  createdAt: number;
}

const orderChapterCachedEntries = (
  chapter: Chapter,
  entries: Array<{ chunkText: string; audioBlob: Blob; createdAt: number }>,
): OrderedChapterAudioEntry[] => {
  const normalizedChapterText = normalizeSearchText(chapter.content || '');
  const normalizedTitle = normalizeSearchText(chapter.title || '');

  return entries
    .map((entry, sourceIndex) => {
      const normalizedChunk = normalizeSearchText(entry.chunkText || '');
      const isLikelyTitle =
        !!normalizedTitle &&
        !!normalizedChunk &&
        (normalizedChunk === normalizedTitle || normalizedTitle.startsWith(normalizedChunk) || normalizedChunk.startsWith(normalizedTitle));
      const chapterOffset = !isLikelyTitle && normalizedChunk
        ? normalizedChapterText.indexOf(normalizedChunk)
        : -1;
      return {
        ...entry,
        sourceIndex,
        isLikelyTitle,
        chapterOffset: chapterOffset >= 0 ? chapterOffset : Number.MAX_SAFE_INTEGER,
      };
    })
    .sort((left, right) => {
      if (left.isLikelyTitle !== right.isLikelyTitle) return left.isLikelyTitle ? -1 : 1;
      if (left.chapterOffset !== right.chapterOffset) return left.chapterOffset - right.chapterOffset;
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
      return left.sourceIndex - right.sourceIndex;
    })
    .map(({ chunkText, audioBlob, createdAt }) => ({ chunkText, audioBlob, createdAt }));
};

export async function exportCachedTtsAudiobookZip(
  options: ExportCachedTtsAudiobookOptions,
): Promise<ExportCachedTtsAudiobookResult> {
  const { bookId, bookTitle, chapters, includeSubtitles } = options;
  const selectedIndices = Array.from(
    new Set(
      options.chapterIndices
        .filter((index) => Number.isFinite(index))
        .map((index) => Math.floor(index))
        .filter((index) => index >= 0 && index < chapters.length),
    ),
  ).sort((a, b) => a - b);

  if (!bookId) {
    throw new Error('缺少书籍 ID，无法导出有声书');
  }
  if (selectedIndices.length === 0) {
    throw new Error('请先选择至少一个章节');
  }

  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) {
    throw new Error('当前浏览器不支持音频离线处理，无法导出有声书');
  }

  const decodingAudioContext = new AudioContextCtor();
  const zip = new JSZip();
  const safeBookTitle = sanitizeFileName(bookTitle || 'book', 'book');
  const rootFolder = zip.folder(safeBookTitle) || zip;
  const chapterResults: ExportCachedTtsAudiobookChapterResult[] = [];

  try {
    for (const chapterIndex of selectedIndices) {
      const chapter = chapters[chapterIndex];
      const chapterTitleRaw = (chapter?.title || '').trim();
      const chapterTitle = chapterTitleRaw || `第${chapterIndex + 1}章`;

      if (!chapter) {
        chapterResults.push({
          chapterIndex,
          chapterTitle,
          exported: false,
          reason: '章节不存在',
        });
        continue;
      }

      const cachedEntries = await getChapterCachedAudioEntries(bookId, chapterIndex);
      if (cachedEntries.length === 0) {
        chapterResults.push({
          chapterIndex,
          chapterTitle,
          exported: false,
          reason: '该章节暂无缓存音频',
        });
        continue;
      }

      const orderedEntries = orderChapterCachedEntries(chapter, cachedEntries);
      const decodedBuffers: AudioBuffer[] = [];
      const subtitleCues: Array<{ start: number; end: number; text: string }> = [];
      let subtitleCursor = 0;

      for (const entry of orderedEntries) {
        try {
          const arrayBuffer = await entry.audioBlob.arrayBuffer();
          const decoded = await decodingAudioContext.decodeAudioData(arrayBuffer.slice(0));
          decodedBuffers.push(decoded);
          subtitleCues.push({
            start: subtitleCursor,
            end: subtitleCursor + decoded.duration,
            text: entry.chunkText,
          });
          subtitleCursor += decoded.duration;
        } catch {
          // Skip corrupted chunks so export can continue.
        }
      }

      if (decodedBuffers.length === 0) {
        chapterResults.push({
          chapterIndex,
          chapterTitle,
          exported: false,
          reason: '该章节缓存音频无法解码',
        });
        continue;
      }

      const mergedAudioBuffer = await renderConcatenatedAudioBuffer(decodedBuffers);
      if (!mergedAudioBuffer) {
        chapterResults.push({
          chapterIndex,
          chapterTitle,
          exported: false,
          reason: '音频拼接失败',
        });
        continue;
      }

      const chapterFileBase = `${padChapterNo(chapterIndex)}-${sanitizeFileName(chapterTitle, `chapter-${chapterIndex + 1}`)}`;
      const audioFileName = `${chapterFileBase}.wav`;
      const audioBlob = audioBufferToWavBlob(mergedAudioBuffer);
      rootFolder.file(audioFileName, audioBlob);

      let subtitleFileName: string | undefined;
      if (includeSubtitles) {
        subtitleFileName = `${chapterFileBase}.srt`;
        rootFolder.file(subtitleFileName, buildSrt(subtitleCues));
      }

      chapterResults.push({
        chapterIndex,
        chapterTitle,
        exported: true,
        audioFileName,
        subtitleFileName,
      });
    }
  } finally {
    try {
      await decodingAudioContext.close();
    } catch {
      // ignore close failures
    }
  }

  const exportedCount = chapterResults.filter((item) => item.exported).length;
  const skippedCount = chapterResults.length - exportedCount;
  if (exportedCount === 0) {
    throw new Error('所选章节都没有可导出的缓存音频');
  }

  const zipFileName = `${safeBookTitle}-audiobook-${formatTimestampForFileName(Date.now())}.zip`;
  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return {
    zipBlob,
    zipFileName,
    chapterResults,
    exportedCount,
    skippedCount,
  };
}
