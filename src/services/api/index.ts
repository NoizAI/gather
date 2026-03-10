// Backend API Client
// Provides typed interfaces to communicate with the backend

// In dev mode with Vite proxy, use relative path. In production, use env var.
const API_BASE = import.meta.env.VITE_API_BASE || '/api';

// Common fetch options for all requests (includes credentials for cookie auth)
const fetchOptions: RequestInit = {
  credentials: 'include',
};

interface RequestOptions {
  apiKey?: string;
}

// ============ Session Expiry Handling ============

// Callback registered by AuthContext to handle session expiry (redirect to login)
let _onSessionExpired: (() => void) | null = null;

/**
 * Register a callback that fires when session is expired and cannot be refreshed.
 * Called by AuthContext on mount.
 */
export function onSessionExpired(callback: () => void) {
  _onSessionExpired = callback;
}

// Flag to prevent multiple concurrent refresh attempts
let _isRefreshing = false;
let _refreshPromise: Promise<boolean> | null = null;

/**
 * Try to refresh the access token via the refresh endpoint
 */
async function tryRefreshToken(): Promise<boolean> {
  // If already refreshing, wait for the existing attempt
  if (_isRefreshing && _refreshPromise) {
    return _refreshPromise;
  }

  _isRefreshing = true;
  _refreshPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      _isRefreshing = false;
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

/**
 * Wrapper around fetch that handles 401 errors by:
 * 1. Attempting to refresh the access token
 * 2. Retrying the original request once
 * 3. If refresh fails, triggering session expiry (redirect to login)
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);

  if (response.status === 401) {
    // Don't try to refresh if the request itself is a refresh or auth endpoint
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/auth/refresh') || url.includes('/auth/login') || url.includes('/auth/register')) {
      return response;
    }

    // Try to refresh the token
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      // Retry the original request
      return fetch(input, init);
    }

    // Refresh failed — session is expired, trigger redirect to login
    if (_onSessionExpired) {
      _onSessionExpired();
    }
  }

  return response;
}

// ============ LLM API ============

/** File attachment for multimodal input — sent as base64 inlineData to Gemini */
export interface FileAttachment {
  data: string;      // base64 encoded
  mimeType: string;  // e.g. 'application/pdf', 'text/plain'
  name?: string;     // optional filename
}

export interface LLMGenerateOptions extends RequestOptions {
  temperature?: number;
  maxTokens?: number;
  attachments?: FileAttachment[];
}

export interface LLMResponse {
  text: string;
}

export interface StreamChunk {
  text: string;
  accumulated: string;
}

/**
 * Generate text using Gemini via backend
 */
export async function generateText(prompt: string, options: LLMGenerateOptions = {}): Promise<string> {
  const response = await apiFetch(`${API_BASE}/llm/generate`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      apiKey: options.apiKey,
      attachments: options.attachments,
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate text');
  }
  
  const data = await response.json() as LLMResponse;
  return data.text;
}

/**
 * Generate text with streaming
 */
export async function generateTextStream(
  prompt: string,
  onChunk: (chunk: StreamChunk) => void,
  options: LLMGenerateOptions = {}
): Promise<string> {
  const response = await apiFetch(`${API_BASE}/llm/stream`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      apiKey: options.apiKey,
      attachments: options.attachments,
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate text');
  }
  
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');
  
  const decoder = new TextDecoder();
  let accumulated = '';
  let buffer = '';
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data && data !== '[DONE]') {
          try {
            const chunk = JSON.parse(data) as StreamChunk;
            accumulated = chunk.accumulated;
            onChunk(chunk);
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
  }
  
  return accumulated;
}

// ============ Voice API ============

export interface Voice {
  id: string;
  name: string;
  description: string;
  descriptionZh?: string;
  sampleUrl?: string;
}

export interface VoiceSampleResult {
  voiceId: string;
  audioData: string;  // base64
  mimeType: string;
  format: string;
}

export interface SynthesizeOptions extends RequestOptions {
  // Custom TTS options for voice cloning
  refAudioDataUrl?: string;
  refText?: string;
  speed?: number;
  targetLanguage?: string;
}

export interface SynthesizeResult {
  audioData: string;  // base64
  mimeType: string;
  format: string;
}

export interface TTSStatusResult {
  configured: boolean;
}

/**
 * Get available voices
 */
export async function getVoices(): Promise<Voice[]> {
  const response = await apiFetch(`${API_BASE}/voice/voices`, fetchOptions);
  
  if (!response.ok) {
    throw new Error('Failed to fetch voices');
  }
  
  const data = await response.json();
  return data.voices;
}

export interface RecommendVoicesParams {
  characters: Array<{ name: string; description?: string }>;
  voices: Array<{ id: string; name: string; description?: string; descriptionZh?: string }>;
  language?: 'en' | 'zh';
}

/**
 * Recommend best preset voice for each character via Gemini Flash
 * Returns voice IDs in same order as characters
 */
export async function recommendVoices(params: RecommendVoicesParams): Promise<string[]> {
  const response = await apiFetch(`${API_BASE}/voice/recommend`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      characters: params.characters,
      voices: params.voices,
      language: params.language
    })
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to recommend voices');
  }
  const data = await response.json();
  return data.assignments ?? [];
}

