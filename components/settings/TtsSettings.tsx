import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  Globe,
  Key,
  Cpu,
  RefreshCw,
  Plus,
  Trash2,
  Edit2,
  X,
  Server,
  ChevronDown,
  Check,
  Play,
  Loader2,
  Volume2,
  AlertTriangle,
  Zap,
  Hash,
  Eye,
  EyeOff,
} from 'lucide-react';
import { TtsConfig, TtsPreset } from './types';
import type { TtsProvider, MiniMaxRegion } from '../../types';
import {
  DEFAULT_TTS_CONFIG,
  TTS_PROVIDER_DEFS,
  OPENAI_TTS_VOICES,
  MINIMAX_TTS_VOICES,
  MINIMAX_REGION_ENDPOINTS,
  validateTtsConfig,
  callTtsApi,
} from '../../utils/ttsEngine';
import ModalPortal from '../ModalPortal';

interface TtsSettingsProps {
  config: TtsConfig;
  setConfig: React.Dispatch<React.SetStateAction<TtsConfig>>;
  presets: TtsPreset[];
  setPresets: React.Dispatch<React.SetStateAction<TtsPreset[]>>;
  theme: {
    containerClass: string;
    headingClass: string;
    cardClass: string;
    pressedClass: string;
    inputClass: string;
    btnClass: string;
    activeBorderClass: string;
    baseBorderClass: string;
    isDarkMode: boolean;
  };
  onBack: () => void;
}

// --- Internal Component: SingleSelectDropdown (matching ApiSettings) ---

interface OptionItem {
  value: string;
  label: string;
  icon?: any;
}

const SingleSelectDropdown = ({
  options,
  value,
  onChange,
  placeholder = '选择...',
  inputClass,
  cardClass,
  isDarkMode,
  disabled = false,
}: {
  options: OptionItem[];
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  inputClass: string;
  cardClass: string;
  isDarkMode: boolean;
  disabled?: boolean;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClose = () => {
    if (!isOpen || isClosing) return;
    setIsClosing(true);
    setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
    }, 200);
  };

  const handleToggle = () => {
    if (isOpen) { handleClose(); } else { setIsOpen(true); }
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        handleClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, isClosing]);

  const selectedOption = options.find(o => o.value === value) || (value ? { value, label: value } : null);

  return (
    <div className={`relative ${disabled ? 'opacity-50 pointer-events-none' : ''}`} ref={containerRef}>
      <div
        onClick={handleToggle}
        className={`w-full p-2 min-h-[42px] rounded-xl flex items-center justify-between cursor-pointer transition-all active:scale-[0.99] ${inputClass}`}
      >
        <div className="flex items-center gap-2 px-2">
          {selectedOption ? (
            <>
              {(selectedOption as any).icon && React.createElement((selectedOption as any).icon, { size: 16, className: 'text-rose-400' })}
              <span className={`text-sm font-medium truncate ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
                {selectedOption.label}
              </span>
            </>
          ) : (
            <span className="text-sm opacity-50">{placeholder}</span>
          )}
        </div>
        <div className="opacity-50 pr-2">
          <ChevronDown size={16} className={`transition-transform duration-200 ${isOpen && !isClosing ? 'rotate-180' : ''}`} />
        </div>
      </div>
      {(isOpen || isClosing) && (
        <div className={`absolute top-full left-0 right-0 mt-2 p-2 rounded-xl z-[50] max-h-60 overflow-y-auto ${cardClass} border border-slate-400/10 shadow-2xl ${isClosing ? 'reader-flyout-exit' : 'reader-flyout-enter'}`}>
          {options.length > 0 ? options.map(opt => {
            const isSelected = opt.value === value;
            return (
              <div
                key={opt.value}
                onClick={() => { onChange(opt.value); handleClose(); }}
                className={`flex items-center gap-2 p-2 rounded-lg text-sm cursor-pointer transition-colors ${
                  isSelected
                    ? 'text-rose-400 font-bold bg-rose-400/10'
                    : isDarkMode ? 'text-slate-300 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-200'
                }`}
              >
                <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${isSelected ? 'bg-rose-400 border-rose-400' : 'border-slate-400'}`}>
                  {isSelected && <Check size={10} className="text-white" />}
                </div>
                {opt.icon && React.createElement(opt.icon, { size: 16, className: isSelected ? 'text-rose-400' : 'text-slate-400' })}
                <span className="truncate">{opt.label}</span>
              </div>
            );
          }) : (
            <div className="p-2 text-xs text-slate-400 text-center">无可用选项</div>
          )}
        </div>
      )}
    </div>
  );
};

