/**
 * Client-side audio trimming using the Web Audio API.
 * Decodes any browser-supported audio format, trims to a max duration,
 * and re-encodes as 16-bit PCM WAV — no external dependencies required.
 */

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_DURATION_SECONDS = 30;

export class AudioFileTooLargeError extends Error {
  constructor(sizeBytes: number) {
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
    super(`File is ${sizeMB} MB, exceeds the 5 MB limit`);
    this.name = 'AudioFileTooLargeError';
  }
}

/**
 * Validate file size (max 5 MB).
 * Throws AudioFileTooLargeError if the file exceeds the limit.
 */
export function validateAudioFileSize(file: File): void {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new AudioFileTooLargeError(file.size);
  }
}

/**
 * Process an audio File for voice upload:
 *  1. Validates file size (≤ 5 MB)
 *  2. Decodes the audio using Web Audio API
 *  3. If duration > 30 s, trims to 30 s and re-encodes as WAV
 *  4. Returns a base64 data URL ready for storage/upload
 */
export async function processAudioFile(
  file: File,
  maxSeconds: number = MAX_DURATION_SECONDS,
): Promise<{ dataUrl: string; duration: number; wasTrimmed: boolean }> {
  validateAudioFileSize(file);

  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext();

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const duration = audioBuffer.duration;

    if (duration <= maxSeconds) {
      // No trimming needed — return the original file as-is
      const dataUrl = await fileToDataUrl(file);
      return { dataUrl, duration, wasTrimmed: false };
    }

    // Trim and re-encode as WAV
    const trimmedBuffer = trimAudioBuffer(audioBuffer, maxSeconds);
    const wavBlob = encodeWav(trimmedBuffer);
    const dataUrl = await blobToDataUrl(wavBlob);

    return { dataUrl, duration: maxSeconds, wasTrimmed: true };
  } finally {
    audioContext.close();
  }
}

function trimAudioBuffer(buffer: AudioBuffer, maxSeconds: number): AudioBuffer {
  const maxSamples = Math.floor(maxSeconds * buffer.sampleRate);
  const ctx = new OfflineAudioContext(
    buffer.numberOfChannels,
    maxSamples,
    buffer.sampleRate,
  );
  const trimmed = ctx.createBuffer(
    buffer.numberOfChannels,
    maxSamples,
    buffer.sampleRate,
  );
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    trimmed.copyToChannel(src.subarray(0, maxSamples), ch);
  }
  return trimmed;
}

function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = buffer.length * blockAlign;
  const headerSize = 44;

  const arrayBuffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeStr(view, 0, 'RIFF');
  view.setUint32(4, headerSize + dataSize - 8, true);
  writeStr(view, 8, 'WAVE');

  // fmt sub-chunk
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeStr(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleaved PCM samples
  let offset = headerSize;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeStr(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