/**
 * Get voice sample for preview (pre-generated)
 */
export async function getVoiceSample(voiceId: string, language: 'en' | 'zh' = 'en'): Promise<VoiceSampleResult> {
  const response = await apiFetch(`${API_BASE}/voice/sample/${voiceId}?lang=${language}`, fetchOptions);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch voice sample');
  }
  
  return response.json();
}

/**
 * Voice sample cache for frontend
 */
const voiceSampleCache = new Map<string, VoiceSampleResult>();

/**
 * Get voice sample with caching
 */
export async function getVoiceSampleCached(voiceId: string, language: 'en' | 'zh' = 'en'): Promise<VoiceSampleResult> {
  const cacheKey = `${voiceId}-${language}`;
  
  const cached = voiceSampleCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  
  const sample = await getVoiceSample(voiceId, language);
  voiceSampleCache.set(cacheKey, sample);
  
  return sample;
}

/**
 * Play voice sample
 */
export async function playVoiceSample(voiceId: string, language: 'en' | 'zh' = 'en'): Promise<HTMLAudioElement> {
  console.log(`Playing voice sample: ${voiceId} (${language})`);
  
  const sample = await getVoiceSampleCached(voiceId, language);
  console.log(`Got sample, mimeType: ${sample.mimeType}, data length: ${sample.audioData?.length || 0}`);
  
  if (!sample.audioData) {
    throw new Error('No audio data in voice sample');
  }
  
  return playAudio(sample.audioData, sample.mimeType);
}

// ============ Voice Design API ============

export interface VoiceDesignPreview {
  audioBase64: string;
  generatedVoiceId: string;
  mediaType: string;
  durationSecs: number;
  language: string;
}

export interface VoiceDesignResult {
  previews: VoiceDesignPreview[];
  text: string;
}

export interface VoiceDesignOptions {
  text?: string;
  guidanceScale?: number;
  loudness?: number;
}

/**
 * Design voice from text description using ElevenLabs text-to-voice API.
 * Returns 3 voice preview candidates with audio and generated_voice_id.
 */
export async function designVoice(
  voiceDescription: string,
  options: VoiceDesignOptions = {}
): Promise<VoiceDesignResult> {
  const response = await apiFetch(`${API_BASE}/voice/design`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      voiceDescription,
      text: options.text,
      guidanceScale: options.guidanceScale,
      loudness: options.loudness,
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to design voice');
  }

  return response.json();
}

/**
 * Check TTS service status
 */
export async function getTTSStatus(): Promise<TTSStatusResult> {
  try {
    const response = await apiFetch(`${API_BASE}/voice/tts-status`, fetchOptions);
    if (!response.ok) {
      return { configured: false };
    }
    return response.json();
  } catch {
    return { configured: false };
  }
}

/**
 * Synthesize speech from text using custom TTS
 */