// --- Provider icons ---

const TTS_PROVIDERS: { key: TtsProvider; label: string; icon: any }[] = [
  { key: 'OPENAI_TTS', label: 'OpenAI TTS', icon: Volume2 },
  { key: 'MINIMAX_T2A', label: 'MiniMax T2A', icon: Volume2 },
  { key: 'ELEVENLABS', label: 'ElevenLabs', icon: Volume2 },
  { key: 'CUSTOM_TTS', label: '自定义 TTS', icon: Server },
];

// --- Model fetch support ---

const TTS_MODEL_CACHE_KEY = 'app_tts_models_cache_v1';

interface TtsModelCacheEntry {
  models: string[];
  updatedAt: number;
}

type TtsModelCacheStore = Record<string, TtsModelCacheEntry>;

const buildTtsModelCacheKey = (provider: TtsProvider, endpoint: string, apiKey: string): string => {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) return '';
  const normalizedEndpoint = (endpoint || '').trim().replace(/\/+$/, '') || 'default';
  let hash = 2166136261;
  for (let i = 0; i < normalizedApiKey.length; i++) {
    hash ^= normalizedApiKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${provider}::${normalizedEndpoint}::${(hash >>> 0).toString(36)}`;
};

const safeReadTtsModelCache = (): TtsModelCacheStore => {
  try {
    const raw = localStorage.getItem(TTS_MODEL_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const normalized: TtsModelCacheStore = {};
    Object.entries(parsed).forEach(([key, value]) => {
      if (!key || !value || typeof value !== 'object') return;
      const entry = value as Partial<TtsModelCacheEntry>;
      const models = Array.isArray(entry.models) ? entry.models.filter(Boolean) : [];
      if (models.length === 0) return;
      normalized[key] = { models, updatedAt: Number(entry.updatedAt) || Date.now() };
    });
    return normalized;
  } catch { return {}; }
};

const safeSaveTtsModelCache = (store: TtsModelCacheStore) => {
  try { localStorage.setItem(TTS_MODEL_CACHE_KEY, JSON.stringify(store)); } catch {}
};

// --- Main Component ---

const TtsSettings: React.FC<TtsSettingsProps> = ({ config, setConfig, presets, setPresets, theme, onBack }) => {
  const { cardClass, inputClass, btnClass, pressedClass, headingClass, isDarkMode, activeBorderClass, baseBorderClass } = theme;

  // Model fetch state
  const [isFetching, setIsFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState<'IDLE' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [errorModal, setErrorModal] = useState<{ open: boolean; message: string }>({ open: false, message: '' });

  // Test state
  const [isTesting, setIsTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState(false);
  const testAbortRef = useRef<AbortController | null>(null);

  // Preset state
  const [isPresetModalOpen, setIsPresetModalOpen] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState('');
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  const normalizedEndpoint = (config.endpoint || '').trim().replace(/\/+$/, '');
  const modelCacheKey = buildTtsModelCacheKey(config.provider, normalizedEndpoint, config.apiKey);

  // Load cached models on provider/endpoint/key change
  useEffect(() => {
    if (!modelCacheKey) {
      setAvailableModels([]);
      setFetchStatus('IDLE');
      return;
    }
    const cacheEntry = safeReadTtsModelCache()[modelCacheKey];
    if (!cacheEntry || cacheEntry.models.length === 0) {
      setAvailableModels([]);
      setFetchStatus('IDLE');
      return;
    }
    setAvailableModels(cacheEntry.models);
    setFetchStatus('SUCCESS');
  }, [modelCacheKey]);

  const providerDef = TTS_PROVIDER_DEFS.find(p => p.key === config.provider) || TTS_PROVIDER_DEFS[0];

  const handleProviderChange = (val: string) => {
    const key = val as TtsProvider;
    const def = TTS_PROVIDER_DEFS.find(p => p.key === key);
    if (!def) return;
    setConfig(prev => ({
      ...prev,
      provider: key,
      endpoint: def.defaultEndpoint,
      model: def.defaultModel,
      voiceId: key === 'OPENAI_TTS' ? 'alloy' : prev.voiceId,
      groupId: key === 'MINIMAX_T2A' ? prev.groupId : undefined,
      minimaxRegion: key === 'MINIMAX_T2A' ? (prev.minimaxRegion || 'cn') : undefined,
    }));
    setFetchStatus('IDLE');
    setAvailableModels([]);
  };

  const handleMiniMaxRegionChange = (val: string) => {
    const region = val as MiniMaxRegion;
    setConfig(prev => ({
      ...prev,
      minimaxRegion: region,
      endpoint: MINIMAX_REGION_ENDPOINTS[region],
    }));
  };

  // MiniMax predefined models (no models list API available)
  const MINIMAX_MODELS = [
    { value: 'speech-2.8-hd', label: 'speech-2.8-hd' },
    { value: 'speech-2.8-turbo', label: 'speech-2.8-turbo' },
    { value: 'speech-2.6-hd', label: 'speech-2.6-hd' },
    { value: 'speech-2.6-turbo', label: 'speech-2.6-turbo' },
    { value: 'speech-02-hd', label: 'speech-02-hd' },
    { value: 'speech-02-turbo', label: 'speech-02-turbo' },
    { value: 'speech-01-hd', label: 'speech-01-hd' },
    { value: 'speech-01-turbo', label: 'speech-01-turbo' },
  ];

  const isMiniMax = config.provider === 'MINIMAX_T2A';

  const fetchModels = async () => {
    if (isMiniMax) return; // MiniMax uses predefined list, no fetch needed
    if (!config.apiKey) {
      setErrorModal({ open: true, message: '请先输入 API Key' });
      setFetchStatus('ERROR');
      return;
    }
    setIsFetching(true);
    setFetchStatus('IDLE');
    try {
      let models: string[] = [];
      const endpoint = normalizedEndpoint;

      if (config.provider === 'OPENAI_TTS' || config.provider === 'CUSTOM_TTS') {
        const url = endpoint ? `${endpoint}/models` : 'https://api.openai.com/v1/models';
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${config.apiKey.trim()}`,
            'Content-Type': 'application/json',
          },
        });
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();
        if (Array.isArray(data.data)) {
          models = data.data.map((m: any) => m.id).filter((id: string) => id.includes('tts'));
        }
        if (models.length === 0 && Array.isArray(data.data)) {
          models = data.data.map((m: any) => m.id);
        }
      } else if (config.provider === 'ELEVENLABS') {
        const url = `${endpoint}/v1/models`;
        const response = await fetch(url, {
          headers: { 'xi-api-key': config.apiKey.trim() },
        });
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();
        if (Array.isArray(data)) {
          models = data.map((m: any) => m.model_id);
        }
      }

      const normalizedModels = Array.from(new Set(models.map(m => m.trim()).filter(Boolean)));

      if (normalizedModels.length === 0) {
        throw new Error('API 返回了空模型列表');
      }

      if (modelCacheKey) {
        const store = safeReadTtsModelCache();
        store[modelCacheKey] = { models: normalizedModels, updatedAt: Date.now() };
        safeSaveTtsModelCache(store);
      }

      setAvailableModels(normalizedModels);
      setFetchStatus('SUCCESS');
      if (!config.model && normalizedModels.length > 0) {
        setConfig(prev => ({ ...prev, model: normalizedModels[0] }));
      }
    } catch (err: any) {
      console.error(err);
      setFetchStatus('ERROR');
      let msg = err.message;
      if (msg === 'Failed to fetch') {
        msg = '网络请求失败 (CORS Error)。\n请检查您的网络或使用允许跨域的代理地址。';
      }
      setErrorModal({ open: true, message: msg });
    } finally {
      setIsFetching(false);
    }
  };

  const voiceOptions = config.provider === 'OPENAI_TTS'
    ? OPENAI_TTS_VOICES
    : config.provider === 'MINIMAX_T2A'
      ? MINIMAX_TTS_VOICES
      : null;

  const handleTest = async () => {
    const err = validateTtsConfig(config);
    if (err) { setTestError(err); return; }
    setIsTesting(true);
    setTestError(null);
    setTestSuccess(false);
    testAbortRef.current?.abort();
    const abort = new AbortController();
    testAbortRef.current = abort;
    try {
      const blob = await callTtsApi('测试语音合成，一二三四五。', config, abort.signal);
      if (blob && blob.size > 0) {
        setTestSuccess(true);
        setTimeout(() => setTestSuccess(false), 3000);
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setTestError(e instanceof Error ? e.message : 'TTS 测试失败');
      }
    } finally {
      setIsTesting(false);
    }
  };

  // Preset handlers
  const openSavePresetModal = () => {
    const providerLabel = TTS_PROVIDERS.find(p => p.key === config.provider)?.label;
    setPresetNameInput(`${providerLabel} - ${config.model || 'Default'}`);
    setEditingPresetId(null);
    setIsPresetModalOpen(true);
  };

  const savePreset = () => {
    if (!presetNameInput.trim()) return;
    if (editingPresetId) {
      setPresets(prev => prev.map(p => p.id === editingPresetId ? { ...p, name: presetNameInput } : p));
    } else {
      setPresets(prev => [...prev, { id: Date.now().toString(), name: presetNameInput, config: { ...config } }]);
    }
    setIsPresetModalOpen(false);
  };

  const loadPreset = (preset: TtsPreset) => {
    setConfig({ ...DEFAULT_TTS_CONFIG, ...preset.config });
    const presetCacheKey = buildTtsModelCacheKey(preset.config.provider, preset.config.endpoint, preset.config.apiKey);
    if (!presetCacheKey) {
      setFetchStatus('IDLE');
      setAvailableModels([]);
      return;
    }
    const cacheEntry = safeReadTtsModelCache()[presetCacheKey];
    if (!cacheEntry || cacheEntry.models.length === 0) {
      setFetchStatus('IDLE');
      setAvailableModels([]);
      return;
    }
    setFetchStatus('SUCCESS');
    setAvailableModels(cacheEntry.models);
  };

  const deletePreset = (id: string) => {
    setPresets(prev => prev.filter(p => p.id !== id));
  };

  const startRenamePreset = (preset: TtsPreset) => {
    setPresetNameInput(preset.name);
    setEditingPresetId(preset.id);
    setIsPresetModalOpen(true);
  };

  // Slider progress helper

  const chunkProgress = ((config.chunkSize - 500) / 3500) * 100;

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="mb-6 pt-2 flex items-center gap-4">
        <button onClick={onBack} className={`w-10 h-10 rounded-full flex items-center justify-center hover:text-rose-400 transition-colors active:scale-95 ${btnClass}`}>
          <ArrowLeft size={20} />
        </button>
        <h1 className={`text-2xl font-bold ${headingClass}`}>TTS 语音</h1>
      </header>

      {/* Main Configuration Card */}
      <div className={`${cardClass} p-5 rounded-2xl flex flex-col gap-5 z-20`}>
        {/* Provider Selection - Dropdown */}
        <div className="z-30 relative">
          <label className="text-xs font-bold text-slate-400 uppercase tracking-wider ml-1 mb-2 block">服务商</label>
          <SingleSelectDropdown
            options={TTS_PROVIDERS.map(p => ({ value: p.key, label: p.label, icon: p.icon }))}
            value={config.provider}
            onChange={handleProviderChange}
            placeholder="选择服务商..."
            inputClass={inputClass}
            cardClass={cardClass}
            isDarkMode={isDarkMode}
          />
        </div>

        {/* MiniMax: Region Selector + Endpoint display + Group ID */}
        {isMiniMax && (
          <>
            {/* Region selector */}
            <div className="z-20 relative">
              <label className="text-xs font-bold text-slate-400 uppercase tracking-wider ml-1 mb-2 block flex items-center gap-2">
                <Globe size={14} /> 服务地区
              </label>
              <SingleSelectDropdown
                options={[
                  { value: 'cn', label: '国内版 (minimaxi.chat)' },
                  { value: 'intl', label: '国际版 (minimax.io)' },
                ]}
                value={config.minimaxRegion || 'cn'}
                onChange={handleMiniMaxRegionChange}
                placeholder="选择地区..."
                inputClass={inputClass}
                cardClass={cardClass}
                isDarkMode={isDarkMode}
              />
            </div>

            {/* Endpoint - editable, auto-filled by region change */}
            <div>
              <label className="text-xs font-bold text-slate-400 uppercase tracking-wider ml-1 mb-2 block flex items-center gap-2">
                <Globe size={14} /> API 地址
              </label>
              <input
                type="text"
                value={config.endpoint}
                onChange={e => setConfig(prev => ({ ...prev, endpoint: e.target.value }))}
                placeholder={MINIMAX_REGION_ENDPOINTS[config.minimaxRegion || 'cn']}
                className={`w-full h-[42px] px-4 rounded-xl text-sm outline-none ${inputClass}`}
              />
            </div>

            {/* Group ID - required for China, optional for international */}
            <div>
              <label className="text-xs font-bold text-slate-400 uppercase tracking-wider ml-1 mb-2 block flex items-center gap-2">
                <Hash size={14} /> Group ID
                {config.minimaxRegion === 'intl' && <span className="text-[10px] font-normal normal-case tracking-normal text-slate-400/60">（国际版选填）</span>}
              </label>
              <input
                type="text"
                value={config.groupId || ''}
                onChange={e => setConfig(prev => ({ ...prev, groupId: e.target.value }))}
                placeholder={config.minimaxRegion === 'intl' ? '国际版可留空' : '输入 MiniMax Group ID'}
                className={`w-full h-[42px] px-4 rounded-xl text-sm outline-none ${inputClass}`}
              />
            </div>
          </>
        )}

        {/* Endpoint - for non-MiniMax providers */}
        {!isMiniMax && (
          <div>
            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider ml-1 mb-2 block flex items-center gap-2">
              <Globe size={14} /> API 地址 (Endpoint)
            </label>
            <input
              type="text"
              value={config.endpoint}
              onChange={e => setConfig(prev => ({ ...prev, endpoint: e.target.value }))}
              placeholder={providerDef.defaultEndpoint || 'https://...'}
              className={`w-full h-[42px] px-4 rounded-xl text-sm outline-none ${inputClass}`}
            />
          </div>
        )}

        {/* API Key */}
        <div>
          <label className="text-xs font-bold text-slate-400 uppercase tracking-wider ml-1 mb-2 block flex items-center gap-2">
            <Key size={14} /> API 密钥 (Key)
          </label>
          <div className="relative">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={config.apiKey}
              onChange={e => setConfig(prev => ({ ...prev, apiKey: e.target.value }))}
              placeholder={config.provider === 'ELEVENLABS' ? 'xi-...' : 'sk-...'}
              className={`w-full h-[42px] px-4 pr-10 rounded-xl text-sm outline-none ${inputClass}`}
            />
            <button
              type="button"
              onClick={() => setShowApiKey(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
            >
              {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        {/* Voice ID - for MiniMax show as text input; for OpenAI show dropdown; for others text input */}
        <div className="z-10 relative">
          <label className="text-xs font-bold text-slate-400 uppercase tracking-wider ml-1 mb-2 block flex items-center gap-2">
            <Volume2 size={14} /> {isMiniMax ? 'Voice ID' : '语音 (Voice)'}
          </label>
          {isMiniMax ? (
            <input
              type="text"
              value={config.voiceId}
              onChange={e => setConfig(prev => ({ ...prev, voiceId: e.target.value }))}
              placeholder="ttv-voice-2025112706124025-DDcKFsc8"
              className={`w-full h-[42px] px-4 rounded-xl text-sm outline-none ${inputClass}`}
            />
          ) : voiceOptions ? (
            <SingleSelectDropdown
              options={voiceOptions}
              value={config.voiceId}
              onChange={val => setConfig(prev => ({ ...prev, voiceId: val }))}
              placeholder="选择语音"
              inputClass={inputClass}
              cardClass={cardClass}
              isDarkMode={isDarkMode}
            />
          ) : (
            <input
              type="text"
              value={config.voiceId}
              onChange={e => setConfig(prev => ({ ...prev, voiceId: e.target.value }))}
              placeholder="输入语音 ID"
              className={`w-full h-[42px] px-4 rounded-xl text-sm outline-none ${inputClass}`}
            />
          )}
        </div>

        {/* Model Selection */}
        <div className="z-20 relative">
          <div className="flex items-center justify-between mb-2 ml-1">
            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
              <Cpu size={14} /> 模型 (Model)
            </label>
            {/* Fetch button - only for non-MiniMax providers (MiniMax has no models API) */}
            {!isMiniMax && (
              <div className="flex items-center gap-2">
                <div className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${
                  fetchStatus === 'SUCCESS' ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' :
                  fetchStatus === 'ERROR' ? 'bg-red-500 shadow-[0_0_8px_#ef4444]' :
                  isFetching ? 'bg-amber-400 animate-pulse' : 'bg-slate-300'
                }`} />
                <button
                  onClick={fetchModels}
                  disabled={isFetching}
                  className={`text-[10px] font-bold px-2 py-1 rounded-lg flex items-center gap-1 hover:text-rose-400 disabled:opacity-50 ${btnClass}`}
                >
                  <RefreshCw size={10} className={isFetching ? 'animate-spin' : ''} />
                  {isFetching ? '拉取中...' : '拉取模型'}
                </button>
              </div>
            )}
          </div>

          {isMiniMax ? (
            /* MiniMax: predefined model list (no models API available) */
            <SingleSelectDropdown
              options={MINIMAX_MODELS}
              value={config.model}
              onChange={val => setConfig(prev => ({ ...prev, model: val }))}
              placeholder="选择模型..."
              inputClass={inputClass}
              cardClass={cardClass}
              isDarkMode={isDarkMode}
            />
          ) : (
            <>
              <SingleSelectDropdown
                options={availableModels.map(m => ({ value: m, label: m }))}
                value={config.model}
                onChange={val => setConfig(prev => ({ ...prev, model: val }))}
                placeholder={availableModels.length > 0 ? '选择模型...' : '请点击右上角拉取...'}
                inputClass={inputClass}
                cardClass={cardClass}
                isDarkMode={isDarkMode}
              />
              {/* Fallback manual input */}
              {availableModels.length === 0 && !isFetching && (
                <div className="mt-2 text-right">
                  <input
                    type="text"
                    value={config.model}
                    onChange={e => setConfig(prev => ({ ...prev, model: e.target.value }))}
                    placeholder="或手动输入模型 ID"
                    className={`text-xs px-2 py-1 bg-transparent border-b border-slate-300/30 outline-none text-right w-1/2 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Chunk Size Slider */}
        <div>
          <div className="flex items-center justify-between mb-2 ml-1">
            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">每次生成字数</label>
            <span className={`text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{config.chunkSize} 字</span>
          </div>
          <div className="relative h-2">
            <div className={`absolute inset-0 rounded-full ${isDarkMode ? 'bg-slate-700' : 'bg-black/5'}`} />
            <div className="absolute inset-y-0 left-0 rounded-full bg-rose-300" style={{ width: `${chunkProgress}%` }} />
            <input
              type="range"
              min="500"
              max="4000"
              step="100"
              value={config.chunkSize}
              onChange={e => setConfig(prev => ({ ...prev, chunkSize: parseInt(e.target.value) }))}
              className="app-range absolute top-1/2 -translate-y-1/2 left-0 w-full h-5 bg-transparent appearance-none cursor-pointer z-10"
            />
          </div>
        </div>

        {/* Test Button */}
        <button
          onClick={handleTest}
          disabled={isTesting || testSuccess}
          className={`w-full py-4 rounded-xl text-sm font-bold flex items-center justify-center gap-2 mt-2 active:scale-[0.98] disabled:opacity-50 transition-colors duration-300 ${
            testSuccess ? 'text-emerald-500' : 'text-rose-400'
          } ${btnClass}`}
        >
          <span className="relative w-[18px] h-[18px] flex items-center justify-center">
            <Play size={18} className={`absolute inset-0 transition-all duration-300 ${isTesting || testSuccess ? 'opacity-0 scale-50' : 'opacity-100 scale-100'}`} />
            <Loader2 size={18} className={`absolute inset-0 animate-spin transition-all duration-300 ${isTesting ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`} />
            <Check size={18} className={`absolute inset-0 transition-all duration-300 ${testSuccess ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`} />
          </span>
          {testSuccess ? '连接成功' : isTesting ? '测试中...' : '测试语音'}
        </button>
        {testError && (
          <div className="text-xs text-red-400 mt-1 px-1">{testError}</div>
        )}
      </div>

      {/* Presets Section */}
      <div className="flex flex-col gap-4 z-10">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">TTS 预设配置</h2>
          <button
            onClick={openSavePresetModal}
            className={`w-8 h-8 rounded-full flex items-center justify-center text-rose-400 ${btnClass}`}
          >
            <Plus size={16} />
          </button>
        </div>

        {presets.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-xs rounded-2xl border-2 border-dashed border-slate-300/20 opacity-50">
            暂无预设，点击右上角保存当前配置
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {presets.map(preset => {
              const isActive =
                preset.config.provider === config.provider &&
                preset.config.apiKey === config.apiKey &&
                preset.config.model === config.model;

              const providerInfo = TTS_PROVIDERS.find(p => p.key === preset.config.provider);
              const ProviderIcon = providerInfo?.icon || Server;

              return (
                <div
                  key={preset.id}
                  className={`${cardClass} neu-card-pressable p-4 rounded-2xl flex items-center justify-between group transition-all cursor-pointer ${isActive ? activeBorderClass : baseBorderClass}`}
                >
                  <div className="flex items-center gap-4 flex-1 min-w-0" onClick={() => loadPreset(preset)}>
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${isActive ? 'bg-rose-400 text-white' : `${pressedClass} text-slate-400`}`}>
                      <ProviderIcon size={20} />
                    </div>
                    <div className="min-w-0">
                      <div className={`font-bold text-sm ${headingClass} flex items-center gap-2`}>
                        <span className="truncate">{preset.name}</span>
                        {isActive && <span className="bg-emerald-400/20 text-emerald-500 text-[9px] px-1.5 py-0.5 rounded-md flex-shrink-0">ACTIVE</span>}
                      </div>
                      <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-2">
                        <span className="flex-shrink-0">{providerInfo?.label}</span>
                        <span>·</span>
                        <span className="font-mono opacity-70 truncate max-w-[100px]">{preset.config.model || '未指定'}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2 flex-shrink-0 ml-2">
                    <button onClick={() => startRenamePreset(preset)} className="p-2 text-slate-400 hover:text-slate-600 active:text-rose-400 transition-colors">
                      <Edit2 size={14} />
                    </button>
                    <button onClick={() => deletePreset(preset.id)} className="p-2 text-slate-400 hover:text-rose-500 active:text-rose-400 transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Preset Name Modal */}
      {isPresetModalOpen && (
        <ModalPortal>
          <div className="fixed inset-0 z-[100] grid place-items-center p-6 bg-slate-500/20 backdrop-blur-sm animate-fade-in">
            <div className={`${isDarkMode ? 'bg-[#2d3748] border-slate-600' : 'neu-bg border-white/50'} w-full max-w-sm rounded-2xl p-6 shadow-2xl border relative`}>
              <button onClick={() => setIsPresetModalOpen(false)} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600">
                <X size={20} />
              </button>
              <h3 className={`text-lg font-bold mb-6 text-center ${headingClass}`}>
                {editingPresetId ? '重命名预设' : '保存为预设'}
              </h3>
              <div className="flex flex-col gap-4">
                <input
                  autoFocus
                  type="text"
                  value={presetNameInput}
                  onChange={e => setPresetNameInput(e.target.value)}
                  placeholder="给预设起个名字..."
                  className={`w-full p-4 rounded-xl text-sm outline-none ${inputClass}`}
                  onKeyDown={e => e.key === 'Enter' && savePreset()}
                />
                <div className="flex gap-3 mt-2">
                  <button onClick={() => setIsPresetModalOpen(false)} className={`flex-1 py-3 rounded-full text-slate-500 text-sm font-bold ${btnClass}`}>
                    取消
                  </button>
                  <button
                    onClick={savePreset}
                    disabled={!presetNameInput.trim()}
                    className={`flex-1 py-3 rounded-full text-rose-400 text-sm font-bold disabled:opacity-50 ${btnClass}`}
                  >
                    确认
                  </button>
                </div>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* Error Modal */}
      {errorModal.open && (
        <ModalPortal>
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm animate-fade-in">
            <div className={`${cardClass} w-full max-w-xs rounded-2xl p-6 shadow-2xl border-2 border-red-100/10 relative flex flex-col items-center text-center`}>
              <div className={`w-12 h-12 rounded-full ${isDarkMode ? 'bg-red-500/20' : 'bg-red-100'} text-red-500 flex items-center justify-center mb-4`}>
                <AlertTriangle size={24} />
              </div>
              <h3 className={`text-lg font-bold mb-2 ${isDarkMode ? 'text-red-400' : 'text-red-500'}`}>
                拉取失败
              </h3>
              <p className="text-sm text-slate-500 whitespace-pre-wrap mb-6">
                {errorModal.message}
              </p>
              <button
                onClick={() => setErrorModal({ ...errorModal, open: false })}
                className="w-full py-3 rounded-full text-white bg-red-500 shadow-lg hover:bg-red-600 active:scale-95 transition-all font-bold text-sm"
              >
                关闭
              </button>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
};

export default TtsSettings;
