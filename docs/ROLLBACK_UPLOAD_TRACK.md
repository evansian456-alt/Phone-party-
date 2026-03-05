# Rollback Instructions: Upload Track Memory Optimization

## Summary
This change replaced multer's memory storage with disk storage to prevent memory buffering of large audio files during upload. If issues arise, follow these instructions to rollback.

## Quick Rollback (Git)

```bash
# Rollback to previous commit
git revert HEAD

# Or reset to specific commit before changes (use with caution on shared branches)
git reset --hard <commit-hash-before-changes>
git push --force-with-lease  # Safer than --force, prevents overwriting others' work
```

## Manual Rollback

If you need to manually revert the changes, edit `server.js`:

### 1. Revert Multer Configuration (around line 780-830)

**REMOVE:**
```javascript
// Configure TRACK_MAX_BYTES from environment (default 50MB)
const DEFAULT_TRACK_MAX_BYTES = 50 * 1024 * 1024; // 50MB
const TRACK_MAX_BYTES = (() => {
  const raw = process.env.TRACK_MAX_BYTES;
  
  if (!raw) {
    console.log(`[Config] TRACK_MAX_BYTES not set. Using default ${DEFAULT_TRACK_MAX_BYTES} bytes (${DEFAULT_TRACK_MAX_BYTES / 1024 / 1024}MB)`);
    return DEFAULT_TRACK_MAX_BYTES;
  }
  
  const parsed = parseInt(raw, 10);
  
  if (isNaN(parsed) || parsed <= 0) {
    console.warn(`[Config] Invalid TRACK_MAX_BYTES value: "${raw}". Using default ${DEFAULT_TRACK_MAX_BYTES} bytes`);
    return DEFAULT_TRACK_MAX_BYTES;
  }

  console.log(`[Config] TRACK_MAX_BYTES set to ${parsed} bytes (${(parsed / 1024 / 1024).toFixed(2)}MB)`);
  return parsed;
})();

// Configure multer for file uploads - use disk storage to avoid memory buffering
const multerStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Use temp directory for uploaded files
    const uploadTempDir = path.join(__dirname, 'uploads-temp');
    if (!fs.existsSync(uploadTempDir)) {
      fs.mkdirSync(uploadTempDir, { recursive: true });
    }
    cb(null, uploadTempDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename to avoid collisions
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'upload-' + uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage: multerStorage,
  limits: {
    fileSize: TRACK_MAX_BYTES
  },
  fileFilter: function (req, file, cb) {
    // Accept audio files only
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});
```

**REPLACE WITH:**
```javascript
// Configure multer for file uploads - use memory storage to pass to storage provider
const multerStorage = multer.memoryStorage();

const upload = multer({
  storage: multerStorage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max file size
  },
  fileFilter: function (req, file, cb) {
    // Accept audio files only
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});
```

### 2. Revert Upload Handler (around line 1853-1930)

**REMOVE:**
```javascript
// POST /api/upload-track - Upload audio file from host
app.post("/api/upload-track", upload.single('audio'), async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[HTTP] POST /api/upload-track at ${timestamp}`);
  
  let tempFilePath = null;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    // Check storage provider is ready
    if (!storageProvider) {
      console.error('[HTTP] Storage provider not initialized');
      // Clean up temp file if present
      if (req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(503).json({ error: 'Storage service not available' });
    }
    
    // Generate unique track ID
    const trackId = customAlphabet('1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', 12)();
    
    // Get file info
    const originalName = req.file.originalname;
    const sizeBytes = req.file.size;
    const contentType = req.file.mimetype;
    tempFilePath = req.file.path;
    
    console.log(`[HTTP] Upload started: ${trackId}, file: ${originalName}, size: ${sizeBytes} bytes (${(sizeBytes / 1024 / 1024).toFixed(2)}MB)`);
    
    // Create read stream from temp file
    const fileStream = fs.createReadStream(tempFilePath);
    
    // Upload to storage provider using stream
    const uploadResult = await storageProvider.upload(trackId, fileStream, {
      contentType,
      originalName,
      size: sizeBytes
    });
    
    // Clean up temp file after successful upload
    try {
      fs.unlinkSync(tempFilePath);
      tempFilePath = null;
    } catch (cleanupError) {
      console.warn(`[HTTP] Warning: Failed to cleanup temp file ${tempFilePath}:`, cleanupError.message);
    }
    
    // ... rest of handler ...
    
  } catch (error) {
    console.error(`[HTTP] Error uploading track:`, error);
    
    // Clean up temp file on error
    if (tempFilePath) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupError) {
        console.warn(`[HTTP] Warning: Failed to cleanup temp file ${tempFilePath} after error:`, cleanupError.message);
      }
    }
    
    res.status(500).json({ 
      error: 'Failed to upload track',
      details: error.message 
    });
  }
});
```

**REPLACE WITH:**
```javascript
// POST /api/upload-track - Upload audio file from host
app.post("/api/upload-track", upload.single('audio'), async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[HTTP] POST /api/upload-track at ${timestamp}`);
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    // Check storage provider is ready
    if (!storageProvider) {
      console.error('[HTTP] Storage provider not initialized');
      return res.status(503).json({ error: 'Storage service not available' });
    }
    
    // Generate unique track ID
    const trackId = customAlphabet('1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', 12)();
    
    // Get file info
    const originalName = req.file.originalname;
    const sizeBytes = req.file.size;
    const contentType = req.file.mimetype;
    const fileBuffer = req.file.buffer;
    
    // Upload to storage provider
    const uploadResult = await storageProvider.upload(trackId, fileBuffer, {
      contentType,
      originalName,
      size: sizeBytes
    });
    
    // ... rest of handler ...
    
  } catch (error) {
    console.error(`[HTTP] Error uploading track:`, error);
    res.status(500).json({ 
      error: 'Failed to upload track',
      details: error.message 
    });
  }
});
```

### 3. Revert .gitignore (optional)

Remove the line `uploads-temp/` from `.gitignore` if desired.

### 4. Revert .env.example (optional)

Remove the TRACK_MAX_BYTES documentation if desired.

## Verification After Rollback

1. Restart the server
2. Test file upload:
   ```bash
   curl -X POST http://localhost:8080/api/upload-track \
     -F "audio=@test.mp3"
   ```
3. Verify upload works correctly
4. Memory buffering will return (expected behavior in old version)

## Why You Might Need to Rollback

- Disk I/O performance issues on slow storage
- Temp directory permissions problems
- Unexpected file system errors
- Storage provider incompatibility with streaming

## Support

If you encounter issues after rollback, check:
- Server logs for errors
- Storage provider configuration
- File permissions on uploads directory