export async function synthesizeSpeech(
  text: string, 
  options: SynthesizeOptions = {}
): Promise<SynthesizeResult> {
  const response = await apiFetch(`${API_BASE}/voice/synthesize`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      refAudioDataUrl: options.refAudioDataUrl,
      refText: options.refText,
      speed: options.speed,
      targetLanguage: options.targetLanguage
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to synthesize speech');
  }
  
  return response.json();
}

/**
 * Preview a voice with sample text
 */
export async function previewVoice(
  voiceName: string, 
  text?: string,
  apiKey?: string
): Promise<SynthesizeResult> {
  const response = await apiFetch(`${API_BASE}/voice/preview`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voiceName,
      apiKey
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to preview voice');
  }
  
  return response.json();
}

// ============ Audio API ============

export interface AudioSegment {
  text: string;
  speaker?: string;
  // System voice (Gemini TTS) - identified by voiceName
  voiceName?: string;
  // Custom TTS options per segment
  refAudioDataUrl?: string;
  refText?: string;
  speed?: number;
}

export interface BatchOptions {
  // Default custom TTS options for all segments
  defaultRefAudioDataUrl?: string;
  defaultRefText?: string;
}

export interface GeneratedSegment {
  index: number;
  speaker?: string;
  audioData: string;
  mimeType: string;
  audioUrl?: string; // GCS URL for persistent storage
}

export interface BatchResult {
  segments: GeneratedSegment[];
  errors?: { index: number; error: string }[];
  totalRequested: number;
  totalGenerated: number;
}

export interface BatchProgressEvent {
  type: 'start' | 'progress' | 'segment' | 'error' | 'done';
  index?: number;
  total?: number;
  speaker?: string;
  audioData?: string;
  mimeType?: string;
  audioUrl?: string; // GCS URL for persistent storage
  error?: string;
}

/**
 * Generate audio for multiple segments using custom TTS
 */
export async function generateAudioBatch(
  segments: AudioSegment[],
  options: BatchOptions = {}
): Promise<BatchResult> {
  const response = await apiFetch(`${API_BASE}/audio/batch`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      segments, 
      defaultRefAudioDataUrl: options.defaultRefAudioDataUrl,
      defaultRefText: options.defaultRefText
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate audio batch');
  }
  
  return response.json();
}

/**
 * Generate audio batch with progress streaming using custom TTS
 */
export async function generateAudioBatchStream(
  segments: AudioSegment[],
  onProgress: (event: BatchProgressEvent) => void,
  options: BatchOptions = {}
): Promise<void> {
  const response = await apiFetch(`${API_BASE}/audio/batch-stream`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      segments, 
      defaultRefAudioDataUrl: options.defaultRefAudioDataUrl,
      defaultRefText: options.defaultRefText
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate audio batch');
  }
  
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');
  
  const decoder = new TextDecoder();
  let buffer = '';
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data) {
          try {
            const event = JSON.parse(data) as BatchProgressEvent;
            onProgress(event);
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
  }
}

// ============ Utility Functions ============

/**
 * Convert base64 audio to playable URL
 */
export function audioDataToUrl(audioData: string, mimeType: string): string {
  return `data:${mimeType};base64,${audioData}`;
}

/**
 * Convert base64 audio to Blob
 */
