# File Upload Security System

## Overview

Abyss implements a comprehensive, Matrix/Element-inspired file upload validation system with defense-in-depth security.

## Architecture

### 1. MediaConfig (`Services/MediaConfig.cs`)

Centralized configuration for all media handling:

#### Per-Category Size Limits
```csharp
["image"]    = 10 MB
["video"]    = 100 MB
["audio"]    = 20 MB
["document"] = 10 MB
["archive"]  = 50 MB
["default"]  = 10 MB
```

#### Allowed Extensions by Category
- **Images**: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`
- **Documents**: `.pdf`, `.txt`, `.md`, `.csv`, `.json`
- **Archives**: `.zip`, `.tar`, `.gz`, `.7z`
- **Audio**: `.mp3`, `.wav`, `.ogg`, `.m4a`, `.flac`
- **Video**: `.mp4`, `.webm`, `.mov`, `.avi`

#### Blocked MIME Types
Explicitly blocks executables and scripts:
- `application/x-msdownload` (.exe)
- `application/x-executable`
- `application/x-sh` (shell scripts)
- `application/x-javascript`
- `text/javascript`
- `application/x-php`
- And more...

### 2. MagicNumberValidator (`Services/MagicNumberValidator.cs`)

Custom magic number (file signature) detection:

- **60+ file signatures** covering all allowed types
- Detects actual file type regardless of extension or MIME type
- Prevents header spoofing attacks
- Fallback text file detection using heuristics

#### Example Signatures
```
JPEG:  FF D8 FF
PNG:   89 50 4E 47 0D 0A 1A 0A
PDF:   25 50 44 46 2D
ZIP:   50 4B 03 04
EXE:   4D 5A (blocked)
```

### 3. MediaValidator (`Services/MediaValidator.cs`)

Comprehensive validation pipeline:

```
1. Basic checks (empty file, extension exists)
   ↓
2. Extension allowlist validation
   ↓
3. Category-specific size limit check
   ↓
4. Magic number detection
   ↓
5. Blocked MIME type check
   ↓
6. MIME type / extension mismatch warning (logged, not rejected)
   ↓
7. Format-specific validation (PDF, archives, etc.)
```

**Philosophy**: Log mismatches but don't reject (Matrix approach - some clients send weird MIME types)

### 4. UploadController (`Controllers/UploadController.cs`)

#### Upload Flow
```
User uploads file
   ↓
MediaValidator.ValidateUploadAsync()
   ↓
Is image? → ImageMagick processing (re-encode to WebP, strip metadata)
Is video? → Store original + ffmpeg poster thumbnail (WebP)
   ↓
Is other? → Copy to disk with validated extension
   ↓
