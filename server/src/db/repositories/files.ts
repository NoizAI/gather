/**
 * Files Repository
 * Handles file metadata storage and GCS signed URL generation
 */

import { query } from '../index.js';
import * as gcs from '../../services/gcs.js';

// ============================================
// Types
// ============================================

export interface FileRecord {
  id: string;
  userId?: string;
  gcsBucket: string;
  gcsPath: string;
  originalFilename?: string;
  mimeType: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  isPublic: boolean;
  deletedAt?: string;
  createdAt: string;
}

export interface FileWithUrl extends FileRecord {
  url: string;  // Signed URL or public URL
  urlExpiresAt?: string;  // When the signed URL expires
}

export interface CreateFileInput {
  userId?: string;
  gcsBucket: string;
  gcsPath: string;
  originalFilename?: string;
  mimeType: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  isPublic?: boolean;
}

// ============================================
// Database Row Types
// ============================================

interface FileRow {
  id: string;
  user_id: string | null;
  gcs_bucket: string;
  gcs_path: string;
  original_filename: string | null;
  mime_type: string;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  is_public: boolean;
  deleted_at: Date | null;
  created_at: Date;
}

// ============================================
// Constants
// ============================================

// Default signed URL expiration in minutes
const DEFAULT_URL_EXPIRATION_MINUTES = 60;

// For public files, use direct GCS URL
const PUBLIC_URL_PREFIX = 'https://storage.googleapis.com';

// ============================================
// Helper Functions
// ============================================

