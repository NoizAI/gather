/**
 * Server-side audio trimming — WAV-only, pure Buffer manipulation.
 *
 * The frontend already trims uploads to ≤ 30 s and re-encodes as 16-bit PCM
 * WAV via the Web Audio API, so this is a safety net that ensures nothing
 * longer than MAX_DURATION_SECONDS ever reaches GCS/TTS services.
 *
 * No ffmpeg or native dependencies required.
 */

const MAX_DURATION_SECONDS = 30;

/**
 * If the data URL contains WAV audio longer than `maxSeconds`, return a
 * trimmed copy.  For non-WAV formats (or data URLs that can't be parsed)
 * the input is returned unchanged — the frontend is the authoritative
 * trimmer for arbitrary formats.
 */
export function trimAudioDataUrl(
  dataUrl: string,
  maxSeconds: number = MAX_DURATION_SECONDS,
): string {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return dataUrl;

  const mimeType = match[1];
  const base64 = match[2];

  if (mimeType !== 'audio/wav' && mimeType !== 'audio/x-wav') {
    return dataUrl;
  }

  const buffer = Buffer.from(base64, 'base64');
  const trimmed = trimWavBuffer(buffer, maxSeconds);

  if (trimmed === buffer) return dataUrl;
  return `data:${mimeType};base64,${trimmed.toString('base64')}`;
}

/**
 * Trim a PCM WAV buffer to at most `maxSeconds`.
 * Returns the original buffer if no trimming is needed or if the
 * header can't be parsed (non-standard WAV layout).
 */
function trimWavBuffer(buf: Buffer, maxSeconds: number): Buffer {
  if (buf.length < 44) return buf;

  // Verify RIFF/WAVE header
  if (
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return buf;
  }

  const byteRate = buf.readUInt32LE(28);
  if (byteRate === 0) return buf;

  // Locate the "data" sub-chunk
  let offset = 12;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') break;
    offset += 8 + chunkSize;
  }

  if (offset >= buf.length - 8) return buf;

  const dataChunkOffset = offset;
  const dataStart = offset + 8;
  const dataSize = buf.readUInt32LE(offset + 4);

  const currentDuration = dataSize / byteRate;
  if (currentDuration <= maxSeconds) return buf;

  const maxDataBytes = Math.floor(maxSeconds * byteRate);
  const newTotalSize = dataStart + maxDataBytes;
  const trimmed = Buffer.alloc(newTotalSize);

  buf.copy(trimmed, 0, 0, dataStart);
  buf.copy(trimmed, dataStart, dataStart, dataStart + maxDataBytes);

  // Patch RIFF size
  trimmed.writeUInt32LE(newTotalSize - 8, 4);
  // Patch data chunk size
  trimmed.writeUInt32LE(maxDataBytes, dataChunkOffset + 4);

  console.log(
    `Audio trimmed: ${currentDuration.toFixed(1)}s → ${maxSeconds}s ` +
    `(${(buf.length / 1024).toFixed(0)} KB → ${(trimmed.length / 1024).toFixed(0)} KB)`,
  );

  return trimmed;
}
