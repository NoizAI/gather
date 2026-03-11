/**
 * Voice Characters Repository
 * Handles CRUD operations for voice characters with signed URLs
 */

import { query } from '../index.js';
import { generateUrlsForFileIds, getFileByIdWithUrl, uploadAndCreateFile } from './files.js';
import { trimAudioDataUrl } from '../../services/audioTrim.js';

// ============================================
// Types
// ============================================

export interface VoiceCharacter {
  id: string;
  userId: string;
  name: string;
  description: string;
  avatarUrl?: string;  // Signed URL
  avatarFileId?: string;
  audioSampleUrl?: string;  // Signed URL
  audioSampleFileId?: string;
  refAudioUrl?: string;  // Signed URL
  refAudioFileId?: string;
  refText?: string;
  tags: string[];
  projectIds?: string[];
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

interface VoiceCharacterRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  avatar_file_id: string | null;
  audio_sample_file_id: string | null;
  ref_audio_file_id: string | null;
  ref_text: string | null;
  tags: string[];
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
}

interface VoiceProjectRow {
  voice_character_id: string;
  project_id: string;
}

// ============================================
// Helper Functions
// ============================================

function mapVoiceRow(row: VoiceCharacterRow): Omit<VoiceCharacter, 'avatarUrl' | 'audioSampleUrl' | 'refAudioUrl' | 'projectIds'> {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    avatarFileId: row.avatar_file_id || undefined,
    audioSampleFileId: row.audio_sample_file_id || undefined,
    refAudioFileId: row.ref_audio_file_id || undefined,
    refText: row.ref_text || undefined,
    tags: row.tags || [],
    isPublic: row.is_public,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function buildVoicesWithUrls(voiceRows: VoiceCharacterRow[]): Promise<VoiceCharacter[]> {
  if (voiceRows.length === 0) {
    return [];
  }
  
  // Collect all file IDs
  const fileIds: string[] = [];
  voiceRows.forEach(v => {
    if (v.avatar_file_id) fileIds.push(v.avatar_file_id);
    if (v.audio_sample_file_id) fileIds.push(v.audio_sample_file_id);
    if (v.ref_audio_file_id) fileIds.push(v.ref_audio_file_id);
  });
  
  // Generate signed URLs
  const urlMap = fileIds.length > 0
    ? await generateUrlsForFileIds(fileIds)
    : new Map<string, string>();
  
  // Get project associations
  const voiceIds = voiceRows.map(v => v.id);
  const projectsResult = await query<VoiceProjectRow>(`
    SELECT * FROM voice_character_projects WHERE voice_character_id = ANY($1)
  `, [voiceIds]);
  
  const projectsByVoice = new Map<string, string[]>();
  for (const row of projectsResult.rows) {
    const projects = projectsByVoice.get(row.voice_character_id) || [];
    projects.push(row.project_id);
    projectsByVoice.set(row.voice_character_id, projects);
  }
  
  return voiceRows.map(row => ({
    ...mapVoiceRow(row),
    avatarUrl: row.avatar_file_id ? urlMap.get(row.avatar_file_id) : undefined,
    audioSampleUrl: row.audio_sample_file_id ? urlMap.get(row.audio_sample_file_id) : undefined,
    refAudioUrl: row.ref_audio_file_id ? urlMap.get(row.ref_audio_file_id) : undefined,
    projectIds: projectsByVoice.get(row.id) || [],
  }));
}

// ============================================
// CRUD Operations
// ============================================

/**
 * Get all voice characters for a user
 */
export async function getVoiceCharactersByUserId(userId: string): Promise<VoiceCharacter[]> {
  const result = await query<VoiceCharacterRow>(`
    SELECT * FROM voice_characters 
    WHERE user_id = $1 
    ORDER BY created_at DESC
  `, [userId]);
  
  return buildVoicesWithUrls(result.rows);
}

/**
 * Get all public voice characters
 */
export async function getPublicVoiceCharacters(limit: number = 50): Promise<VoiceCharacter[]> {
  const result = await query<VoiceCharacterRow>(`
    SELECT * FROM voice_characters 
    WHERE is_public = TRUE 
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
  
  return buildVoicesWithUrls(result.rows);
}

/**
 * Get a voice character by ID
 */
export async function getVoiceCharacterById(id: string, userId?: string): Promise<VoiceCharacter | null> {
  let queryStr = 'SELECT * FROM voice_characters WHERE id = $1';
  const params: unknown[] = [id];
  
  if (userId) {
    queryStr += ' AND (user_id = $2 OR is_public = TRUE)';
    params.push(userId);
  }
  
  const result = await query<VoiceCharacterRow>(queryStr, params);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  const voices = await buildVoicesWithUrls(result.rows);
  return voices[0] || null;
}

/**
 * Create a voice character
 */
export async function createVoiceCharacter(
  userId: string,
  voice: Omit<VoiceCharacter, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'avatarUrl' | 'audioSampleUrl' | 'refAudioUrl'>
): Promise<VoiceCharacter> {
  const result = await query<VoiceCharacterRow>(`
    INSERT INTO voice_characters (
      user_id, name, description, avatar_file_id, audio_sample_file_id,
      ref_audio_file_id, ref_text, tags, is_public
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `, [
    userId,
    voice.name,
    voice.description,
    voice.avatarFileId || null,
    voice.audioSampleFileId || null,
    voice.refAudioFileId || null,
    voice.refText || null,
    voice.tags || [],
    voice.isPublic ?? false,
  ]);
  
  // Add project associations
  if (voice.projectIds && voice.projectIds.length > 0) {
    for (const projectId of voice.projectIds) {
      await query(`
        INSERT INTO voice_character_projects (voice_character_id, project_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [result.rows[0].id, projectId]);
    }
  }
  
  const voices = await buildVoicesWithUrls(result.rows);
  return voices[0];
}

/**
 * Update a voice character
 */
export async function updateVoiceCharacter(
  id: string,
  userId: string,
  updates: Partial<Omit<VoiceCharacter, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'avatarUrl' | 'audioSampleUrl' | 'refAudioUrl'>>
): Promise<VoiceCharacter | null> {
  // Verify ownership
  const ownerCheck = await query(`
    SELECT id FROM voice_characters WHERE id = $1 AND user_id = $2
  `, [id, userId]);
  
  if (ownerCheck.rows.length === 0) {
    return null;
  }
  
  const setClause: string[] = [];
  const values: unknown[] = [id];
  let paramIndex = 2;
  
  if (updates.name !== undefined) {
    setClause.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    setClause.push(`description = $${paramIndex++}`);
    values.push(updates.description);
  }
  if (updates.avatarFileId !== undefined) {
    setClause.push(`avatar_file_id = $${paramIndex++}`);
    values.push(updates.avatarFileId);
  }
  if (updates.audioSampleFileId !== undefined) {
    setClause.push(`audio_sample_file_id = $${paramIndex++}`);
    values.push(updates.audioSampleFileId);
  }
  if (updates.refAudioFileId !== undefined) {
    setClause.push(`ref_audio_file_id = $${paramIndex++}`);
    values.push(updates.refAudioFileId);
  }
  if (updates.refText !== undefined) {
    setClause.push(`ref_text = $${paramIndex++}`);
    values.push(updates.refText);
  }
  if (updates.tags !== undefined) {
    setClause.push(`tags = $${paramIndex++}`);
    values.push(updates.tags);
  }
  if (updates.isPublic !== undefined) {
    setClause.push(`is_public = $${paramIndex++}`);
    values.push(updates.isPublic);
  }
  
  if (setClause.length > 0) {
    await query(`
      UPDATE voice_characters SET ${setClause.join(', ')}
      WHERE id = $1
    `, values);
  }
  
  // Update project associations
  if (updates.projectIds !== undefined) {
    await query('DELETE FROM voice_character_projects WHERE voice_character_id = $1', [id]);
    for (const projectId of updates.projectIds) {
      await query(`
        INSERT INTO voice_character_projects (voice_character_id, project_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [id, projectId]);
    }
  }
  
  return getVoiceCharacterById(id, userId);
}

/**
 * Delete a voice character
 */
export async function deleteVoiceCharacter(id: string, userId: string): Promise<boolean> {
  const result = await query(`
    DELETE FROM voice_characters WHERE id = $1 AND user_id = $2
  `, [id, userId]);
  
  return (result.rowCount ?? 0) > 0;
}

/**
 * Upload and update voice sample
 */
export async function uploadVoiceSample(
  id: string,
  userId: string,
  dataUrl: string
): Promise<VoiceCharacter | null> {
  const voice = await getVoiceCharacterById(id, userId);
  if (!voice || voice.userId !== userId) {
    return null;
  }
  
  const trimmedDataUrl = trimAudioDataUrl(dataUrl);
  const ext = trimmedDataUrl.startsWith('data:audio/wav') ? 'wav' : 'mp3';
  const gcsPath = `killagent/voice-samples/${id}.${ext}`;
  
  const file = await uploadAndCreateFile(userId, trimmedDataUrl, gcsPath, {
    originalFilename: `${voice.name}-sample.${ext}`,
    isPublic: false,
  });
  
  return updateVoiceCharacter(id, userId, { audioSampleFileId: file.id });
}

// ============================================
// Legacy Support
// ============================================

/**
 * Save all voice characters for a user using UPSERT semantics.
 *
 * Same safety rules as saveAllProjectsForUser:
 *  - Empty-array saves are silently ignored when voices already exist in the DB.
 *  - Voices that are no longer in the incoming payload are deleted AFTER all
 *    upserts complete.
 */
export async function saveAllVoiceCharactersForUser(
  userId: string,
  voices: Array<{
    id: string;
    name: string;
    description: string;
    tags?: string[];
    refText?: string;
    isPublic?: boolean;
    projectIds?: string[];
    audioSampleUrl?: string;
    refAudioDataUrl?: string;
    createdAt: string;
    updatedAt: string;
  }>
): Promise<void> {
  // Guard: never wipe existing data with an accidental empty-array save.
  if (voices.length === 0) {
    const countResult = await query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM voice_characters WHERE user_id = $1',
      [userId]
    );
    const existingCount = parseInt(countResult.rows[0]?.count ?? '0', 10);
    if (existingCount > 0) {
      console.log(
        `saveAllVoiceCharactersForUser: skipping empty-array save (${existingCount} voices exist for user)`
      );
      return;
    }
  }

  const incomingVoiceIds: string[] = [];

  for (const voice of voices) {
    incomingVoiceIds.push(voice.id);

    // Upsert voice — never touch user_id or created_at on conflict
    await query(`
      INSERT INTO voice_characters (
        id, user_id, name, description, ref_text, tags, is_public, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        name        = EXCLUDED.name,
        description = EXCLUDED.description,
        ref_text    = EXCLUDED.ref_text,
        tags        = EXCLUDED.tags,
        is_public   = EXCLUDED.is_public,
        updated_at  = EXCLUDED.updated_at
    `, [
      voice.id,
      userId,
      voice.name,
      voice.description,
      voice.refText || null,
      voice.tags || [],
      voice.isPublic ?? false,
      voice.createdAt,
      voice.updatedAt,
    ]);

    const rawAudioData = voice.audioSampleUrl || voice.refAudioDataUrl;
    const audioData = rawAudioData?.startsWith('data:') ? trimAudioDataUrl(rawAudioData) : rawAudioData;
    if (audioData && audioData.startsWith('data:')) {
      const existingRow = await query<{ audio_sample_file_id: string | null; ref_audio_file_id: string | null }>(
        'SELECT audio_sample_file_id, ref_audio_file_id FROM voice_characters WHERE id = $1',
        [voice.id]
      );
      const existing = existingRow.rows[0];
      if (!existing?.audio_sample_file_id && !existing?.ref_audio_file_id) {
        try {
          const ext = audioData.startsWith('data:audio/wav') ? 'wav'
            : audioData.startsWith('data:audio/ogg') ? 'ogg'
            : audioData.startsWith('data:audio/webm') ? 'webm'
            : 'mp3';
          const gcsPath = `killagent/voice-samples/${voice.id}.${ext}`;
          const file = await uploadAndCreateFile(userId, audioData, gcsPath, {
            originalFilename: `${voice.name || 'voice'}-sample.${ext}`,
            isPublic: false,
          });
          await query(
            'UPDATE voice_characters SET audio_sample_file_id = $2, ref_audio_file_id = $2 WHERE id = $1',
            [voice.id, file.id]
          );
          console.log(`Uploaded voice audio for ${voice.id} → file ${file.id}`);
        } catch (err) {
          console.error(`Failed to upload voice audio for ${voice.id}:`, err);
        }
      }
    }

    // Replace project associations (small junction table, always sent in full)
    await query('DELETE FROM voice_character_projects WHERE voice_character_id = $1', [voice.id]);
    for (const projectId of voice.projectIds || []) {
      await query(`
        INSERT INTO voice_character_projects (voice_character_id, project_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [voice.id, projectId]);
    }
  }

  // Delete voices that were removed by the user
  if (incomingVoiceIds.length > 0) {
    await query(
      'DELETE FROM voice_characters WHERE user_id = $1 AND id != ALL($2)',
      [userId, incomingVoiceIds]
    );
  }
  // If voices.length === 0, the guard above already returned early
}