function mapFileRow(row: FileRow): FileRecord {
  return {
    id: row.id,
    userId: row.user_id || undefined,
    gcsBucket: row.gcs_bucket,
    gcsPath: row.gcs_path,
    originalFilename: row.original_filename || undefined,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes || undefined,
    width: row.width || undefined,
    height: row.height || undefined,
    durationSeconds: row.duration_seconds || undefined,
    isPublic: row.is_public,
    deletedAt: row.deleted_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Generate URL for a file (signed or public)
 */
export async function generateFileUrl(
  file: FileRecord,
  expirationMinutes: number = DEFAULT_URL_EXPIRATION_MINUTES
): Promise<{ url: string; expiresAt?: string }> {
  const publicUrl = `${PUBLIC_URL_PREFIX}/${file.gcsBucket}/${file.gcsPath}`;

  if (file.isPublic) {
    return { url: publicUrl };
  }
  
  // Private files use signed URL; fall back to public URL if signing fails
  // (e.g. when using Application Default Credentials without a service account key)
  try {
    const expiresAt = new Date(Date.now() + expirationMinutes * 60 * 1000);
    const url = await gcs.getSignedUrl(file.gcsPath, expirationMinutes);
    return { url, expiresAt: expiresAt.toISOString() };
  } catch (error) {
    if (!_signWarningLogged) {
      console.warn('GCS: Cannot generate signed URLs (missing service account key?). Falling back to public URLs.');
      _signWarningLogged = true;
    }
    return { url: publicUrl };
  }
}

let _signWarningLogged = false;

/**
 * Add URL to file record
 */
export async function addUrlToFile(
  file: FileRecord,
  expirationMinutes?: number
): Promise<FileWithUrl> {
  const { url, expiresAt } = await generateFileUrl(file, expirationMinutes);
  return {
    ...file,
    url,
    urlExpiresAt: expiresAt,
  };
}

/**
 * Add URLs to multiple file records
 */
export async function addUrlsToFiles(
  files: FileRecord[],
  expirationMinutes?: number
): Promise<FileWithUrl[]> {
  return Promise.all(
    files.map(file => addUrlToFile(file, expirationMinutes))
  );
}

// ============================================
// CRUD Operations
// ============================================

/**
 * Create a file record
 */
export async function createFile(input: CreateFileInput): Promise<FileRecord> {
  const result = await query<FileRow>(`
    INSERT INTO files (
      user_id, gcs_bucket, gcs_path, original_filename, mime_type,
      size_bytes, width, height, duration_seconds, is_public
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `, [
    input.userId || null,
    input.gcsBucket,
    input.gcsPath,
    input.originalFilename || null,
    input.mimeType,
    input.sizeBytes || null,
    input.width || null,
    input.height || null,
    input.durationSeconds || null,
    input.isPublic ?? false,
  ]);
  
  return mapFileRow(result.rows[0]);
}

/**
 * Get file by ID
 */
export async function getFileById(id: string): Promise<FileRecord | null> {
  const result = await query<FileRow>(`
    SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL
  `, [id]);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  return mapFileRow(result.rows[0]);
}

/**
 * Get file by ID with URL
 */
export async function getFileByIdWithUrl(
  id: string,
  expirationMinutes?: number
): Promise<FileWithUrl | null> {
  const file = await getFileById(id);
  if (!file) {
    return null;
  }
  
  return addUrlToFile(file, expirationMinutes);
}

/**
 * Get file by GCS path
 */
export async function getFileByPath(gcsPath: string): Promise<FileRecord | null> {
  const result = await query<FileRow>(`
    SELECT * FROM files WHERE gcs_path = $1 AND deleted_at IS NULL
  `, [gcsPath]);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  return mapFileRow(result.rows[0]);
}

/**
 * Get files by user ID
 */
export async function getFilesByUserId(userId: string): Promise<FileRecord[]> {
  const result = await query<FileRow>(`
    SELECT * FROM files 
    WHERE user_id = $1 AND deleted_at IS NULL
    ORDER BY created_at DESC
  `, [userId]);
  
  return result.rows.map(mapFileRow);
}

/**
 * Update file public status
 */
export async function updateFilePublicStatus(
  id: string,
  isPublic: boolean
): Promise<FileRecord | null> {
  const result = await query<FileRow>(`
    UPDATE files SET is_public = $2
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING *
  `, [id, isPublic]);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  return mapFileRow(result.rows[0]);
}

/**
 * Soft delete a file
 */
export async function deleteFile(id: string): Promise<boolean> {
  const result = await query(`
    UPDATE files SET deleted_at = NOW()
    WHERE id = $1
  `, [id]);
  
  return (result.rowCount ?? 0) > 0;
}

/**
 * Hard delete a file (also removes from GCS)
 */
export async function hardDeleteFile(id: string): Promise<boolean> {
  const file = await getFileById(id);
  if (!file) {
    return false;
  }
  
  // Delete from GCS
  await gcs.deleteFile(file.gcsPath);
  
  // Delete from database
  const result = await query(`
    DELETE FROM files WHERE id = $1
  `, [id]);
  
  return (result.rowCount ?? 0) > 0;
}

/**
 * Clean up soft-deleted files (older than specified days)
 */
export async function cleanupDeletedFiles(olderThanDays: number = 30): Promise<number> {
  // Get files to delete
  const filesToDelete = await query<FileRow>(`
    SELECT * FROM files 
    WHERE deleted_at IS NOT NULL 
    AND deleted_at < NOW() - INTERVAL '${olderThanDays} days'
  `);
  
  let deletedCount = 0;
  
  for (const row of filesToDelete.rows) {
    const file = mapFileRow(row);
    try {
      // Delete from GCS
      await gcs.deleteFile(file.gcsPath);
      
      // Delete from database
      await query('DELETE FROM files WHERE id = $1', [file.id]);
      deletedCount++;
    } catch (error) {
      console.error(`Failed to delete file ${file.id}:`, error);
    }
  }
  
  return deletedCount;
}

// ============================================
// Batch URL Generation
// ============================================

/**
 * Generate signed URLs for multiple file IDs
 */
export async function generateUrlsForFileIds(
  fileIds: string[],
  expirationMinutes?: number
): Promise<Map<string, string>> {
  if (fileIds.length === 0) {
    return new Map();
  }
  
  const result = await query<FileRow>(`
    SELECT * FROM files 
    WHERE id = ANY($1) AND deleted_at IS NULL
  `, [fileIds]);
  
  const urlMap = new Map<string, string>();
  
  await Promise.all(
    result.rows.map(async (row) => {
      const file = mapFileRow(row);
      const { url } = await generateFileUrl(file, expirationMinutes);
      urlMap.set(file.id, url);
    })
  );
  
  return urlMap;
}

// ============================================
// Upload Helper
// ============================================

/**
 * Upload a file to GCS and create a database record
 */
export async function uploadAndCreateFile(
  userId: string | undefined,
  dataUrl: string,
  gcsPath: string,
  options: {
    originalFilename?: string;
    isPublic?: boolean;
    width?: number;
    height?: number;
    durationSeconds?: number;
  } = {}
): Promise<FileWithUrl> {
  // Parse data URL to get mime type and size
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) {
    throw new Error('Invalid data URL format');
  }
  
  const mimeType = matches[1];
  const base64Data = matches[2];
  const buffer = Buffer.from(base64Data, 'base64');
  const sizeBytes = buffer.length;
  
  // Upload to GCS
  await gcs.uploadBase64File(gcsPath, dataUrl);
  
  // Get bucket name
  const gcsBucket = process.env.GCS_BUCKET || '';
  
  // Create database record
  const file = await createFile({
    userId,
    gcsBucket,
    gcsPath,
    originalFilename: options.originalFilename,
    mimeType,
    sizeBytes,
    width: options.width,
    height: options.height,
    durationSeconds: options.durationSeconds,
    isPublic: options.isPublic,
  });
  
  // Return with URL
  return addUrlToFile(file);
}