export function audioDataToBlob(audioData: string, mimeType: string): Blob {
  const byteCharacters = atob(audioData);
  const byteNumbers = new Array(byteCharacters.length);
  
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

/**
 * Play audio from base64 data
 */
export async function playAudio(audioData: string, mimeType: string): Promise<HTMLAudioElement> {
  const url = audioDataToUrl(audioData, mimeType);
  const audio = new Audio(url);
  
  try {
    await audio.play();
  } catch (error) {
    console.error('Audio playback failed:', error);
    throw error;
  }
  
  return audio;
}

/**
 * Download audio file
 */
export function downloadAudio(audioData: string, mimeType: string, filename: string): void {
  const blob = audioDataToBlob(audioData, mimeType);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Check if backend is available
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`, fetchOptions);
    return response.ok;
  } catch {
    return false;
  }
}

// ============ Image API ============

export interface ImageGenerateOptions extends RequestOptions {
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  numberOfImages?: number;
}

export interface GeneratedImage {
  index: number;
  imageData: string;  // base64
  mimeType: string;
}

/**
 * Generate images from prompt
 */
export async function generateImage(
  prompt: string,
  options: ImageGenerateOptions = {}
): Promise<GeneratedImage[]> {
  const response = await apiFetch(`${API_BASE}/image/generate`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      aspectRatio: options.aspectRatio,
      numberOfImages: options.numberOfImages,
      apiKey: options.apiKey
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate image');
  }
  
  const data = await response.json();
  return data.images;
}

/**
 * Generate podcast cover image
 */
export async function generateCoverImage(
  prompt: string,
  aspectRatio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9' = '1:1',
  apiKey?: string
): Promise<{ imageData: string; mimeType: string }> {
  const response = await apiFetch(`${API_BASE}/image/cover`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, aspectRatio, apiKey })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate cover');
  }
  
  return response.json();
}

// ============ Music API ============

export interface MusicOptions extends RequestOptions {
  genre?: string;
  mood?: string;
  durationSeconds?: number;
}

export interface MusicResult {
  audioData: string;  // base64
  mimeType: string;
  format: string;
}

export interface MusicOptionsData {
  genres: string[];
  moods: string[];
}

export interface SfxSuggestion {
  id: string;
  description: string;
}

/**
 * Get available music generation options
 */
export async function getMusicOptions(): Promise<MusicOptionsData> {
  const response = await apiFetch(`${API_BASE}/music/options`, fetchOptions);
  
  if (!response.ok) {
    throw new Error('Failed to fetch music options');
  }
  
  return response.json();
}

/**
 * Generate background music
 */
export async function generateMusic(
  description: string,
  options: MusicOptions = {}
): Promise<MusicResult> {
  const response = await apiFetch(`${API_BASE}/music/generate`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description,
      genre: options.genre,
      mood: options.mood,
      durationSeconds: options.durationSeconds,
      apiKey: options.apiKey
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate music');
  }
  
  return response.json();
}

/**
 * Generate podcast-optimized background music
 */
export async function generateBGM(
  description?: string,
  mood?: string,
  durationSeconds?: number,
  apiKey?: string
): Promise<MusicResult> {
  const response = await apiFetch(`${API_BASE}/music/bgm`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, mood, durationSeconds, apiKey })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate BGM');
  }
  
  return response.json();
}

/**
 * Generate sound effect
 */
export async function generateSoundEffect(
  description: string,
  durationSeconds?: number,
  apiKey?: string
): Promise<MusicResult> {
  const response = await apiFetch(`${API_BASE}/music/sfx`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, durationSeconds, apiKey })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate sound effect');
  }
  
  return response.json();
}

/**
 * Get common sound effect suggestions
 */
export async function getSfxSuggestions(): Promise<SfxSuggestion[]> {
  const response = await apiFetch(`${API_BASE}/music/sfx-suggestions`, fetchOptions);
  
  if (!response.ok) {
    throw new Error('Failed to fetch SFX suggestions');
  }
  
  const data = await response.json();
  return data.suggestions;
}

// ============ Image Utility Functions ============

/**
 * Convert base64 image to displayable URL
 */
export function imageDataToUrl(imageData: string, mimeType: string): string {
  return `data:${mimeType};base64,${imageData}`;
}

/**
 * Download image file
 */
export function downloadImage(imageData: string, mimeType: string, filename: string): void {
  const byteCharacters = atob(imageData);
  const byteNumbers = new Array(byteCharacters.length);
  
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============ Storage API (Persistence) ============

export interface StorageStatus {
  configured: boolean;
  message: string;
}

/**
 * Check if cloud storage is configured
 */
export async function checkStorageStatus(): Promise<StorageStatus> {
  try {
    const response = await apiFetch(`${API_BASE}/storage/status`, fetchOptions);
    if (!response.ok) {
      return { configured: false, message: 'Storage API unavailable' };
    }
    return response.json();
  } catch {
    return { configured: false, message: 'Storage API unavailable' };
  }
}

// ============ Projects Persistence ============

export interface ProjectData {
  id: string;
  [key: string]: unknown;
}

/**
 * Load all projects from cloud storage
 */
export async function loadProjectsFromCloud(): Promise<ProjectData[]> {
  const response = await apiFetch(`${API_BASE}/storage/projects`, fetchOptions);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to load projects');
  }
  
  const data = await response.json();
  return data.projects || [];
}

/**
 * Save all projects to cloud storage (bulk — for migration / full sync only).
 * Prefer upsertProjectToCloud for individual mutations.
 */
export async function saveProjectsToCloud(projects: ProjectData[]): Promise<void> {
  const response = await apiFetch(`${API_BASE}/storage/projects`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to save projects');
  }
}

/**
 * Upsert a single project to cloud storage.
 * This is the primary write path — call this on every create / update / delete-episode.
 */
export async function upsertProjectToCloud(project: ProjectData): Promise<void> {
  const response = await apiFetch(`${API_BASE}/storage/projects/${project.id}`, {
    ...fetchOptions,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error((error as { error?: string }).error || 'Failed to upsert project');
  }
}

/**
 * Delete a single project from cloud storage.
 */
export async function deleteProjectFromCloud(projectId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/storage/projects/${projectId}`, {
    ...fetchOptions,
    method: 'DELETE',
  });

  if (!response.ok && response.status !== 404) {
    const error = await response.json().catch(() => ({}));
    throw new Error((error as { error?: string }).error || 'Failed to delete project');
  }
}

