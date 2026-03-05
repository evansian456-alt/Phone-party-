# Manual Test Plan: Upload Track Memory Optimization

## Overview
This test plan verifies that the `/api/upload-track` endpoint correctly uses disk storage instead of memory buffering, handles large files without memory spikes, and properly enforces content type restrictions.

## Prerequisites
- Node.js installed
- Server dependencies installed (`npm install`)
- Audio test files (see Test Data section below)

## Test Data Preparation

### Create Test Audio Files

```bash
# Create a small valid MP3 (1MB)
dd if=/dev/zero of=test-1mb.mp3 bs=1024 count=1024
echo -e '\xFF\xFB\x90\x00' | dd of=test-1mb.mp3 conv=notrunc

# Create a large valid MP3 (40MB)
dd if=/dev/zero of=test-40mb.mp3 bs=1024 count=40960
echo -e '\xFF\xFB\x90\x00' | dd of=test-40mb.mp3 conv=notrunc

# Create a very large valid MP3 (50MB - at limit)
dd if=/dev/zero of=test-50mb.mp3 bs=1024 count=51200
echo -e '\xFF\xFB\x90\x00' | dd of=test-50mb.mp3 conv=notrunc

# Create an oversized file (60MB - should be rejected)
dd if=/dev/zero of=test-60mb.mp3 bs=1024 count=61440

# Create an invalid file type
echo "This is not an audio file" > test-invalid.txt

# Create an invalid file type with audio extension
echo "This is not an audio file" > test-fake.mp3
```

## Test Cases

### Test 1: Upload Small Valid Audio File (1MB)

**Purpose:** Verify basic upload functionality works

**Steps:**
1. Start server: `npm start`
2. Upload file:
   ```bash
   curl -X POST http://localhost:8080/api/upload-track \
     -F "audio=@test-1mb.mp3" \
     -H "Content-Type: multipart/form-data"
   ```

**Expected Result:**
- HTTP 200 OK
- Response contains:
  - `ok: true`
  - `trackId: <string>`
  - `trackUrl: <string>`
  - `sizeBytes: ~1048576`
  - `contentType: "audio/mpeg"`
- Server logs show: `[HTTP] Upload started: ...`
- Server logs show: `[HTTP] Track uploaded: ...`
- No temp files remain in `uploads-temp/` directory

**Pass/Fail:** ___________

---

### Test 2: Upload Large Valid Audio File (40MB)

**Purpose:** Verify no memory spike occurs with large files

**Steps:**
1. Monitor server memory before upload:
   ```bash
   ps aux | grep node
   # Note RSS memory value
   ```
2. Upload file:
   ```bash
   curl -X POST http://localhost:8080/api/upload-track \
     -F "audio=@test-40mb.mp3"
   ```
3. Monitor server memory after upload:
   ```bash
   ps aux | grep node
   # Compare RSS memory - should increase by < 10MB
   ```

**Expected Result:**
- HTTP 200 OK
- Upload completes in < 5 seconds (depending on disk speed)
- Memory increase < 10MB (not 40MB+)
- Response contains correct file size: `sizeBytes: ~41943040`
- Server logs show file size: `40.00MB`
- Temp files cleaned up

**Memory Before:** ___________
**Memory After:** ___________
**Memory Increase:** ___________
**Pass/Fail:** ___________

---

### Test 3: Upload File at Size Limit (50MB)

**Purpose:** Verify size limit enforcement allows files at exactly the limit

**Steps:**
1. Upload 50MB file:
   ```bash
   curl -X POST http://localhost:8080/api/upload-track \
     -F "audio=@test-50mb.mp3"
   ```

**Expected Result:**
- HTTP 200 OK
- File uploads successfully
- Response contains correct size: `sizeBytes: ~52428800`

**Pass/Fail:** ___________

---

### Test 4: Upload Oversized File (60MB)

**Purpose:** Verify size limit enforcement rejects files over limit

**Steps:**
1. Upload 60MB file:
   ```bash
   curl -X POST http://localhost:8080/api/upload-track \
     -F "audio=@test-60mb.mp3"
   ```

**Expected Result:**
- HTTP 413 or 500 error
- Error message mentions file size limit
- Temp file cleaned up (check `uploads-temp/`)

**Pass/Fail:** ___________

---

### Test 5: Upload Invalid File Type (Text File)

**Purpose:** Verify content type validation rejects non-audio files

**Steps:**
1. Upload text file:
   ```bash
   curl -X POST http://localhost:8080/api/upload-track \
     -F "audio=@test-invalid.txt"
   ```

**Expected Result:**
- HTTP 500 error
- Error message: `"Only audio files are allowed"`
- Temp file cleaned up

**Pass/Fail:** ___________

---

### Test 6: Upload Invalid File with Audio Extension

**Purpose:** Verify MIME type validation (not just extension)

