using System.Diagnostics;

namespace Abyss.Api.Services;

public class VideoPosterService
{
    private readonly ImageService _imageService;
    private readonly ILogger<VideoPosterService> _logger;

    public VideoPosterService(ImageService imageService, ILogger<VideoPosterService> logger)
    {
        _imageService = imageService;
        _logger = logger;
    }

    public async Task<string?> TryGeneratePosterAsync(string videoPath, string? subdir = null)
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "abyss-video-posters");
        Directory.CreateDirectory(tempDir);

        var tempFile = Path.Combine(tempDir, $"{Guid.NewGuid()}.jpg");

        try
        {
            var extracted = await TryExtractFrameAsync(videoPath, tempFile, "00:00:01");
            if (!extracted)
            {
                extracted = await TryExtractFrameAsync(videoPath, tempFile, "00:00:00");
            }

            if (!extracted || !File.Exists(tempFile))
            {
                return null;
            }

            var (relativePath, _) = await _imageService.ProcessVideoPosterAsync(tempFile, 320, subdir);
            return relativePath;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to generate video poster for {VideoPath}", videoPath);
            return null;
        }
        finally
        {
            try
            {
                if (File.Exists(tempFile))
                {
                    File.Delete(tempFile);
                }
            }
            catch
            {
                // Ignore cleanup failures
            }
        }
    }

    private async Task<bool> TryExtractFrameAsync(string videoPath, string outputPath, string timestamp)
    {
        var args = $"-y -ss {timestamp} -i \"{videoPath}\" -frames:v 1 -vf \"scale=640:-1\" -q:v 4 \"{outputPath}\"";
        var startInfo = new ProcessStartInfo
        {
            FileName = "ffmpeg",
            Arguments = args,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = new Process { StartInfo = startInfo };

        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to start ffmpeg for poster generation");
            return false;
        }

        var completed = await Task.Run(() => process.WaitForExit(5000));
        if (!completed)
        {
            try
            {
                process.Kill(true);
            }
            catch
            {
                // Ignore kill failures
            }
            _logger.LogWarning("ffmpeg timed out generating poster for {VideoPath}", videoPath);
            return false;
        }

        return process.ExitCode == 0;
    }
}
