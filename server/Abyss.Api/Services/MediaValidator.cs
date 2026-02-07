namespace Abyss.Api.Services;

/// <summary>
/// Validates uploaded media files using magic number detection and format-specific checks.
/// Inspired by Matrix's permissive approach but with centralized security controls.
/// </summary>
public class MediaValidator
{
    private readonly MediaConfig _config;
    private readonly ILogger<MediaValidator> _logger;

    public MediaValidator(MediaConfig config, ILogger<MediaValidator> logger)
    {
        _config = config;
        _logger = logger;
    }

    /// <summary>
    /// Comprehensive validation result.
    /// </summary>
    public record ValidationResult(
        bool IsValid,
        string? ErrorMessage = null,
        string? DetectedMimeType = null,
        string? Category = null
    );

    /// <summary>
    /// Validate an uploaded file comprehensively.
    /// </summary>
    public async Task<ValidationResult> ValidateUploadAsync(IFormFile file)
    {
        // 1. Basic checks
        if (file.Length == 0)
            return new ValidationResult(false, "File is empty");

        var ext = Path.GetExtension(file.FileName);
        if (string.IsNullOrEmpty(ext))
            return new ValidationResult(false, "File has no extension");

        // 2. Extension allowlist check
        var (isAllowed, category, maxSize) = _config.ValidateExtension(ext);
        if (!isAllowed)
            return new ValidationResult(false, $"File type '{ext}' is not allowed");

        // 3. Size limit check (category-specific)
        if (file.Length > maxSize)
        {
            var sizeMB = maxSize / (1024.0 * 1024.0);
            return new ValidationResult(false, $"File too large. Maximum size for {category} files is {sizeMB:F1}MB");
        }

        // 4. Magic number validation
        string? detectedMimeType = null;
        try
        {
            using var stream = file.OpenReadStream();
            detectedMimeType = MagicNumberValidator.DetectMimeType(stream);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to detect MIME type for file {FileName}", file.FileName);
            // Continue - magic number detection failure is not fatal
        }

        // 5. Check if detected MIME type is blocked
        if (detectedMimeType != null && _config.IsMimeTypeBlocked(detectedMimeType))
        {
            _logger.LogWarning("Blocked file upload with MIME type {MimeType}: {FileName}", detectedMimeType, file.FileName);
            return new ValidationResult(false, "This file type is not allowed for security reasons");
        }

        // 6. Validate MIME type matches extension (if detected)
        if (detectedMimeType != null && !_config.MimeTypeMatchesExtension(ext, detectedMimeType))
        {
            _logger.LogWarning(
                "MIME type mismatch: file {FileName} has extension {Extension} but detected as {MimeType}",
                file.FileName, ext, detectedMimeType
            );
            // Matrix approach: log warning but don't reject - some clients send weird MIME types
            // You could make this stricter by returning ValidationResult(false, "File type mismatch")
        }

        return new ValidationResult(true, null, detectedMimeType, category);
    }

    /// <summary>
    /// Validate archive files for zip bombs.
    /// Note: This is a basic check. Full extraction would be needed for comprehensive validation.
    /// </summary>
    public ValidationResult ValidateArchive(IFormFile file)
    {
        // Basic check: if compressed size is suspiciously small compared to what it claims
        // Full validation would require SharpCompress and actual extraction
        // For now, we just ensure the file isn't claiming to be impossibly compressed

        var ext = Path.GetExtension(file.FileName);
        if (ext.Equals(".zip", StringComparison.OrdinalIgnoreCase))
        {
            // Reject files that are suspiciously small
            // A 1KB zip claiming to be valid is likely a zip bomb or corrupted
            if (file.Length < 100)
            {
                return new ValidationResult(false, "Archive file appears to be invalid or corrupted");
            }
        }

        // TODO: For production, consider adding SharpCompress validation:
        // - Check actual decompressed size
        // - Validate compression ratio
        // - Scan for path traversal in entry names

        return new ValidationResult(true);
    }

    /// <summary>
    /// Validate PDF files for structure issues.
    /// </summary>
    public async Task<ValidationResult> ValidatePdfAsync(Stream stream)
    {
        // TODO: For production, consider adding PdfPig validation:
        // - Validate PDF structure
        // - Check page count limits
        // - Strip JavaScript/active content
        // - Re-flatten if needed

        // For now, basic check
        try
        {
            var header = new byte[5];
            await stream.ReadExactlyAsync(header, 0, 5);
            stream.Position = 0;

            // Check PDF magic number: %PDF-
            if (header[0] == 0x25 && header[1] == 0x50 && header[2] == 0x44 && header[3] == 0x46 && header[4] == 0x2D)
            {
                return new ValidationResult(true);
            }

            return new ValidationResult(false, "Invalid PDF file");
        }
        catch
        {
            return new ValidationResult(false, "Failed to validate PDF");
        }
    }
}