// ============ Voice Characters Persistence ============

export interface VoiceCharacterData {
  id: string;
  [key: string]: unknown;
}

/**
 * Load all voice characters from cloud storage
 */
export async function loadVoicesFromCloud(): Promise<VoiceCharacterData[]> {
  const response = await apiFetch(`${API_BASE}/storage/voices`, fetchOptions);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to load voice characters');
  }
  
  const data = await response.json();
  return data.voices || [];
}

/**
 * Save all voice characters to cloud storage
 */
export async function saveVoicesToCloud(voices: VoiceCharacterData[]): Promise<void> {
  const response = await apiFetch(`${API_BASE}/storage/voices`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voices })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to save voice characters');
  }
}

/**
 * Upload voice sample audio to cloud storage
 */
export async function uploadVoiceSampleToCloud(voiceId: string, dataUrl: string): Promise<string> {
  const response = await apiFetch(`${API_BASE}/storage/voices/${voiceId}/sample`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to upload voice sample');
  }
  
  const data = await response.json();
  return data.url;
}

/**
 * Delete a voice character from cloud storage
 */
export async function deleteVoiceFromCloud(voiceId: string): Promise<boolean> {
  const response = await apiFetch(`${API_BASE}/storage/voices/${voiceId}`, {
    ...fetchOptions,
    method: 'DELETE',
  });
  
  if (!response.ok) {
    return false;
  }
  
  const data = await response.json();
  return data.success;
}

// ============ Media Items Persistence ============

export interface MediaItemData {
  id: string;
  type: 'image' | 'bgm' | 'sfx';
  [key: string]: unknown;
}

/**
 * Load all media items from cloud storage
 */
export async function loadMediaItemsFromCloud(): Promise<MediaItemData[]> {
  const response = await apiFetch(`${API_BASE}/storage/media`, fetchOptions);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to load media items');
  }
  
  const data = await response.json();
  return data.items || [];
}

/**
 * Save all media items to cloud storage
 */
export async function saveMediaItemsToCloud(items: MediaItemData[]): Promise<void> {
  const response = await apiFetch(`${API_BASE}/storage/media`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to save media items');
  }
}

/**
 * Upload media file to cloud storage
 */
export async function uploadMediaFileToCloud(
  mediaId: string, 
  dataUrl: string, 
  type: 'image' | 'bgm' | 'sfx',
  name?: string
): Promise<string> {
  const response = await apiFetch(`${API_BASE}/storage/media/${mediaId}/file`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, type, name })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to upload media file');
  }
  
  const data = await response.json();
  return data.url;
}

