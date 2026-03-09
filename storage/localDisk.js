/**
 * Local Disk Storage Provider
 * 
 * Stores uploaded tracks on local filesystem.
 * Suitable for development and single-instance deployments.
 * NOT recommended for production multi-instance deployments (use S3 instead).
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const stream = require('stream');
const { getExtensionFromContentType, getExtensionFromFilename } = require('./utils');

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);
const stat = promisify(fs.stat);
const pipeline = promisify(stream.pipeline);

class LocalDiskProvider {
  constructor() {
    this.uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
    this.metadataFile = path.join(this.uploadDir, '.metadata.json');
    this.metadata = new Map(); // trackId -> { key, contentType, size, createdAt }
    this.savePromise = Promise.resolve(); // Promise queue for serializing metadata writes
  }

  async init() {
    // Ensure upload directory exists
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
      console.log(`[LocalDisk] Created upload directory: ${this.uploadDir}`);
    }

    // Load metadata from disk if exists
    try {
      if (fs.existsSync(this.metadataFile)) {
        const data = await readFile(this.metadataFile, 'utf8');
        const parsed = JSON.parse(data);
        this.metadata = new Map(Object.entries(parsed));
        console.log(`[LocalDisk] Loaded ${this.metadata.size} track metadata entries`);
      }
    } catch (err) {
      console.warn('[LocalDisk] Failed to load metadata file:', err.message);
    }

    console.log(`[LocalDisk] Initialized with directory: ${this.uploadDir}`);
  }

  /**
   * Save metadata to disk (serialized writes to prevent race conditions)
   */
  _saveMetadata() {
    // Chain writes to ensure they happen sequentially
    this.savePromise = this.savePromise.then(async () => {
      try {
        const obj = Object.fromEntries(this.metadata);
        // Write to temp file first, then rename for atomicity
        const tempFile = `${this.metadataFile}.tmp`;
        await writeFile(tempFile, JSON.stringify(obj, null, 2));
        // Rename is atomic on most filesystems
        fs.renameSync(tempFile, this.metadataFile);
      } catch (err) {
        console.error('[LocalDisk] Failed to save metadata:', err.message);
      }
    });
  }

  /**
   * Upload a file
   * @param {string} trackId - Unique track identifier
   * @param {Buffer|Stream} fileData - File data or readable stream
   * @param {object} metadata - { contentType, originalName, size }
   * @returns {Promise<object>} - { key, contentType, size }
   */
  async upload(trackId, fileData, metadata) {
    const ext = getExtensionFromContentType(metadata.contentType) || 
                getExtensionFromFilename(metadata.originalName) || 
                '.bin';
    const key = `${trackId}${ext}`;
    const filepath = path.join(this.uploadDir, key);

    // Ensure upload directory exists before writing
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }

    // Write file
    if (Buffer.isBuffer(fileData)) {
      await writeFile(filepath, fileData);
    } else if (fileData.pipe) {
      // It's a stream
      const writeStream = fs.createWriteStream(filepath);
      await pipeline(fileData, writeStream);
    } else {
      throw new Error('fileData must be Buffer or Stream');
    }

    // Get actual size
    const stats = await stat(filepath);
    const actualSize = stats.size;

    // Store metadata
    const meta = {
      key,
      contentType: metadata.contentType,
      size: actualSize,
      createdAt: Date.now(),
      originalName: metadata.originalName
    };
    this.metadata.set(trackId, meta);

    // Save metadata to disk
    this._saveMetadata();
    await this.savePromise; // Ensure metadata is persisted before returning

    console.log(`[LocalDisk] Uploaded track ${trackId} (${actualSize} bytes) to ${filepath}`);

    return {
      key,
      contentType: metadata.contentType,
      size: actualSize
    };
  }

  /**
   * Get file metadata
   * @param {string} trackId - Unique track identifier
   * @returns {Promise<object|null>} - { key, contentType, size, createdAt } or null if not found
   */
  async getMetadata(trackId) {
    const meta = this.metadata.get(trackId);
    if (!meta) return null;

    // Verify file still exists
    const filepath = path.join(this.uploadDir, meta.key);
    if (!fs.existsSync(filepath)) {
      console.warn(`[LocalDisk] Metadata exists but file missing: ${filepath}`);
      this.metadata.delete(trackId);
      this._saveMetadata();
      return null;
    }

    return meta;
  }

  /**
   * Stream file with Range support
   * @param {string} trackId - Unique track identifier
   * @param {object} options - { start, end } for range requests
   * @returns {Promise<object|null>} - { stream, contentType, size } or null if not found
   */
  async stream(trackId, options = {}) {
    const meta = await this.getMetadata(trackId);
    if (!meta) return null;

    const filepath = path.join(this.uploadDir, meta.key);
    const { start, end } = options;

    let readStream;
    if (start !== undefined || end !== undefined) {
      // Range request
      readStream = fs.createReadStream(filepath, { start, end });
    } else {
      // Full file
      readStream = fs.createReadStream(filepath);
    }

    // Return consistent structure with S3Provider
    return {
      stream: readStream,
      contentType: meta.contentType,
      size: meta.size
    };
  }

  /**
   * Delete a file
   * @param {string} trackId - Unique track identifier
   * @returns {Promise<boolean>} - true if deleted, false if not found
   */
  async delete(trackId) {
    const meta = this.metadata.get(trackId);
    if (!meta) {
      console.log(`[LocalDisk] Track ${trackId} not found for deletion`);
      return false;
    }

    const filepath = path.join(this.uploadDir, meta.key);

    try {
      if (fs.existsSync(filepath)) {
        await unlink(filepath);
        console.log(`[LocalDisk] Deleted file: ${filepath}`);
      }
    } catch (err) {
      console.error(`[LocalDisk] Error deleting file ${filepath}:`, err.message);
    }

    this.metadata.delete(trackId);
    this._saveMetadata();

    return true;
  }
}

module.exports = LocalDiskProvider;