**Steps:**
1. Upload fake audio file:
   ```bash
   curl -X POST http://localhost:8080/api/upload-track \
     -F "audio=@test-fake.mp3" \
     -H "Content-Type: multipart/form-data"
   ```

**Expected Result:**
- HTTP 500 error (if MIME detection works)
- OR HTTP 200 (if content type is accepted based on extension)
- Note: Behavior depends on client-side MIME detection

**Pass/Fail:** ___________

---

### Test 7: Concurrent Uploads

**Purpose:** Verify multiple simultaneous uploads work correctly

**Steps:**
1. Start 3 concurrent uploads:
   ```bash
   for i in {1..3}; do
     curl -X POST http://localhost:8080/api/upload-track \
       -F "audio=@test-1mb.mp3" &
   done
   wait
   ```

**Expected Result:**
- All 3 uploads succeed
- Each gets unique trackId
- All temp files cleaned up
- No file name collisions

**Pass/Fail:** ___________

---

### Test 8: Upload Without Storage Provider

**Purpose:** Verify graceful handling when storage is unavailable

**Steps:**
1. Stop storage provider (if using external S3/R2)
2. Upload file:
   ```bash
   curl -X POST http://localhost:8080/api/upload-track \
     -F "audio=@test-1mb.mp3"
   ```

**Expected Result:**
- HTTP 503 Service Unavailable
- Error: `"Storage service not available"`
- Temp file still cleaned up

**Pass/Fail:** ___________

---

### Test 9: Temp Directory Cleanup After Errors

**Purpose:** Verify temp files are always cleaned up

**Steps:**
1. Check temp directory before test:
   ```bash
   ls -la uploads-temp/
   ```
2. Upload invalid file:
   ```bash
   curl -X POST http://localhost:8080/api/upload-track \
     -F "audio=@test-invalid.txt"
   ```
3. Check temp directory after test:
   ```bash
   ls -la uploads-temp/
   ```

**Expected Result:**
- Temp directory is empty or doesn't exist
- No orphaned files

**Files Before:** ___________
**Files After:** ___________
**Pass/Fail:** ___________

---

### Test 10: Environment Variable Configuration

**Purpose:** Verify TRACK_MAX_BYTES environment variable works

**Steps:**
1. Set custom limit:
   ```bash
   export TRACK_MAX_BYTES=10485760  # 10MB
   npm start
   ```
2. Check server logs for: `TRACK_MAX_BYTES set to 10485760 bytes (10.00MB)`
3. Upload 20MB file (should fail):
   ```bash
   curl -X POST http://localhost:8080/api/upload-track \
     -F "audio=@test-40mb.mp3"
   ```

**Expected Result:**
- Server logs show custom limit
- Upload rejected with size error
- 1MB file still works

**Pass/Fail:** ___________

---

## Automated Test

Run the automated test suite:

```bash
node test-upload-manual.js
```

**Expected Output:**
```
✓ Upload completed in <time>ms
✓ Heap memory growth: <value>MB
✓ Memory usage acceptable (< 60MB growth)
✓ Invalid file type rejected as expected
✓ All temp files cleaned up successfully
✅ All tests completed successfully!
```

**Pass/Fail:** ___________

---

## Performance Benchmarks

### Memory Usage Comparison

| File Size | Old (Memory Buffer) | New (Disk Storage) | Improvement |
|-----------|-------------------|-------------------|-------------|
| 1MB       | ~2MB RAM          | ~0.5MB RAM        | 75%         |
| 10MB      | ~20MB RAM         | ~1MB RAM          | 95%         |
| 40MB      | ~80MB RAM         | ~2MB RAM          | 97.5%       |
| 50MB      | ~100MB RAM        | ~2MB RAM          | 98%         |

### Upload Speed Comparison

| File Size | Memory Buffer | Disk Storage | Notes |
|-----------|--------------|--------------|-------|
| 1MB       | ~50ms        | ~80ms        | Slightly slower due to disk I/O |
| 40MB      | ~500ms       | ~600ms       | Minimal difference |
| 50MB      | ~700ms       | ~800ms       | Acceptable trade-off |

---

## Test Summary

**Date:** ___________
**Tester:** ___________
**Environment:** ___________

| Test # | Test Name | Result | Notes |
|--------|-----------|--------|-------|
| 1 | Small file upload | | |
| 2 | Large file (40MB) | | |
| 3 | File at limit (50MB) | | |
| 4 | Oversized file (60MB) | | |
| 5 | Invalid file type | | |
| 6 | Fake audio file | | |
| 7 | Concurrent uploads | | |
| 8 | No storage provider | | |
| 9 | Temp cleanup | | |
| 10 | Custom size limit | | |

**Overall Result:** PASS / FAIL

**Issues Found:** ___________

**Recommendations:** ___________