/**
 * Delete media file from cloud storage
 */
export async function deleteMediaFileFromCloud(
  mediaId: string,
  type: 'image' | 'bgm' | 'sfx',
  fileUrl?: string
): Promise<boolean> {
  const response = await apiFetch(`${API_BASE}/storage/media/${mediaId}/file`, {
    ...fetchOptions,
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, fileUrl })
  });
  
  if (!response.ok) {
    return false;
  }
  
  const data = await response.json();
  return data.success;
}

// ============ Audio Mixing API ============

export interface AudioTrack {
  audioData?: string;   // base64 (optional if audioUrl is provided)
  audioUrl?: string;    // GCS URL for persistent storage (fallback when audioData is missing)
  mimeType: string;
  speaker?: string;    // Speaker identifier for gap calculation
  sectionStart?: boolean; // True if this is the first segment of a new section
  pauseAfterMs?: number; // Custom pause after this track (overrides default gap)
  startMs?: number;    // Start time offset (for future timeline editing)
  volume?: number;     // 0-1, default 1
}

/**
 * Audio mix configuration for professional output
 */
export interface AudioMixConfig {
  // Silence padding (in milliseconds)
  silenceStartMs?: number;      // Silence at the beginning
  silenceEndMs?: number;        // Silence at the end
  
  // Inter-segment gaps (in milliseconds)
  sameSpeakerGapMs?: number;    // Gap between same speaker's lines
  differentSpeakerGapMs?: number; // Gap between different speakers
  sectionGapMs?: number;        // Gap between sections
  
  // Volume levels (0-1)
  voiceVolume?: number;         // Main voice volume
  bgmVolume?: number;           // Background music volume
  sfxVolume?: number;           // Sound effects volume
  
  // Fade effects (in milliseconds)
  bgmFadeInMs?: number;         // BGM fade in duration
  bgmFadeOutMs?: number;        // BGM fade out duration
  
  // Advanced options
  normalizeAudio?: boolean;
  compressAudio?: boolean;
}

export interface MixRequest {
  voiceTracks: AudioTrack[];           // Voice segments to concatenate
  bgmTrack?: AudioTrack;               // Background music (optional)
  sfxTracks?: AudioTrack[];            // Sound effects (optional)
  config?: AudioMixConfig;             // Mix configuration
}

export interface MixResult {
  audioData: string;    // base64 of final mixed audio
  mimeType: string;
  durationMs: number;
  trackCount: number;
}

/**
 * Mix multiple audio tracks into a single output
 * - Voice tracks are concatenated with configurable gaps
 * - Silence padding at start/end
 * - Different gaps for same vs different speakers
 * - BGM overlaid with fade in/out (looping if shorter)
 */
export async function mixAudioTracks(request: MixRequest): Promise<MixResult> {
  const response = await apiFetch(`${API_BASE}/mix`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to mix audio');
  }
  
  return response.json();
}

/**
 * Quick preview mix - concatenate voice tracks with minimal gaps
 * Faster for preview during editing
 */
export async function previewMix(
  voiceTracks: AudioTrack[], 
  config?: AudioMixConfig
): Promise<MixResult> {
  const response = await apiFetch(`${API_BASE}/mix/preview`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voiceTracks, config })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to preview mix');
  }
  
  return response.json();
}

/**
 * Get available mix configuration presets
 */
export async function getMixPresets(): Promise<{
  presets: Record<string, { name: string; description: string; config: AudioMixConfig }>;
  default: AudioMixConfig;
}> {
  const response = await apiFetch(`${API_BASE}/mix/presets`, fetchOptions);
  
  if (!response.ok) {
    throw new Error('Failed to fetch mix presets');
  }
  
  return response.json();
}

// ============ Feedback / Tickets API ============

export interface FeedbackTicket {
  id: string;
  userId: string;
  subject: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high';
  category?: string;
  assignedAdminId?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
  unreadCount: number;
  // Admin-visible
  userDisplayName?: string;
  userEmail?: string;
}

