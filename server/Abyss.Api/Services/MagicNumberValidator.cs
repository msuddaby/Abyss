namespace Abyss.Api.Services;

/// <summary>
/// Validates file types using magic numbers (file signatures).
/// More secure than relying on client-provided MIME types or extensions.
/// </summary>
public class MagicNumberValidator
{
    /// <summary>
    /// Known file signatures (magic numbers) mapped to MIME types.
    /// </summary>
    private static readonly Dictionary<byte[], string> FileSignatures = new()
    {
        // Images
        { new byte[] { 0xFF, 0xD8, 0xFF }, "image/jpeg" },                    // JPEG
        { new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }, "image/png" }, // PNG
        { new byte[] { 0x47, 0x49, 0x46, 0x38, 0x37, 0x61 }, "image/gif" },   // GIF87a
        { new byte[] { 0x47, 0x49, 0x46, 0x38, 0x39, 0x61 }, "image/gif" },   // GIF89a
        { new byte[] { 0x52, 0x49, 0x46, 0x46 }, "image/webp" },              // WEBP (RIFF)
        { new byte[] { 0x42, 0x4D }, "image/bmp" },                           // BMP

        // Documents
        { new byte[] { 0x25, 0x50, 0x44, 0x46, 0x2D }, "application/pdf" },   // PDF

        // Archives
        { new byte[] { 0x50, 0x4B, 0x03, 0x04 }, "application/zip" },         // ZIP
        { new byte[] { 0x50, 0x4B, 0x05, 0x06 }, "application/zip" },         // ZIP (empty)
        { new byte[] { 0x50, 0x4B, 0x07, 0x08 }, "application/zip" },         // ZIP (spanned)
        { new byte[] { 0x1F, 0x8B, 0x08 }, "application/gzip" },              // GZIP
        { new byte[] { 0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C }, "application/x-7z-compressed" }, // 7Z

        // Audio
        { new byte[] { 0xFF, 0xFB }, "audio/mpeg" },                          // MP3
        { new byte[] { 0xFF, 0xF3 }, "audio/mpeg" },                          // MP3
        { new byte[] { 0xFF, 0xF2 }, "audio/mpeg" },                          // MP3
        { new byte[] { 0x49, 0x44, 0x33 }, "audio/mpeg" },                    // MP3 (ID3)
        { new byte[] { 0x52, 0x49, 0x46, 0x46 }, "audio/wav" },               // WAV (RIFF)
        { new byte[] { 0x4F, 0x67, 0x67, 0x53 }, "audio/ogg" },               // OGG
        { new byte[] { 0x66, 0x4C, 0x61, 0x43 }, "audio/flac" },              // FLAC

        // Video
        { new byte[] { 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D }, "video/mp4" }, // MP4
        { new byte[] { 0x66, 0x74, 0x79, 0x70, 0x6D, 0x70, 0x34, 0x32 }, "video/mp4" }, // MP4
        { new byte[] { 0x1A, 0x45, 0xDF, 0xA3 }, "video/webm" },              // WEBM
        { new byte[] { 0x52, 0x49, 0x46, 0x46 }, "video/avi" },               // AVI (RIFF)

        // Executables (for blocking)
        { new byte[] { 0x4D, 0x5A }, "application/x-msdownload" },            // EXE
        { new byte[] { 0x7F, 0x45, 0x4C, 0x46 }, "application/x-executable" }, // ELF
        { new byte[] { 0x23, 0x21 }, "text/x-shellscript" },                  // Shell script (#!)
    };

    /// <summary>
    /// Detect MIME type from file content using magic numbers.
    /// </summary>
    public static string? DetectMimeType(Stream stream)
    {
        if (!stream.CanRead || !stream.CanSeek)
            return null;

        var originalPosition = stream.Position;

        try
        {
            // Read first 16 bytes (enough for most magic numbers)
            var buffer = new byte[16];
            stream.Position = 0;
            var bytesRead = stream.Read(buffer, 0, buffer.Length);

            if (bytesRead == 0)
                return null;

            // Check each known signature
            foreach (var (signature, mimeType) in FileSignatures)
            {
                if (bytesRead >= signature.Length && BufferStartsWith(buffer, signature))
                {
                    return mimeType;
                }
            }

            // Special cases that need offset checking

            // Check for MP4 variants (ftyp at offset 4)
            if (bytesRead >= 12)
            {
                if (buffer[4] == 0x66 && buffer[5] == 0x74 && buffer[6] == 0x79 && buffer[7] == 0x70)
                {
                    return "video/mp4";
                }
            }

            // Check for M4A (ftyp M4A at offset 4)
            if (bytesRead >= 8)
            {
                if (buffer[4] == 0x66 && buffer[5] == 0x74 && buffer[6] == 0x79 && buffer[7] == 0x70)
                {
                    stream.Position = 8;
                    var subtype = new byte[4];
                    stream.Read(subtype, 0, 4);
                    if (subtype[0] == 0x4D && subtype[1] == 0x34 && subtype[2] == 0x41) // M4A
                    {
                        return "audio/mp4";
                    }
                }
            }

            // Text files (as fallback)
            stream.Position = 0;
            var testBuffer = new byte[Math.Min(512, (int)stream.Length)];
            var testRead = stream.Read(testBuffer, 0, testBuffer.Length);

            // Check if file appears to be text (no control chars except whitespace)
            if (IsLikelyTextFile(testBuffer, testRead))
            {
                return "text/plain";
            }

            return null; // Unknown type
        }
        finally
        {
            stream.Position = originalPosition;
        }
    }

    /// <summary>
    /// Check if buffer starts with signature.
    /// </summary>
    private static bool BufferStartsWith(byte[] buffer, byte[] signature)
    {
        for (int i = 0; i < signature.Length; i++)
        {
            if (buffer[i] != signature[i])
                return false;
        }
        return true;
    }

    /// <summary>
    /// Heuristic to detect if file is likely plain text.
    /// </summary>
    private static bool IsLikelyTextFile(byte[] buffer, int length)
    {
        int textChars = 0;
        int controlChars = 0;

        for (int i = 0; i < length; i++)
        {
            byte b = buffer[i];

            // Whitespace and printable ASCII
            if ((b >= 32 && b <= 126) || b == 9 || b == 10 || b == 13)
            {
                textChars++;
            }
            // Control characters (excluding common whitespace)
            else if (b < 32)
            {
                controlChars++;
            }
        }

        // If more than 95% of bytes are text-like, consider it text
        return textChars > (length * 0.95) && controlChars < (length * 0.05);
    }
}
