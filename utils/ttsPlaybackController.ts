import type { TtsConfig, TtsChunk, TtsPlaybackState } from '../types';
import { callTtsApi } from './ttsEngine';
import { getTtsAudio, saveTtsAudio, deleteTtsAudio, clearBookTtsAudio } from './ttsAudioStorage';

// ─── Constants ───

const DEFAULT_CHUNK_SIZE = 2000;
const PREFETCH_AHEAD = 2;

// ─── Text Chunking ───

interface ParagraphInfo {
  text: string;
  start: number;
  end: number;
  index: number;
}

function splitAtSentenceBoundaries(text: string, chunkSize: number): string[] {
  const target = chunkSize;
  const max = Math.round(chunkSize * 1.25);
  const min = Math.max(50, Math.round(chunkSize * 0.1));

  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let splitIdx = -1;
    const searchEnd = Math.min(rest.length, target + Math.round(target * 0.1));

    // 1. Try sentence-ending punctuation (Chinese/Japanese/English)
    for (let i = min; i < searchEnd; i++) {
      const ch = rest[i];
      if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '.' ||
          ch === '\u3002' /* 。 */ || ch === '\uff01' /* ！ */ || ch === '\uff1f' /* ？ */) {
        splitIdx = i + 1;
        if (splitIdx >= target * 0.8) break;
      }
    }

    // 2. Fallback to clause-level punctuation (including Japanese 、)
    if (splitIdx < 0) {
      for (let i = min; i < searchEnd; i++) {
        const ch = rest[i];
        if (ch === '，' || ch === ',' || ch === '；' || ch === ';' || ch === '：' || ch === ':' ||
            ch === '、' || ch === '\uff0c' /* ， */ || ch === '\uff1b' /* ； */ || ch === '\uff1a' /* ： */) {
          splitIdx = i + 1;
          if (splitIdx >= target * 0.8) break;
        }
      }
    }

    // 3. Fallback to space boundaries (avoid breaking English/Korean words)
    if (splitIdx < 0) {
      for (let i = Math.min(searchEnd - 1, target); i >= min; i--) {
        if (rest[i] === ' ' || rest[i] === '\u3000' /* fullwidth space */) {
          splitIdx = i + 1;
          break;
        }
      }
    }

    // 4. Last resort: hard cut at target (only for CJK text with no punctuation/spaces)
    if (splitIdx < 0) splitIdx = target;
    parts.push(rest.slice(0, splitIdx));
    rest = rest.slice(splitIdx);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

export function buildTtsChunks(
  paragraphs: ParagraphInfo[],
  chapterIndex: number | null,
  startFromParagraphIndex = 0,
  chunkSize = DEFAULT_CHUNK_SIZE,
): TtsChunk[] {
  const chunks: TtsChunk[] = [];
  let chunkIdCounter = 0;
  const maxLen = Math.round(chunkSize * 1.25);

  const makeChunk = (text: string, indices: number[], charStart: number, charEnd: number): TtsChunk => ({
    id: `tts-${Date.now()}-${chunkIdCounter++}`,
    text,
    paragraphIndices: indices,
    chapterIndex,
    charStart,
    charEnd,
    status: 'pending',
  });

  // 1 paragraph = 1 chunk (or multiple sub-chunks for very long paragraphs)
  for (let i = startFromParagraphIndex; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const paraText = para.text.trim();
    if (!paraText) continue;

    if (paraText.length > maxLen) {
      const subTexts = splitAtSentenceBoundaries(paraText, chunkSize);
      for (const sub of subTexts) {
        chunks.push(makeChunk(sub, [para.index], para.start, para.end));
      }
    } else {
      chunks.push(makeChunk(paraText, [para.index], para.start, para.end));
    }
  }

  return chunks;
}

// ─── Playback Controller ───

export interface TtsPlaybackCallbacks {
  onStateChange: (state: TtsPlaybackState) => void;
  onParagraphChange: (paragraphIndex: number) => void;
  onError: (error: string) => void;
  onComplete: () => void;
}

export class TtsPlaybackController {
  private chunks: TtsChunk[] = [];
  private currentChunkIndex = 0;
  private audio: HTMLAudioElement;
  private config: TtsConfig;
  private bookId: string;
  private callbacks: TtsPlaybackCallbacks;
  private isPlaying = false;
  private isPaused = false;
  private isActive = false;
  private currentSpeed: number;
  private prefetchAborts = new Map<number, AbortController>();
  private objectUrls = new Set<string>();
  private lastEmittedParagraph = -1;
  private destroyed = false;

  constructor(audio: HTMLAudioElement, config: TtsConfig, callbacks: TtsPlaybackCallbacks, bookId: string) {
    this.audio = audio;
    this.config = config;
    this.callbacks = callbacks;
    this.currentSpeed = config.speed;
    this.bookId = bookId;
  }

  start(chunks: TtsChunk[]): void {
    this.stop();
    this.chunks = chunks;
    this.currentChunkIndex = 0;
    this.isActive = true;
    this.isPlaying = false;
    this.isPaused = false;
    this.lastEmittedParagraph = -1;
    this.destroyed = false;

    this.emitState();
    this.playCurrentChunk();
  }

