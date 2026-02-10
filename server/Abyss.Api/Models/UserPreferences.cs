namespace Abyss.Api.Models;

public class UserPreferences
{
    public string UserId { get; set; } = string.Empty;
    public AppUser User { get; set; } = null!;
    public VoiceInputMode InputMode { get; set; } = VoiceInputMode.VoiceActivity;
    public bool JoinMuted { get; set; }
    public bool JoinDeafened { get; set; }
    public double InputSensitivity { get; set; } = 1.0;
    public bool NoiseSuppression { get; set; } = true;
    public bool EchoCancellation { get; set; } = true;
    public bool AutoGainControl { get; set; } = true;
    public string? UiPreferences { get; set; }
}