export interface FeedbackMessage {
  id: string;
  ticketId: string;
  senderId: string;
  senderName: string;
  content: string;
  isAdminReply: boolean;
  readAt?: string;
  createdAt: string;
}

export interface FeedbackStats {
  open_count: string;
  in_progress_count: string;
  resolved_count: string;
  closed_count: string;
  total_count: string;
}

/**
 * Get current user's tickets
 */
export async function getMyTickets(): Promise<FeedbackTicket[]> {
  const response = await apiFetch(`${API_BASE}/feedback/tickets`, fetchOptions);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch tickets');
  }
  const data = await response.json();
  return data.tickets;
}

/**
 * Create a new feedback ticket
 */
export async function createTicket(params: {
  subject: string;
  message: string;
  category?: string;
  priority?: string;
}): Promise<FeedbackTicket> {
  const response = await apiFetch(`${API_BASE}/feedback/tickets`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create ticket');
  }
  const data = await response.json();
  return data.ticket;
}

/**
 * Get a ticket with its messages
 */
export async function getTicketDetail(ticketId: string): Promise<{
  ticket: FeedbackTicket;
  messages: FeedbackMessage[];
}> {
  const response = await apiFetch(`${API_BASE}/feedback/tickets/${ticketId}`, fetchOptions);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch ticket');
  }
  return response.json();
}

/**
 * Send a message in a ticket
 */
export async function sendTicketMessage(ticketId: string, content: string): Promise<FeedbackMessage> {
  const response = await apiFetch(`${API_BASE}/feedback/tickets/${ticketId}/messages`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to send message');
  }
  const data = await response.json();
  return data.message;
}

/**
 * Close a ticket
 */
export async function closeTicket(ticketId: string): Promise<FeedbackTicket> {
  const response = await apiFetch(`${API_BASE}/feedback/tickets/${ticketId}/close`, {
    ...fetchOptions,
    method: 'PATCH',
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to close ticket');
  }
  const data = await response.json();
  return data.ticket;
}

// ---- Admin feedback endpoints ----

/**
 * Get all tickets (admin only)
 */
export async function getAdminTickets(params?: {
  status?: string;
  page?: number;
  limit?: number;
}): Promise<{ tickets: FeedbackTicket[]; total: number; page: number; limit: number }> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.limit) searchParams.set('limit', String(params.limit));

  const response = await apiFetch(
    `${API_BASE}/feedback/admin/tickets?${searchParams.toString()}`,
    fetchOptions
  );
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch admin tickets');
  }
  return response.json();
}

/**
 * Update ticket status (admin only)
 */
export async function updateTicketStatus(ticketId: string, status: string): Promise<FeedbackTicket> {
  const response = await apiFetch(`${API_BASE}/feedback/admin/tickets/${ticketId}/status`, {
    ...fetchOptions,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to update ticket status');
  }
  const data = await response.json();
  return data.ticket;
}

/**
 * Get feedback stats (admin only)
 */
export async function getFeedbackStats(): Promise<FeedbackStats> {
  const response = await apiFetch(`${API_BASE}/feedback/admin/stats`, fetchOptions);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch stats');
  }
  const data = await response.json();
  return data.stats;
}

// ============ Bulk Sync Operations ============

export interface SyncData {
  projects?: ProjectData[];
  voices?: VoiceCharacterData[];
  mediaItems?: MediaItemData[];
}

export interface SyncResult {
  projects: ProjectData[];
  voices: VoiceCharacterData[];
  mediaItems: MediaItemData[];
  counts: {
    projects: number;
    voices: number;
    mediaItems: number;
  };
}

/**
 * Load all data from cloud storage at once
 */
export async function loadAllFromCloud(): Promise<SyncResult> {
  const response = await apiFetch(`${API_BASE}/storage/sync`, fetchOptions);
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to load data');
  }
  
  return response.json();
}

/**
 * Save all data to cloud storage at once
 */
export async function saveAllToCloud(data: SyncData): Promise<void> {
  const response = await apiFetch(`${API_BASE}/storage/sync`, {
    ...fetchOptions,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to save data');
  }
}
