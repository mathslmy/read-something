import type { TtsConfig } from '../types';

// ─── IndexedDB Configuration ───

const TTS_AUDIO_DB_NAME = 'app_tts_audio_v1';
const TTS_AUDIO_STORE = 'tts_audio_chunks';
const TTS_AUDIO_DB_VERSION = 1;

export interface StoredTtsAudioEntry {
  key: string;
  audioBlob: Blob;
  textHash: string;
  createdAt: number;
  chunkText: string;
  provider: string;
  voiceId: string;
  model: string;
  bookId: string;
  chapterIndex: number;
}

// ─── Text Hashing ───

function computeTextHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return 'h' + (hash >>> 0).toString(36);
}

function buildKey(bookId: string, chapterIndex: number, chunkText: string): string {
  return `${bookId}::ch${chapterIndex}::${computeTextHash(chunkText)}`;
}

// ─── Database Access ───

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(TTS_AUDIO_DB_NAME, TTS_AUDIO_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TTS_AUDIO_STORE)) {
        db.createObjectStore(TTS_AUDIO_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开 TTS 音频数据库失败'));
  });

  return dbPromise;
};

// ─── CRUD Operations ───

export async function saveTtsAudio(
  bookId: string,
  chapterIndex: number,
  chunkText: string,
  audioBlob: Blob,
  config: TtsConfig,
): Promise<void> {
  const db = await openDb();
  const key = buildKey(bookId, chapterIndex, chunkText);

  const entry: StoredTtsAudioEntry = {
    key,
    audioBlob,
    textHash: computeTextHash(chunkText),
    createdAt: Date.now(),
    chunkText,
    provider: config.provider,
    voiceId: config.voiceId,
    model: config.model,
    bookId,
    chapterIndex,
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(TTS_AUDIO_STORE, 'readwrite');
    const store = tx.objectStore(TTS_AUDIO_STORE);
    store.put(entry, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存 TTS 音频失败'));
  });
}

export async function getTtsAudio(
  bookId: string,
  chapterIndex: number,
  chunkText: string,
): Promise<Blob | null> {
  const db = await openDb();
  const key = buildKey(bookId, chapterIndex, chunkText);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(TTS_AUDIO_STORE, 'readonly');
    const store = tx.objectStore(TTS_AUDIO_STORE);
    const request = store.get(key);

    request.onsuccess = () => {
      const entry = request.result as StoredTtsAudioEntry | undefined;
      if (entry?.audioBlob instanceof Blob) {
        resolve(entry.audioBlob);
      } else {
        resolve(null);
      }
    };
    request.onerror = () => reject(request.error || new Error('读取 TTS 音频失败'));
  });
}

export async function deleteTtsAudio(
  bookId: string,
  chapterIndex: number,
  chunkText: string,
): Promise<void> {
  const db = await openDb();
  const key = buildKey(bookId, chapterIndex, chunkText);

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(TTS_AUDIO_STORE, 'readwrite');
    const store = tx.objectStore(TTS_AUDIO_STORE);
    store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('删除 TTS 音频失败'));
  });
}

export async function clearBookTtsAudio(bookId: string): Promise<void> {
  const db = await openDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(TTS_AUDIO_STORE, 'readwrite');
    const store = tx.objectStore(TTS_AUDIO_STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const entry = cursor.value as StoredTtsAudioEntry | undefined;
      if (entry?.bookId === bookId) {
        cursor.delete();
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('清除书籍 TTS 音频失败'));
  });
}

export async function clearAllTtsAudio(): Promise<void> {
  const db = await openDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(TTS_AUDIO_STORE, 'readwrite');
    const store = tx.objectStore(TTS_AUDIO_STORE);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('清除所有 TTS 音频失败'));
  });
}

// ─── Chapter Cache Query ───

export async function getChapterCachedChunkTexts(
  bookId: string,
  chapterIndex: number,
): Promise<Set<string>> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const texts = new Set<string>();
    const tx = db.transaction(TTS_AUDIO_STORE, 'readonly');
    const store = tx.objectStore(TTS_AUDIO_STORE);
    const request = store.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const entry = cursor.value as StoredTtsAudioEntry | undefined;
      if (entry && entry.bookId === bookId && entry.chapterIndex === chapterIndex && entry.audioBlob instanceof Blob) {
        texts.add(entry.chunkText);
      }
      cursor.continue();
    };

    tx.oncomplete = () => resolve(texts);
    tx.onerror = () => reject(tx.error || new Error('查询章节 TTS 缓存失败'));
  });
}