  pause(): void {
    if (!this.isActive || !this.isPlaying) return;
    this.audio.pause();
    this.isPlaying = false;
    this.isPaused = true;
    this.emitState();
  }

  resume(): void {
    if (!this.isActive || !this.isPaused) return;
    this.audio.play().catch(() => { /* ignore */ });
    this.isPlaying = true;
    this.isPaused = false;
    this.emitState();
  }

  stop(): void {
    this.isActive = false;
    this.isPlaying = false;
    this.isPaused = false;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.audio.ontimeupdate = null;
    this.audio.onended = null;
    this.audio.onerror = null;
    this.lastEmittedParagraph = -1;

    for (const [, ctrl] of this.prefetchAborts) ctrl.abort();
    this.prefetchAborts.clear();

    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();

    this.chunks = [];
    this.emitState();
  }

  next(): void {
    if (!this.isActive) return;
    if (this.currentChunkIndex < this.chunks.length - 1) {
      this.currentChunkIndex++;
      this.playCurrentChunk();
    }
  }

  previous(): void {
    if (!this.isActive) return;
    if (this.currentChunkIndex > 0) {
      this.currentChunkIndex--;
      this.playCurrentChunk();
    }
  }

  setSpeed(speed: number): void {
    this.currentSpeed = speed;
    if (this.audio && !this.audio.paused) {
      this.audio.playbackRate = speed;
    }
    this.emitState();
  }

  updateConfig(config: TtsConfig): void {
    this.config = config;
    this.currentSpeed = config.speed;
  }

  getState(): TtsPlaybackState {
    const chunk = this.chunks[this.currentChunkIndex];
    // Collect unique paragraph indices from chunks that have cached audio
    const cachedSet = new Set<number>();
    for (const c of this.chunks) {
      if (c.audioBlob || c.status === 'playing' || c.status === 'played' || c.status === 'ready') {
        for (const idx of c.paragraphIndices) {
          cachedSet.add(idx);
        }
      }
    }
    return {
      isActive: this.isActive,
      isPlaying: this.isPlaying,
      isPaused: this.isPaused,
      currentChunkIndex: this.currentChunkIndex,
      currentParagraphIndex: chunk?.paragraphIndices[0] ?? 0,
      chunks: this.chunks,
      chapterIndex: chunk?.chapterIndex ?? null,
      speed: this.currentSpeed,
      error: null,
      cachedParagraphIndices: Array.from(cachedSet),
    };
  }

  getCurrentParagraphIndex(): number {
    return this.lastEmittedParagraph >= 0 ? this.lastEmittedParagraph : 0;
  }

  /** Jump playback to the chunk containing the given paragraph */
  jumpToParagraph(paragraphIndex: number): void {
    if (!this.isActive) return;
    const chunkIdx = this.chunks.findIndex(c => c.paragraphIndices.includes(paragraphIndex));
    if (chunkIdx < 0) return;
    this.audio.pause();
    if (this.audio.src && this.audio.src.startsWith('blob:')) {
      URL.revokeObjectURL(this.audio.src);
      this.objectUrls.delete(this.audio.src);
    }
    this.currentChunkIndex = chunkIdx;
    this.lastEmittedParagraph = -1;
    this.playCurrentChunk();
  }

