using Xunit;
using System.Text.Json;
using System.Text.Json.Nodes;
using Abyss.Api.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Abyss.Api.Tests;

/// <summary>
/// The studio op whitelist (what the server accepts into a project) and the
/// edit history (inverse ops that undo any accepted batch). Clients mirror the
/// server's apply logic, so a silently rejected op means a lost edit: every
/// doc field the client writes should have a case here.
/// </summary>
public class StudioSessionTests
{
    private readonly StudioSessionService _svc = new(new ServiceCollection().BuildServiceProvider().GetRequiredService<IServiceScopeFactory>(), NullLogger<StudioSessionService>.Instance);
    private readonly Guid _ch = Guid.NewGuid();
    private readonly StudioSession _session;

    public StudioSessionTests()
    {
        _session = _svc.AttachForTest(_ch, StudioSessionService.CreateDefaultDoc());
        // A known set of tracks to work with.
        Apply(
            Set(["tracks", "aud"], new { name = "Vox", kind = "audio", order = 0, volume = 0, pan = 0, mute = false, solo = false }),
            Set(["tracks", "ins"], new { name = "Keys", kind = "instrument", order = 1, volume = -6, pan = 0, mute = false, solo = false, instrument = new { type = "fm" } }),
            Set(["tracks", "ret"], new { name = "A-Return", kind = "return", order = 2, volume = 0, pan = 0, mute = false, solo = false }),
            Set(["tracks", "grp"], new { name = "Group", kind = "group", order = 3, volume = 0, pan = 0, mute = false, solo = false }));
    }

    // ───────────── helpers ─────────────

    private static StudioOp Set(string[] path, object value) => new("set", path.ToList(), JsonSerializer.SerializeToElement(value));
    private static StudioOp Del(params string[] path) => new("del", path.ToList(), null);

    /// <summary>Applies one batch; returns how many ops were accepted.</summary>
    private int Apply(params StudioOp[] ops) => _svc.ApplyBatch(_ch, ops.ToList(), "user-1")?.Accepted.Count ?? 0;

    private JsonNode? At(params string[] path)
    {
        JsonNode? cur = _session.Doc;
        foreach (var k in path) cur = (cur as JsonObject)?[k];
        return cur;
    }

    private static readonly object AudioClip = new { trackId = "aud", kind = "audio", start = 0, length = 4, assetId = Guid.NewGuid().ToString() };

    // ───────────── routing ─────────────

    [Fact]
    public void NewTrackKinds_AreAccepted()
    {
        Assert.Equal("return", At("tracks", "ret", "kind")?.GetValue<string>());
        Assert.Equal("group", At("tracks", "grp", "kind")?.GetValue<string>());
        Assert.Equal(0, Apply(Set(["tracks", "bad"], new { name = "x", kind = "bus" })));
    }

    [Fact]
    public void OutputAndSends()
    {
        Assert.Equal(1, Apply(Set(["tracks", "aud", "output"], "grp")));
        Assert.Equal(1, Apply(Set(["tracks", "aud", "output"], "")));
        Assert.Equal(1, Apply(Set(["tracks", "aud", "sends", "ret"], -12.5)));
        Assert.Equal(-12.5, At("tracks", "aud", "sends", "ret")!.GetValue<double>());
        Assert.Equal(0, Apply(Set(["tracks", "aud", "sends", "ret"], 20))); // above +6 dB
        Assert.Equal(1, Apply(Del("tracks", "aud", "sends", "ret")));
        Assert.Equal(1, Apply(Set(["tracks", "ins", "sends"], new Dictionary<string, double> { ["ret"] = -6 })));
        // Returns don't route or send; only groups fold.
        Assert.Equal(0, Apply(Set(["tracks", "ret", "output"], "grp")));
        Assert.Equal(0, Apply(Set(["tracks", "ret", "sends", "ret"], -6)));
        Assert.Equal(0, Apply(Set(["tracks", "aud", "collapsed"], true)));
        Assert.Equal(1, Apply(Set(["tracks", "grp", "collapsed"], true)));
    }