Store attachment metadata with detected MIME type
```

### 5. EmojisController (`Controllers/EmojisController.cs`)

Emoji uploads now use the same validation pipeline with emoji-specific limits:

- Max size: 256KB
- Allowed types: PNG, GIF, WebP, JPEG
- Stored in `/uploads/emojis/*` as WebP (animated GIFs preserved)

Emoji validation uses `MediaValidator` with a custom policy, then processes images via `ImageService`.

#### Download Flow (Matrix-Inspired Security)
```
User requests file
   ↓
Validate attachment exists
   ↓
Revalidate extension is still allowed
   ↓
 If audio/video:
  - X-Content-Type-Options: nosniff
  - Content-Disposition: inline
  - Range-enabled streaming with real MIME type
 Else:
  - X-Content-Type-Options: nosniff
  - Content-Security-Policy: sandbox; default-src 'none';
  - Content-Disposition: attachment (force download)
  - Serve as application/octet-stream
```

## Security Features

### Defense in Depth

1. **Extension Allowlist** - First line of defense
2. **Size Limits** - Per-category, prevents DoS
3. **Magic Numbers** - Validates actual file type
4. **MIME Blocklist** - Blocks known dangerous types
5. **ImageMagick** - Re-encodes images, strips exploits
6. **Security Headers** - Prevents XSS via file content

### Matrix/Element Philosophy

Inspired by Matrix protocol's approach:
- ✅ Permissive but secure (broad allowlist)
- ✅ Focus on safe serving (security headers)
- ✅ Trust validation libraries (ImageMagick)
- ✅ Log suspicious activity, don't blindly reject
- ✅ Graceful degradation (magic number detection failure is non-fatal)

### What We Don't Do (Yet)

**Not Implemented (Production TODO):**
- ❌ Antivirus scanning (ClamAV recommended)
- ❌ Archive extraction validation (zip bomb full check)
- ❌ PDF deep inspection (JavaScript stripping)
- ❌ File quarantine system
- ❌ Rate limiting on uploads

**Why Not:**
These require external dependencies or significant complexity. Current system is production-ready for trusted communities, but consider adding these for public instances.

## Configuration

### Environment Variables

None required - all configured in `MediaConfig.cs`

### Customization

Edit `MediaConfig.cs` to:
- Change size limits per category
- Add/remove allowed extensions
- Adjust blocked MIME types
- Modify compression ratio limits

### Production Hardening

Recommended additional steps for production:

#### 1. Add ClamAV Scanning
```csharp
// Install: nClam NuGet package
var clam = new ClamClient("localhost", 3310);
var scanResult = await clam.SendAndScanFileAsync(fileBytes);
if (scanResult.Result == ClamScanResults.VirusDetected)
    return BadRequest("Malware detected");
```

#### 2. Add Rate Limiting
```csharp
// Install: AspNetCoreRateLimit
services.Configure<IpRateLimitOptions>(options =>
{
    options.GeneralRules = new List<RateLimitRule>
    {
        new RateLimitRule
        {
            Endpoint = "POST:/api/upload",
            Limit = 10,
            Period = "1m"
        }
    };
});
```

#### 3. Consider Object Storage
Move from local filesystem to S3/Azure Blob:
- Better scaling
- CDN integration
- Automatic backups
- Isolated from application server

## Comparison to Other Approaches

### Discord
- Very restrictive file type allowlist
- Aggressive size limits (8MB free, 500MB Nitro)
- Heavy reliance on CDN scanning
- Inline preview for media

### Matrix/Element
- **No validation** - accepts anything
- Relies on encryption + post-upload moderation
- Quarantine system for admins
- Focus on federation compatibility

### Abyss (This Implementation)
- **Hybrid approach**: Matrix's flexibility + Discord's security
- Broad allowlist but with validation
- Per-category limits (more granular)
- Magic number checking
- Safe serving with headers
- ImageMagick for image sanitization

## File Type Handling

### Images ✅
- **Validation**: ImageMagick (validates entire file structure)
- **Processing**: Re-encode to WebP, strip EXIF/metadata
- **Serves as**: `image/webp`
- **Why safe**: Complete re-encoding removes any embedded exploits

### Documents (PDF, TXT, etc.) ⚠️
- **Validation**: Magic numbers + extension check
- **Processing**: None (stored as-is)
- **Serves as**: `application/octet-stream` (force download)
- **Production TODO**: Add PDF parsing with PdfPig, strip JavaScript

### Archives (ZIP, etc.) ⚠️
- **Validation**: Magic numbers + extension check
- **Processing**: None
- **Serves as**: `application/octet-stream` (force download)
- **Production TODO**: Extract and validate with SharpCompress, check compression ratios

### Audio/Video ⚠️
- **Validation**: Magic numbers + extension check
- **Processing**: None
- **Serves as**: `application/octet-stream` (force download)
- **Production TODO**: Validate with FFprobe, check duration/codecs

## Attack Vectors Mitigated

| Attack | Mitigation |
|--------|-----------|
| **Extension spoofing** | Magic number validation |
| **MIME type lying** | Detect real type from content |
| **Executable uploads** | Blocked MIME types + extension allowlist |
| **XSS via SVG/HTML** | Force download with security headers |
| **Image exploits** | ImageMagick re-encoding |
| **Zip bombs** | Size limits + basic validation (full check TODO) |
| **Path traversal** | GUID filenames, controlled storage path |
| **Header injection** | Filename sanitization |
| **DoS via large files** | Per-category size limits |

## Testing

### Manual Testing

Test valid uploads:
```bash
# Valid image
curl -F "file=@test.jpg" http://localhost:5000/api/upload

# Valid PDF
curl -F "file=@test.pdf" http://localhost:5000/api/upload

# Valid archive
curl -F "file=@test.zip" http://localhost:5000/api/upload
```

Test blocked uploads:
```bash
# Extension spoofing (exe renamed to jpg)
curl -F "file=@malware.exe.jpg" http://localhost:5000/api/upload
# Expected: "File type mismatch" (magic number detects exe)

# Blocked type
curl -F "file=@script.sh" http://localhost:5000/api/upload
# Expected: "File type '.sh' is not allowed"

# Too large
curl -F "file=@huge.mp4" http://localhost:5000/api/upload
# Expected: "File too large. Maximum size for video files is 100.0MB"
```

## References

- [Matrix Specification - Content Repository](https://spec.matrix.org/v1.17/client-server-api/#content-repository)
- [Matrix/Element GitHub](https://github.com/element-hq)
- [Synapse Media Configuration](https://matrix-org.github.io/synapse/latest/usage/configuration/config_documentation.html)
- [OWASP - File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)

## Changelog

**2026-02-07** - Initial implementation
- Created MediaConfig, MediaValidator, MagicNumberValidator
- Updated UploadController with comprehensive validation
- Added Matrix-inspired security headers
- Per-category size limits
- Magic number detection for 60+ file types
