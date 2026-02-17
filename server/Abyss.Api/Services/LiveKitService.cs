using Livekit.Server.Sdk.Dotnet;

namespace Abyss.Api.Services;

public class LiveKitService
{
    private readonly string? _apiKey;
    private readonly string? _apiSecret;
    private readonly string _livekitUrl;

    public bool IsConfigured => _apiKey is not null && _apiSecret is not null;

    public LiveKitService()
    {
        _apiKey = Environment.GetEnvironmentVariable("LIVEKIT_API_KEY");
        _apiSecret = Environment.GetEnvironmentVariable("LIVEKIT_API_SECRET");
        _livekitUrl = Environment.GetEnvironmentVariable("LIVEKIT_URL") ?? "ws://localhost:7880";

        if (IsConfigured)
            Console.WriteLine($"[LiveKit] Configured — URL: {_livekitUrl}");
        else
            Console.WriteLine("[LiveKit] Not configured (LIVEKIT_API_KEY/LIVEKIT_API_SECRET not set). SFU relay disabled.");
    }

    public string GenerateToken(string userId, string userName, string channelId, bool canPublish = true)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("LiveKit is not configured");

        var token = new AccessToken(_apiKey!, _apiSecret!)
            .WithIdentity(userId)
            .WithName(userName)
            .WithGrants(new VideoGrants
            {
                RoomJoin = true,
                Room = $"channel-{channelId}",
                CanPublish = canPublish,
                CanSubscribe = true,
                CanPublishData = true,
            });

        return token.ToJwt();
    }

    public string GetLiveKitUrl() => _livekitUrl;
}