    [Fact]
    public void ClipsOnlyLiveOnMatchingTracks()
    {
        Assert.Equal(1, Apply(Set(["clips", "c1"], AudioClip)));
        Assert.Equal(1, Apply(Set(["clips", "m1"], new { trackId = "ins", kind = "midi", start = 0, length = 4 })));
        Assert.Equal(0, Apply(Set(["clips", "c2"], new { trackId = "ret", kind = "audio", start = 0, length = 4, assetId = Guid.NewGuid().ToString() })));
        Assert.Equal(0, Apply(Set(["clips", "m2"], new { trackId = "grp", kind = "midi", start = 0, length = 4 })));
        Assert.Equal(0, Apply(Set(["clips", "m1", "trackId"], "ret")));
    }

    // ───────────── clips ─────────────

    [Fact]
    public void AudioClipWarpPitchReverseMute()
    {
        Apply(Set(["clips", "c1"], AudioClip), Set(["clips", "m1"], new { trackId = "ins", kind = "midi", start = 0, length = 4 }));
        Assert.Equal(4, Apply(
            Set(["clips", "c1", "warp"], true), Set(["clips", "c1", "srcBpm"], 92.5),
            Set(["clips", "c1", "pitch"], -3), Set(["clips", "c1", "reverse"], true)));
        Assert.Equal(1, Apply(Set(["clips", "c1", "mute"], true)));
        Assert.Equal(1, Apply(Set(["clips", "m1", "mute"], true)));
        // Audio-only fields don't apply to MIDI; ranges are enforced.
        Assert.Equal(0, Apply(Set(["clips", "m1", "warp"], true)));
        Assert.Equal(0, Apply(Set(["clips", "c1", "pitch"], 30)));
        Assert.Equal(0, Apply(Set(["clips", "c1", "srcBpm"], 5)));
    }

    [Fact]
    public void OptionalFieldsCanBeCleared_RequiredCannot()
    {
        Apply(Set(["clips", "c1"], AudioClip), Set(["clips", "c1", "mute"], true), Set(["tracks", "aud", "output"], "grp"));
        Assert.Equal(1, Apply(Del("clips", "c1", "mute")));
        Assert.Null(At("clips", "c1", "mute"));
        Assert.Equal(1, Apply(Del("tracks", "aud", "output")));
        Assert.Equal(0, Apply(Del("clips", "c1", "start")));
        Assert.Equal(0, Apply(Del("clips", "c1", "assetId")));
        Assert.Equal(0, Apply(Del("tracks", "aud", "volume")));
        Assert.Equal(0, Apply(Del("tracks", "ins", "instrument")));
        // Deleting something that isn't there is rejected (no phantom history).
        Assert.Equal(0, Apply(Del("clips", "c1", "warp")));
    }

    // ───────────── markers / tempo / master ─────────────

    [Fact]
    public void Markers()
    {
        Assert.Equal(1, Apply(Set(["markers", "mk1"], new { beat = 16, name = "Chorus", color = "#f59e0b" })));
        Assert.Equal(1, Apply(Set(["markers", "mk1", "name"], "Drop")));
        Assert.Equal(1, Apply(Set(["markers", "mk1", "beat"], 32)));
        Assert.Equal(0, Apply(Set(["markers", "mk1", "color"], "orange")));
        Assert.Equal(0, Apply(Set(["markers", "mk2"], new { name = "no beat" })));
        Assert.Equal(1, Apply(Del("markers", "mk1")));
        Assert.Empty(At("markers")!.AsObject());
    }

