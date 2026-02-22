import type { TtsConfig, TtsProvider, MiniMaxRegion } from '../types';

// ─── Default configs ───

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  provider: 'OPENAI_TTS',
  endpoint: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'tts-1',
  voiceId: 'alloy',
  speed: 1.0,
  chunkSize: 2000,
};

export const TTS_PROVIDER_DEFS: {
  key: TtsProvider;
  label: string;
  defaultEndpoint: string;
  defaultModel: string;
}[] = [
  { key: 'OPENAI_TTS', label: 'OpenAI TTS', defaultEndpoint: 'https://api.openai.com/v1', defaultModel: 'tts-1' },
  { key: 'MINIMAX_T2A', label: 'MiniMax T2A', defaultEndpoint: 'https://api.minimax.chat/v1', defaultModel: 'speech-2.6-hd' },
  { key: 'ELEVENLABS', label: 'ElevenLabs', defaultEndpoint: 'https://api.elevenlabs.io', defaultModel: 'eleven_multilingual_v2' },
  { key: 'CUSTOM_TTS', label: '自定义 TTS', defaultEndpoint: '', defaultModel: '' },
];

export const MINIMAX_REGION_ENDPOINTS: Record<MiniMaxRegion, string> = {
  cn: 'https://api.minimax.chat/v1',
  intl: 'https://api.minimax.io/v1',
};

export const OPENAI_TTS_VOICES = [
  { value: 'alloy', label: 'Alloy' },
  { value: 'echo', label: 'Echo' },
  { value: 'fable', label: 'Fable' },
  { value: 'onyx', label: 'Onyx' },
  { value: 'nova', label: 'Nova' },
  { value: 'shimmer', label: 'Shimmer' },
];

export const MINIMAX_TTS_VOICES = [
  { value: 'male-qn-qingse', label: '青涩青年音' },
  { value: 'female-shaonv', label: '少女音' },
  { value: 'male-qn-jingying', label: '精英青年音' },
  { value: 'female-yujie', label: '御姐音' },
  { value: 'male-qn-badao', label: '霸道青年音' },
  { value: 'female-chengshu', label: '成熟女声' },
];

// ─── Validation ───

export function validateTtsConfig(config: TtsConfig): string | null {
  const apiKey = (config.apiKey || '').trim();
  const model = (config.model || '').trim();
  const voiceId = (config.voiceId || '').trim();
  if (!apiKey) return '请先设置 TTS API Key';
  if (!model) return '请先设置 TTS 模型';
  if (!voiceId) return config.provider === 'MINIMAX_T2A' ? '请先设置 Voice ID' : '请先设置语音 ID';
  if (config.provider !== 'MINIMAX_T2A' && !(config.endpoint || '').trim()) return '请先设置 TTS API 地址';
  // China region requires GroupId; international does not
  if (config.provider === 'MINIMAX_T2A' && config.minimaxRegion !== 'intl' && !(config.groupId || '').trim()) {
    return '请先设置 MiniMax Group ID（国内版必填）';
  }
  return null;
}

// ─── Provider adapters ───

async function parseResponseError(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      const msg = json?.error?.message || json?.base_resp?.status_msg || json?.message || json?.detail;
      if (msg) return `${fallback}: ${msg}`;
    } catch { /* not json */ }
    if (text.length > 0 && text.length < 500) return `${fallback}: ${text}`;
  } catch { /* ignore */ }
  return `${fallback} (HTTP ${response.status})`;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

