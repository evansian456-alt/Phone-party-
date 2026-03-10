/**
 * Tests for Section 3: Storage Range Request Support
 * Validates that storage providers correctly handle Range requests (206 Partial Content)
 */

const LocalDiskProvider = require('./storage/localDisk');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

describe('Section 3: Storage Range Request Support', () => {
  let provider;
  const testDir = path.join(__dirname, 'test-storage-tmp');
  
  beforeAll(async () => {
    // Create test storage provider
    process.env.UPLOAD_DIR = testDir;
    // Ensure the test directory exists before initialising the provider
    if (!require('fs').existsSync(testDir)) {
      require('fs').mkdirSync(testDir, { recursive: true });
    }
    provider = new LocalDiskProvider();
    await provider.init();
  });

  afterAll(async () => {
    // Wait for any pending metadata writes to complete before cleaning up
    if (provider && provider.savePromise) {
      await provider.savePromise;
    }

    // Cleanup test directory
    if (fs.existsSync(testDir)) {
      const files = fs.readdirSync(testDir);
      files.forEach(file => {
        fs.unlinkSync(path.join(testDir, file));
      });
      fs.rmdirSync(testDir);
    }
  });

  describe('LocalDisk Provider Range Requests', () => {
    test('should upload file and store metadata', async () => {
      const trackId = 'TEST_TRACK_001';
      const testData = Buffer.from('This is test audio data for range request testing. It should be long enough to test partial content.');
      
      const result = await provider.upload(trackId, testData, {
        contentType: 'audio/mpeg',
        originalName: 'test.mp3',
        size: testData.length
      });

      expect(result.key).toBeDefined();
      expect(result.contentType).toBe('audio/mpeg');
      expect(result.size).toBe(testData.length);
    });

    test('should get metadata for uploaded file', async () => {
      const trackId = 'TEST_TRACK_002';
      const testData = Buffer.from('Test audio data');
      
      await provider.upload(trackId, testData, {
        contentType: 'audio/mpeg',
        originalName: 'test2.mp3',
        size: testData.length
      });

      const metadata = await provider.getMetadata(trackId);
      
      expect(metadata).toBeDefined();
      expect(metadata.contentType).toBe('audio/mpeg');
      expect(metadata.size).toBe(testData.length);
      expect(metadata.key).toContain('TEST_TRACK_002');
    });

    test('should stream full file without range', async () => {
      const trackId = 'TEST_TRACK_003';
      const testData = Buffer.from('Complete audio file data');
      
      await provider.upload(trackId, testData, {
        contentType: 'audio/mpeg',
        originalName: 'test3.mp3',
        size: testData.length
      });

      const result = await provider.stream(trackId);
      
      expect(result).toBeDefined();
      expect(result.stream).toBeDefined();
      expect(result.stream.readable).toBe(true);
      
      // Read stream to buffer
      const chunks = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      
      expect(buffer.toString()).toBe('Complete audio file data');
    });

    test('should stream partial content with Range (bytes=0-10)', async () => {
      const trackId = 'TEST_TRACK_004';
      const testData = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'); // 36 bytes
      
      await provider.upload(trackId, testData, {
        contentType: 'audio/mpeg',
        originalName: 'test4.mp3',
        size: testData.length
      });

      // Request first 11 bytes (0-10 inclusive)
      const result = await provider.stream(trackId, { start: 0, end: 10 });
      
      expect(result).toBeDefined();
      expect(result.stream).toBeDefined();
      
      const chunks = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      
      expect(buffer.toString()).toBe('0123456789A'); // 11 bytes
      expect(buffer.length).toBe(11);
    });

    test('should stream middle range (bytes=10-20)', async () => {
      const trackId = 'TEST_TRACK_005';
      const testData = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      
      await provider.upload(trackId, testData, {
        contentType: 'audio/mpeg',
        originalName: 'test5.mp3',
        size: testData.length
      });

      const result = await provider.stream(trackId, { start: 10, end: 20 });
      
      const chunks = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      
      expect(buffer.toString()).toBe('ABCDEFGHIJK'); // 11 bytes (10-20 inclusive)
    });

    test('should stream to end of file (bytes=30-)', async () => {
      const trackId = 'TEST_TRACK_006';
      const testData = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      
      await provider.upload(trackId, testData, {
        contentType: 'audio/mpeg',
        originalName: 'test6.mp3',
        size: testData.length
      });

      // Request from byte 30 to end (no end specified)
      const result = await provider.stream(trackId, { start: 30 });
      
      const chunks = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      
      expect(buffer.toString()).toBe('UVWXYZ'); // Last 6 bytes
    });

    test('should return null for non-existent track', async () => {
      const metadata = await provider.getMetadata('NON_EXISTENT_TRACK');
      expect(metadata).toBeNull();

      const result = await provider.stream('NON_EXISTENT_TRACK');
      expect(result).toBeNull();
    });

    test('should delete uploaded file', async () => {
      const trackId = 'TEST_TRACK_DELETE';
      const testData = Buffer.from('To be deleted');
      
      await provider.upload(trackId, testData, {
        contentType: 'audio/mpeg',
        originalName: 'delete.mp3',
        size: testData.length
      });

      // Verify it exists
      let metadata = await provider.getMetadata(trackId);
      expect(metadata).toBeDefined();

      // Delete it
      const deleted = await provider.delete(trackId);
      expect(deleted).toBe(true);

      // Verify it's gone
      metadata = await provider.getMetadata(trackId);
      expect(metadata).toBeNull();
    });

    test('should persist metadata across provider restarts', async () => {
      const trackId = 'TEST_TRACK_PERSIST';
      const testData = Buffer.from('Persistent data');
      
      await provider.upload(trackId, testData, {
        contentType: 'audio/mpeg',
        originalName: 'persist.mp3',
        size: testData.length
      });

      // Create new provider instance (simulates restart)
      const newProvider = new LocalDiskProvider();
      await newProvider.init();

      // Should still have metadata
      const metadata = await newProvider.getMetadata(trackId);
      expect(metadata).toBeDefined();
      expect(metadata.size).toBe(testData.length);

      // Cleanup
      await newProvider.delete(trackId);
    });
  });

  describe('Storage Integration - HTTP-like Range Handling', () => {
    test('should support typical browser Range request pattern', async () => {
      const trackId = 'TEST_TRACK_HTTP';
      // Create larger file to simulate real audio
      const testData = Buffer.alloc(1024 * 1024); // 1MB
      testData.fill('A');
      
      await provider.upload(trackId, testData, {
        contentType: 'audio/mpeg',
        originalName: 'large.mp3',
        size: testData.length
      });

      const metadata = await provider.getMetadata(trackId);
      const fileSize = metadata.size;

      // Typical first request: bytes=0-524287 (first 512KB)
      const result1 = await provider.stream(trackId, { start: 0, end: 524287 });
      const chunks1 = [];
      for await (const chunk of result1.stream) {
        chunks1.push(chunk);
      }
      const buffer1 = Buffer.concat(chunks1);
      expect(buffer1.length).toBe(524288); // 512KB

      // Typical second request: bytes=524288-1048575 (next 512KB)
      const result2 = await provider.stream(trackId, { start: 524288, end: 1048575 });
      const chunks2 = [];
      for await (const chunk of result2.stream) {
        chunks2.push(chunk);
      }
      const buffer2 = Buffer.concat(chunks2);
      expect(buffer2.length).toBe(524288);

      // Total should be file size
      expect(buffer1.length + buffer2.length).toBe(fileSize);

      // Cleanup
      await provider.delete(trackId);
    });
  });
});
