namespace Abyss.Api.Services;

public class MediaUploadService
{
    private readonly ImageService _imageService;
    private readonly MediaValidator _mediaValidator;
    private readonly MediaConfig _mediaConfig;

    public MediaUploadService(ImageService imageService, MediaValidator mediaValidator, MediaConfig mediaConfig)
    {
        _imageService = imageService;
        _mediaValidator = mediaValidator;
        _mediaConfig = mediaConfig;
    }

    public record MediaUploadResult(
        string RelativeUrl,
        long Size,
        string ContentType,
        string? DetectedMimeType,
        bool IsImage
    );

    public async Task<(bool IsValid, string? ErrorMessage, MediaUploadResult? Result)> StoreAttachmentAsync(
        IFormFile file,
        Guid attachmentId
    )
    {
        var validation = await _mediaValidator.ValidateUploadAsync(file);
        if (!validation.IsValid)
            return (false, validation.ErrorMessage, null);

        var ext = Path.GetExtension(file.FileName);
        var isImage = validation.Category == "image";

        string url;
        long size;
        string contentType;

        if (isImage)
        {
            (url, size) = await _imageService.ProcessImageAsync(file);
            contentType = "image/webp";
        }
        else
        {
            var uploadsDir = Path.Combine(Directory.GetCurrentDirectory(), "uploads");
            Directory.CreateDirectory(uploadsDir);

            var fileName = $"{attachmentId}{ext}";
            var filePath = Path.Combine(uploadsDir, fileName);

            using (var stream = new FileStream(filePath, FileMode.Create))
            {
                await file.CopyToAsync(stream);
            }

            url = $"/api/upload/{attachmentId}";
            size = file.Length;
            contentType = validation.DetectedMimeType ?? "application/octet-stream";
        }

        var result = new MediaUploadResult(url, size, contentType, validation.DetectedMimeType, isImage);
        return (true, null, result);
    }

    public async Task<(bool IsValid, string? ErrorMessage, string? Url)> StoreEmojiAsync(IFormFile file)
    {
        var options = new MediaValidator.MediaValidationOptions(
            MaxSize: _mediaConfig.EmojiMaxSize,
            AllowedExtensions: _mediaConfig.EmojiAllowedExtensions,
            AllowedMimeTypes: _mediaConfig.EmojiAllowedMimeTypes,
            RequireExtension: false
        );

        var validation = await _mediaValidator.ValidateUploadAsync(file, options);
        if (!validation.IsValid)
            return (false, validation.ErrorMessage, null);

        var url = await _imageService.ProcessEmojiAsync(file);
        return (true, null, url);
    }
}