    [Fact]
    public void TempoEvents()
    {
        Assert.Equal(1, Apply(Set(["tempo", "t1"], new { beat = 32, bpm = 140 })));
        Assert.Equal(1, Apply(Set(["tempo", "t2"], new { beat = 64, num = 7, den = 8 })));
        Assert.Equal(0, Apply(Set(["tempo", "t3"], new { beat = 64 }))); // no change
        Assert.Equal(0, Apply(Set(["tempo", "t3"], new { beat = 64, num = 3 }))); // half a signature
        Assert.Equal(0, Apply(Set(["tempo", "t3"], new { beat = 64, num = 3, den = 5 })));
        Assert.Equal(0, Apply(Set(["tempo", "t3"], new { beat = 0, bpm = 100 }))); // the start lives in meta
        Assert.Equal(2, Apply(Set(["tempo", "t1", "num"], 3), Set(["tempo", "t1", "den"], 4)));
        // A change must remain: bpm can go (the signature stays), but not everything.
        Assert.Equal(1, Apply(Del("tempo", "t1", "bpm")));
        Assert.Equal(0, Apply(Del("tempo", "t1", "num"))); // would leave nothing to change
        Assert.Equal(1, Apply(Del("tempo", "t1")));
    }

    [Fact]
    public void MasterChain()
    {
        Assert.Equal(1, Apply(Set(["meta", "masterEffects"], new[] { new { id = "fx1", type = "limiter", @params = new { gain = 3, ceiling = -0.3 } } })));
        Assert.Equal(1, Apply(Set(["meta", "masterVolume"], -3)));
        Assert.Equal(0, Apply(Set(["meta", "masterEffects"], new[] { new { id = "fx1", type = "vocoder" } })));
        Assert.Equal(1, Apply(Del("meta", "masterVolume")));
        Assert.Equal(0, Apply(Del("meta", "bpm")));
        // Sidechain key (a string param) on a compressor.
        Assert.Equal(1, Apply(Set(["tracks", "aud", "effects"], new[] { new { id = "c", type = "compressor", @params = new { sidechain = "ins", threshold = -20 } } })));
    }

    [Fact]
    public void UnknownPathsAreRejected()
    {
        Assert.Equal(0, Apply(Set(["mixer", "x"], 1)));
        Assert.Equal(0, Apply(Set(["tracks", "aud", "colour"], "#ffffff")));
        Assert.Equal(0, Apply(Set(["tracks", "bad id!"], new { kind = "audio" })));
    }

    // ───────────── history: inverse ops ─────────────

