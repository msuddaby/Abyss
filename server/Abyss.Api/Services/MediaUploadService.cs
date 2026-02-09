namespace Abyss.Api.Services;

public class MediaUploadService
{
    private readonly ImageService _imageService;
    private readonly MediaValidator _mediaValidator;
    private readonly MediaConfig _mediaConfig;
    private readonly VideoPosterService _videoPosterService;

    public MediaUploadService(ImageService imageService, MediaValidator mediaValidator, MediaConfig mediaConfig, VideoPosterService videoPosterService)
    {
        _imageService = imageService;
        _mediaValidator = mediaValidator;
        _mediaConfig = mediaConfig;
        _videoPosterService = videoPosterService;
    }

    public record MediaUploadResult(
        string RelativeUrl,
        long Size,
        string ContentType,
        string? DetectedMimeType,
        bool IsImage,
        string? PosterPath
    );

    public async Task<(bool IsValid, string? ErrorMessage, MediaUploadResult? Result)> StoreAttachmentAsync(
        IFormFile file,
        Guid attachmentId,
        Guid? serverId,
        Guid? channelId
    )
    {
        var validation = await _mediaValidator.ValidateUploadAsync(file);
        if (!validation.IsValid)
            return (false, validation.ErrorMessage, null);

        var ext = Path.GetExtension(file.FileName);
        var isImage = validation.Category == "image";
        var isVideo = validation.Category == "video";
        var subdir = BuildAttachmentSubdir(serverId, channelId);

        string url;
        long size;
        string contentType;
        string? posterPath = null;

        if (isImage)
        {
            (url, size) = await _imageService.ProcessImageAsync(file, subdir);
            contentType = "image/webp";
        }
        else
        {
            var uploadsDir = Path.Combine(Directory.GetCurrentDirectory(), "uploads");
            var attachmentDir = string.IsNullOrWhiteSpace(subdir)
                ? uploadsDir
                : Path.Combine(uploadsDir, subdir);
            Directory.CreateDirectory(attachmentDir);

            var fileName = $"{attachmentId}{ext}";
            var filePath = Path.Combine(attachmentDir, fileName);

            using (var stream = new FileStream(filePath, FileMode.Create))
            {
                await file.CopyToAsync(stream);
            }

            url = $"/api/upload/{attachmentId}";
            size = file.Length;
            contentType = validation.DetectedMimeType ?? file.ContentType ?? "application/octet-stream";

            if (isVideo)
            {
                posterPath = await _videoPosterService.TryGeneratePosterAsync(filePath, subdir);
            }
        }

        var result = new MediaUploadResult(url, size, contentType, validation.DetectedMimeType, isImage, posterPath);
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

    private static string? BuildAttachmentSubdir(Guid? serverId, Guid? channelId)
    {
        if (channelId is null)
            return "misc";

        if (serverId is null)
            return Path.Combine("dms", channelId.Value.ToString());

        return Path.Combine("servers", serverId.Value.ToString(), "channels", channelId.Value.ToString());
    }
}