async function callOpenAiTts(text: string, config: TtsConfig, signal?: AbortSignal): Promise<Blob> {
  const endpoint = (config.endpoint || '').trim().replace(/\/+$/, '');
  const response = await fetch(`${endpoint}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model.trim(),
      input: text,
      voice: config.voiceId.trim(),
      speed: config.speed,
    }),
    signal,
  });
  if (!response.ok) throw new Error(await parseResponseError(response, 'OpenAI TTS 请求失败'));
  return response.blob();
}

async function callMiniMaxTts(text: string, config: TtsConfig, signal?: AbortSignal): Promise<Blob> {
  const groupId = (config.groupId || '').trim();
  const model = config.model.trim() || 'speech-2.6-hd';
  const region = config.minimaxRegion || 'cn';
  const base = (config.endpoint || MINIMAX_REGION_ENDPOINTS[region]).trim().replace(/\/+$/, '');
  const voiceId = (config.voiceId || '').trim();

  // All models use t2a_v2 endpoint; China region passes GroupId as query param
  const url = groupId
    ? `${base}/t2a_v2?GroupId=${encodeURIComponent(groupId)}`
    : `${base}/t2a_v2`;

  // Both regions use the same request body format (official docs)
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      text,
      voice_setting: {
        voice_id: voiceId,
        speed: config.speed,
        vol: 1.0,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
      },
      ...(config.language ? { language_boost: config.language } : {}),
    }),
    signal,
  });
  if (!response.ok) throw new Error(await parseResponseError(response, 'MiniMax TTS 请求失败'));

  const data = await response.json();

  // Check for API-level error
  if (data?.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax TTS 错误: ${data.base_resp.status_msg || '未知错误'} (code: ${data.base_resp.status_code})`);
  }

  // Audio is hex-encoded in data.audio (both regions)
  const audioHex =
    data?.data?.audio ||
    data?.audio_file ||
    data?.audio ||
    (typeof data?.data === 'string' ? data.data : null);

  if (!audioHex || typeof audioHex !== 'string') {
    const keys = JSON.stringify(Object.keys(data || {}));
    const dataKeys = data?.data ? JSON.stringify(Object.keys(data.data)) : 'N/A';
    throw new Error(`MiniMax TTS 返回数据中缺少音频数据。响应结构: ${keys}, data 子字段: ${dataKeys}`);
  }

  // Decode hex string to bytes
  const isHex = /^[0-9a-fA-F]+$/.test(audioHex) && audioHex.length % 2 === 0;
  let bytes: Uint8Array;

  if (isHex) {
    bytes = new Uint8Array(audioHex.length / 2);
    for (let i = 0; i < audioHex.length; i += 2) {
      bytes[i / 2] = parseInt(audioHex.substring(i, i + 2), 16);
    }
  } else {
    // Fallback: try base64 decoding for compatibility
    const binary = atob(audioHex);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: 'audio/mpeg' });
}

async function callElevenLabsTts(text: string, config: TtsConfig, signal?: AbortSignal): Promise<Blob> {
  const endpoint = (config.endpoint || '').trim().replace(/\/+$/, '');
  const voiceId = config.voiceId.trim();
  const url = `${endpoint}/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': config.apiKey.trim(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: config.model.trim() || 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      ...(config.language ? { language_code: config.language } : {}),
    }),
    signal,
  });
  if (!response.ok) throw new Error(await parseResponseError(response, 'ElevenLabs TTS 请求失败'));
  return response.blob();
}

async function callCustomTts(text: string, config: TtsConfig, signal?: AbortSignal): Promise<Blob> {
  const endpoint = (config.endpoint || '').trim().replace(/\/+$/, '');
  if (!endpoint) throw new Error('自定义 TTS 未设置 API 地址');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model.trim(),
      input: text,
      voice: config.voiceId.trim(),
      speed: config.speed,
      ...(config.language ? { language: config.language } : {}),
    }),
    signal,
  });
  if (!response.ok) throw new Error(await parseResponseError(response, '自定义 TTS 请求失败'));
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await response.json();
    const audioBase64 = data?.data?.audio || data?.audio;
    if (audioBase64 && typeof audioBase64 === 'string') {
      const binary = atob(audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: 'audio/mpeg' });
    }
    throw new Error('自定义 TTS JSON 响应中缺少 audio 字段');
  }
  return response.blob();
}

// ─── Main entry ───

export async function callTtsApi(text: string, config: TtsConfig, signal?: AbortSignal): Promise<Blob> {
  throwIfAborted(signal);
  switch (config.provider) {
    case 'OPENAI_TTS': return callOpenAiTts(text, config, signal);
    case 'MINIMAX_T2A': return callMiniMaxTts(text, config, signal);
    case 'ELEVENLABS': return callElevenLabsTts(text, config, signal);
    case 'CUSTOM_TTS': return callCustomTts(text, config, signal);
    default: throw new Error(`未知 TTS 服务商: ${config.provider}`);
  }
}