  /** Refresh (re-fetch) ALL chunks belonging to the given paragraph */
  async refreshParagraph(paragraphIndex: number): Promise<void> {
    // Find ALL chunk indices for this paragraph (split paragraphs have multiple)
    const chunkIndices: number[] = [];
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].paragraphIndices.includes(paragraphIndex)) {
        chunkIndices.push(i);
      }
    }
    if (chunkIndices.length === 0) return;

    // Clear in-memory blobs AND IndexedDB cache for each chunk
    for (const idx of chunkIndices) {
      const chunk = this.chunks[idx];

      // Delete from IndexedDB so fetchChunk won't find old cached audio
      if (this.bookId) {
        try {
          await deleteTtsAudio(this.bookId, chunk.chapterIndex ?? 0, chunk.text);
        } catch {
          // ignore storage errors
        }
      }

      chunk.audioBlob = undefined;
      chunk.status = 'pending';
      chunk.error = undefined;
    }

    this.emitState();

    // Pause current playback
    this.audio.pause();
    if (this.audio.src && this.audio.src.startsWith('blob:')) {
      URL.revokeObjectURL(this.audio.src);
      this.objectUrls.delete(this.audio.src);
    }

    // Jump to the first chunk of this paragraph and start playing
    this.currentChunkIndex = chunkIndices[0];
    this.lastEmittedParagraph = -1;
    await this.playCurrentChunk();
  }

  /** Clear all in-memory audio blobs and IndexedDB cache for this book */
  async clearAllAudioCache(): Promise<void> {
    // Clear in-memory
    for (const chunk of this.chunks) {
      chunk.audioBlob = undefined;
      if (chunk.status === 'ready' || chunk.status === 'played') {
        chunk.status = 'pending';
      }
    }
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();

    // Clear IndexedDB for this book
    if (this.bookId) {
      try {
        await clearBookTtsAudio(this.bookId);
      } catch {
        // ignore storage errors
      }
    }
  }

  /** Get total bytes of in-memory cached audio blobs */
  getCacheSize(): number {
    let total = 0;
    for (const chunk of this.chunks) {
      if (chunk.audioBlob) total += chunk.audioBlob.size;
    }
    return total;
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
  }

  // ─── Private ───

  private async playCurrentChunk(): Promise<void> {
    if (this.destroyed || !this.isActive) return;
    const chunk = this.chunks[this.currentChunkIndex];
    if (!chunk) {
      this.callbacks.onComplete();
      this.stop();
      return;
    }

    // fetch if needed
    if (chunk.status === 'pending') {
      await this.fetchChunk(this.currentChunkIndex);
    } else if (chunk.status === 'fetching') {
      // wait for existing fetch
      while (chunk.status === 'fetching' && !this.destroyed) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    if (this.destroyed || !this.isActive) return;

    if (chunk.status === 'error' || !chunk.audioBlob) {
      this.callbacks.onError(chunk.error || 'TTS 音频获取失败');
      // Allow host app to stop playback in onError callback.
      if (this.destroyed || !this.isActive) return;
      // try next chunk
      if (this.currentChunkIndex < this.chunks.length - 1) {
        this.currentChunkIndex++;
        this.playCurrentChunk();
      } else {
        this.callbacks.onComplete();
        this.stop();
      }
      return;
    }

    // create object url
    const url = URL.createObjectURL(chunk.audioBlob);
    this.objectUrls.add(url);
    this.audio.src = url;
    this.audio.playbackRate = this.currentSpeed;

    chunk.status = 'playing';

    this.audio.ontimeupdate = () => this.handleTimeUpdate();
    this.audio.onended = () => this.handleEnded();
    this.audio.onerror = () => {
      chunk.status = 'error';
      this.handleEnded();
    };

    try {
      await this.audio.play();
      this.isPlaying = true;
      this.isPaused = false;

      // Always emit the first paragraph of the new chunk
      if (chunk.paragraphIndices.length > 0) {
        const first = chunk.paragraphIndices[0];
        this.lastEmittedParagraph = first;
        this.callbacks.onParagraphChange(first);
      }

      this.prefetchUpcoming();
      this.emitState();
    } catch {
      this.callbacks.onError('无法播放音频，请检查浏览器权限');
    }
  }

  private async fetchChunk(index: number): Promise<void> {
    const chunk = this.chunks[index];
    if (!chunk || chunk.status !== 'pending') return;

    const abort = new AbortController();
    this.prefetchAborts.set(index, abort);
    chunk.status = 'fetching';
    this.emitState();

    try {
      // Try IndexedDB cache first
      const chapterIdx = chunk.chapterIndex ?? 0;
      let blob: Blob | null = null;

      if (this.bookId) {
        try {
          blob = await getTtsAudio(this.bookId, chapterIdx, chunk.text);
        } catch {
          // ignore cache read errors
        }
      }

      if (!blob) {
        // Not cached, call API
        blob = await callTtsApi(chunk.text, this.config, abort.signal);

        // Save to IndexedDB for persistence
        if (this.bookId && blob) {
          try {
            await saveTtsAudio(this.bookId, chapterIdx, chunk.text, blob, this.config);
          } catch {
            // ignore cache write errors
          }
        }
      }

      chunk.audioBlob = blob;
      chunk.status = 'ready';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        chunk.status = 'pending';
      } else {
        chunk.status = 'error';
        chunk.error = err instanceof Error ? err.message : 'TTS 请求失败';
      }
    } finally {
      this.prefetchAborts.delete(index);
      this.emitState();
    }
  }

  private prefetchUpcoming(): void {
    for (let offset = 1; offset <= PREFETCH_AHEAD; offset++) {
      const idx = this.currentChunkIndex + offset;
      if (idx >= this.chunks.length) break;
      const chunk = this.chunks[idx];
      if (chunk.status === 'pending') {
        this.fetchChunk(idx);
      }
    }
  }

  private handleTimeUpdate(): void {
    // With 1 paragraph = 1 chunk, paragraph changes happen at chunk
    // transitions (in playCurrentChunk/handleEnded), not during playback.
    // This handler is kept for future use but no longer does paragraph tracking.
  }

  private handleEnded(): void {
    if (this.destroyed || !this.isActive) return;

    const prevChunk = this.chunks[this.currentChunkIndex];
    if (prevChunk) {
      prevChunk.status = 'played';
      // Keep audioBlob in memory for cache (don't release)
    }

    // revoke the old object url (but keep the blob)
    if (this.audio.src && this.audio.src.startsWith('blob:')) {
      URL.revokeObjectURL(this.audio.src);
      this.objectUrls.delete(this.audio.src);
    }

    if (this.currentChunkIndex < this.chunks.length - 1) {
      this.currentChunkIndex++;
      this.playCurrentChunk();
    } else {
      this.callbacks.onComplete();
      this.stop();
    }
  }

  private emitState(): void {
    if (this.destroyed) return;
    this.callbacks.onStateChange(this.getState());
  }
}