// ─── Storage Usage ───

export async function getTtsAudioStorageUsageBytes(): Promise<{ totalBytes: number; byBook: Record<string, number> }> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const byBook: Record<string, number> = {};
    const tx = db.transaction(TTS_AUDIO_STORE, 'readonly');
    const store = tx.objectStore(TTS_AUDIO_STORE);
    const request = store.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const entry = cursor.value as StoredTtsAudioEntry | undefined;
      if (entry?.audioBlob instanceof Blob) {
        const size = entry.audioBlob.size;
        totalBytes += size;
        if (entry.bookId) {
          byBook[entry.bookId] = (byBook[entry.bookId] || 0) + size;
        }
      }
      cursor.continue();
    };

    tx.oncomplete = () => resolve({ totalBytes, byBook });
    tx.onerror = () => reject(tx.error || new Error('计算 TTS 音频用量失败'));
  });
}

// ─── Archive Export / Import ───

export async function exportTtsAudioForArchive(): Promise<Record<string, { audio: string; meta: Omit<StoredTtsAudioEntry, 'audioBlob' | 'key'> }>> {
  const db = await openDb();

  const entries: Array<{ key: string; entry: StoredTtsAudioEntry }> = await new Promise((resolve, reject) => {
    const results: Array<{ key: string; entry: StoredTtsAudioEntry }> = [];
    const tx = db.transaction(TTS_AUDIO_STORE, 'readonly');
    const store = tx.objectStore(TTS_AUDIO_STORE);
    const request = store.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const entry = cursor.value as StoredTtsAudioEntry;
      if (entry?.audioBlob instanceof Blob) {
        results.push({ key: cursor.key as string, entry });
      }
      cursor.continue();
    };

    tx.oncomplete = () => resolve(results);
    tx.onerror = () => reject(tx.error || new Error('导出 TTS 音频失败'));
  });

  const result: Record<string, { audio: string; meta: Omit<StoredTtsAudioEntry, 'audioBlob' | 'key'> }> = {};

  for (const { key, entry } of entries) {
    const arrayBuffer = await entry.audioBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    const { audioBlob: _, key: _k, ...meta } = entry;
    result[key] = { audio: base64, meta };
  }

  return result;
}

export async function restoreTtsAudioFromArchive(
  data: Record<string, unknown>,
): Promise<void> {
  if (!data || typeof data !== 'object') return;

  const db = await openDb();

  // Clear existing audio first
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(TTS_AUDIO_STORE, 'readwrite');
    tx.objectStore(TTS_AUDIO_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as { audio?: string; meta?: Record<string, unknown> };
    if (typeof record.audio !== 'string' || !record.meta) continue;

    try {
      const binary = atob(record.audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const audioBlob = new Blob([bytes], { type: 'audio/mpeg' });

      const entry: StoredTtsAudioEntry = {
        key,
        audioBlob,
        textHash: typeof record.meta.textHash === 'string' ? record.meta.textHash : '',
        createdAt: typeof record.meta.createdAt === 'number' ? record.meta.createdAt : Date.now(),
        chunkText: typeof record.meta.chunkText === 'string' ? record.meta.chunkText : '',
        provider: typeof record.meta.provider === 'string' ? record.meta.provider : '',
        voiceId: typeof record.meta.voiceId === 'string' ? record.meta.voiceId : '',
        model: typeof record.meta.model === 'string' ? record.meta.model : '',
        bookId: typeof record.meta.bookId === 'string' ? record.meta.bookId : '',
        chapterIndex: typeof record.meta.chapterIndex === 'number' ? record.meta.chapterIndex : 0,
      };

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(TTS_AUDIO_STORE, 'readwrite');
        tx.objectStore(TTS_AUDIO_STORE).put(entry, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Skip corrupted entries
    }
  }
}