    [Fact]
    public void InverseOfEveryBatch_RestoresThePriorDoc()
    {
        var batches = new[]
        {
            new[] { Set(["clips", "c1"], AudioClip), Set(["clips", "m1"], new { trackId = "ins", kind = "midi", start = 0, length = 4, notes = new { n1 = new { pitch = 60, start = 0, len = 1 } } }) },
            new[] { Set(["clips", "c1", "warp"], true), Set(["clips", "c1", "srcBpm"], 90), Set(["tracks", "aud", "sends", "ret"], -10), Set(["tracks", "aud", "output"], "grp") },
            new[] { Set(["markers", "mk"], new { beat = 8, name = "Verse" }), Set(["tempo", "tt"], new { beat = 16, bpm = 100 }), Set(["meta", "masterVolume"], -2) },
            new[] { Set(["clips", "m1", "notes", "n1", "pitch"], 64), Set(["clips", "m1", "notes", "n2"], new { pitch = 67, start = 1, len = 1 }) },
            new[] { Del("tracks", "aud") }, // cascades its clip
        };
        foreach (var batch in batches)
        {
            var before = _session.Doc.ToJsonString();
            Assert.True(Apply(batch) > 0);
            var change = _session.PendingChanges[^1];
            var inverse = JsonSerializer.Deserialize<List<StudioOp>>(change.InverseJson, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
            // Apply the inverse on a scratch copy and compare with the state before the batch.
            var scratch = new StudioSessionTests();
            scratch._session.Doc = JsonNode.Parse(_session.Doc.ToJsonString())!.AsObject();
            scratch._svc.ApplyBatch(scratch._ch, inverse, "user-2");
            var want = Canon(JsonNode.Parse(before));
            var got = Canon(scratch._session.Doc);
            Assert.True(want == got, $"inverse of \"{change.Summary}\" didn't restore the doc:\nwant {want}\n got {got}");
            Assert.False(string.IsNullOrWhiteSpace(change.Summary));
        }
    }

    /// <summary>Key-order-insensitive JSON, with empty containers inside entities dropped (absent ≡ {}).</summary>
    private static string Canon(JsonNode? n, int depth = 0)
    {
        switch (n)
        {
            case JsonObject o:
                var parts = o.Where(kv => !(depth >= 2 && kv.Value is JsonObject { Count: 0 }))
                    .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                    .Select(kv => $"{JsonSerializer.Serialize(kv.Key)}:{Canon(kv.Value, depth + 1)}");
                return "{" + string.Join(",", parts) + "}";
            case JsonArray a:
                return "[" + string.Join(",", a.Select(x => Canon(x, depth + 1))) + "]";
            default:
                return n?.ToJsonString() ?? "null";
        }
    }

    [Fact]
    public void Summaries_DescribeNewKindsOfChange()
    {
        Apply(Set(["markers", "mk"], new { beat = 8, name = "Verse" }));
        Assert.Contains("marker", _session.PendingChanges[^1].Summary, StringComparison.OrdinalIgnoreCase);
        Apply(Set(["tracks", "aud", "sends", "ret"], -10));
        Assert.Contains("Sends", _session.PendingChanges[^1].Summary);
        Apply(Set(["tempo", "tt"], new { beat = 16, bpm = 100 }));
        Assert.Contains("tempo", _session.PendingChanges[^1].Summary, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AssetReferences_FindDrumPadSamples()
    {
        var id = Guid.NewGuid().ToString();
        Apply(Set(["tracks", "ins", "instrument"], new { type = "drums", @params = new Dictionary<string, object> { ["d36_sample"] = id } }));
        Assert.True(_svc.IsAssetReferenced(_ch, id));
        Assert.False(_svc.IsAssetReferenced(_ch, Guid.NewGuid().ToString()));
    }

    [Fact]
    public void Presence_MergesPartialUpdates_AndClearsOnLeave()
    {
        _session.Connections["conn-1"] = "user-1";
        _svc.SetPresence(_ch, "user-1", JsonSerializer.SerializeToElement(new { editingClipId = "c1", editingSince = 1000L }));
        _svc.SetPresence(_ch, "user-1", JsonSerializer.SerializeToElement(new { viewBeats = 12.5, playheadBeats = 4.0 }));

        var p = _session.Presence["user-1"];
        Assert.Equal("c1", p.GetProperty("editingClipId").GetString());
        Assert.Equal(1000L, p.GetProperty("editingSince").GetInt64());
        Assert.Equal(12.5, p.GetProperty("viewBeats").GetDouble());
        Assert.Equal(4.0, p.GetProperty("playheadBeats").GetDouble());

        // Explicit null clears a field
        _svc.SetPresence(_ch, "user-1", JsonSerializer.SerializeToElement(new { editingClipId = (string?)null }));
        Assert.Equal(JsonValueKind.Null, _session.Presence["user-1"].GetProperty("editingClipId").ValueKind);
    }

    [Fact]
    public void Transport_ResetsToPausedWhenStudioEmpties()
    {
        _session.Connections["conn-1"] = "user-1";
        _svc.SetTransport(_ch, true, 16, "user-1");
        Assert.True(_session.Transport.IsPlaying);

        Assert.True(_svc.Leave(_ch, "conn-1"));
        Assert.False(_session.Transport.IsPlaying);
        Assert.Null(_session.Transport.UserId);
    }

    [Fact]
    public void PresetValidation_RejectsUnknownTypeAndNestedParams()
    {
        Assert.True(StudioSessionService.IsValidPresetType("instrument", "synth"));
        Assert.True(StudioSessionService.IsValidPresetType("effect", "delay"));
        Assert.False(StudioSessionService.IsValidPresetType("instrument", "delay"));
        Assert.False(StudioSessionService.IsValidPresetType("effect", "vocoder"));

        Assert.NotNull(StudioSessionService.ValidatePresetParams(JsonSerializer.SerializeToElement(new { mix = 50, mode = "pingpong", sync = true })));
        Assert.Null(StudioSessionService.ValidatePresetParams(JsonSerializer.SerializeToElement(new { nested = new { a = 1 } })));
    }
}
