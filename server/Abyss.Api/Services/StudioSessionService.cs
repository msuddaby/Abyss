using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Abyss.Api.Data;
using Abyss.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace Abyss.Api.Services;

/// <summary>
/// One op against a studio doc. Path addresses a node in the normalized doc,
/// e.g. ["clips", clipId, "start"]. "set" replaces the node, "del" removes it.
/// </summary>
public record StudioOp(string T, List<string> Path, JsonElement? Value);

public record StudioTransportState(bool IsPlaying, double PositionBeats, long ServerTimeMs, string? UserId);

public record StudioJoinResult(JsonObject Doc, long Version, StudioTransportState Transport, Dictionary<string, JsonElement> Presence);

public class StudioSession
{
    public Guid ChannelId { get; init; }
    public Guid ProjectId { get; init; }
    public JsonObject Doc { get; set; } = new();
    public long Version { get; set; }
    public bool Dirty { get; set; }
    public readonly object Lock = new();
    /// Held across apply + broadcast so clients receive batches in version order.
    public readonly SemaphoreSlim BroadcastGate = new(1, 1);
    /// connectionId -> userId
    public ConcurrentDictionary<string, string> Connections { get; } = new();
    /// userId -> last presence payload (selection, drag preview, playhead)
    public ConcurrentDictionary<string, JsonElement> Presence { get; } = new();
    public StudioTransportState Transport { get; set; } = new(false, 0, 0, null);
    public DateTime EmptySince { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// In-memory authority for live Studio projects. Clients send op batches; this
/// service validates each op against the doc schema, applies accepted ops in a
/// single total order, and bumps the version. The hub broadcasts the accepted
/// ops so every client converges on the same doc (last writer wins per field).
/// Dirty docs are flushed to Postgres by <see cref="StudioFlushService"/>.
/// </summary>
public class StudioSessionService
{
    public const int MaxTracks = 32;
    public const int MaxClips = 2000;
    public const int MaxNotesPerClip = 4096;
    public const int MaxTotalNotes = 50000;
    public const int MaxOpsPerBatch = 500;
    private static readonly TimeSpan EvictAfter = TimeSpan.FromMinutes(10);

    private static readonly Regex IdRegex = new(@"^[A-Za-z0-9_-]{1,40}$", RegexOptions.Compiled);
    private static readonly HashSet<string> InstrumentTypes = new() { "synth", "fm", "am", "mono", "pluck", "drums", "bass" };
    private static readonly HashSet<string> EffectTypes = new() { "reverb", "delay", "eq", "compressor", "distortion", "chorus" };

    private readonly ConcurrentDictionary<Guid, StudioSession> _sessions = new();
    private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _loadLocks = new();
    /// voiceChannelId -> studioChannelId
    private readonly ConcurrentDictionary<Guid, Guid> _voiceLinks = new();
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<StudioSessionService> _logger;

    public StudioSessionService(IServiceScopeFactory scopeFactory, ILogger<StudioSessionService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    // ───────────────────────── Default doc ─────────────────────────

    public static JsonObject CreateDefaultDoc()
    {
        var audioId = NewId();
        var instId = NewId();
        return new JsonObject
        {
            ["meta"] = new JsonObject
            {
                ["bpm"] = 120,
                ["timeSigNum"] = 4,
                ["timeSigDen"] = 4,
                ["loopEnabled"] = false,
                ["loopStart"] = 0,
                ["loopEnd"] = 16,
            },
            ["tracks"] = new JsonObject
            {
                [audioId] = new JsonObject
                {
                    ["name"] = "Audio 1", ["kind"] = "audio", ["order"] = 0, ["color"] = "#5865f2",
                    ["volume"] = 0, ["pan"] = 0, ["mute"] = false, ["solo"] = false,
                },
                [instId] = new JsonObject
                {
                    ["name"] = "Synth 1", ["kind"] = "instrument", ["order"] = 1, ["color"] = "#eb459e",
                    ["volume"] = -6, ["pan"] = 0, ["mute"] = false, ["solo"] = false,
                    ["instrument"] = new JsonObject { ["type"] = "synth" },
                },
            },
            ["clips"] = new JsonObject(),
        };
    }

    private static string NewId() => Guid.NewGuid().ToString("N")[..12];

    // ───────────────────────── Session lifecycle ─────────────────────────

    public async Task<StudioSession> GetOrLoadAsync(Guid channelId)
    {
        if (_sessions.TryGetValue(channelId, out var existing)) return existing;

        var gate = _loadLocks.GetOrAdd(channelId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync();
        try
        {
            if (_sessions.TryGetValue(channelId, out existing)) return existing;

            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var project = await db.StudioProjects.FirstOrDefaultAsync(p => p.ChannelId == channelId);
            if (project == null)
            {
                project = new StudioProject
                {
                    Id = Guid.NewGuid(),
                    ChannelId = channelId,
                    DocJson = CreateDefaultDoc().ToJsonString(),
                };
                db.StudioProjects.Add(project);
                await db.SaveChangesAsync();
            }

            JsonObject doc;
            try
            {
                doc = JsonNode.Parse(project.DocJson) as JsonObject ?? CreateDefaultDoc();
            }
            catch (JsonException)
            {
                _logger.LogWarning("Studio project {ProjectId} had unreadable doc; resetting", project.Id);
                doc = CreateDefaultDoc();
            }
            EnsureShape(doc);

            var session = new StudioSession
            {
                ChannelId = channelId,
                ProjectId = project.Id,
                Doc = doc,
                Version = project.Version,
            };
            _sessions[channelId] = session;
            return session;
        }
        finally
        {
            gate.Release();
        }
    }

    public StudioSession? GetSession(Guid channelId) =>
        _sessions.TryGetValue(channelId, out var s) ? s : null;

    public async Task<StudioJoinResult> JoinAsync(Guid channelId, string connectionId, string userId)
    {
        var session = await GetOrLoadAsync(channelId);
        session.Connections[connectionId] = userId;
        lock (session.Lock)
        {
            return new StudioJoinResult(
                (JsonObject)session.Doc.DeepClone(),
                session.Version,
                session.Transport,
                new Dictionary<string, JsonElement>(session.Presence));
        }
    }

    /// <summary>Removes a connection; returns true if the user has no other connection in this studio.</summary>
    public bool Leave(Guid channelId, string connectionId)
    {
        if (!_sessions.TryGetValue(channelId, out var session)) return false;
        if (!session.Connections.TryRemove(connectionId, out var userId)) return false;
        var userGone = !session.Connections.Values.Contains(userId);
        if (userGone) session.Presence.TryRemove(userId, out _);
        if (session.Connections.IsEmpty) session.EmptySince = DateTime.UtcNow;
        return userGone;
    }

    /// <summary>Removes the connection from every studio it joined. Returns (channelId, userId) pairs where the user fully left.</summary>
    public List<(Guid ChannelId, string UserId)> LeaveAll(string connectionId)
    {
        var left = new List<(Guid, string)>();
        foreach (var session in _sessions.Values)
        {
            if (session.Connections.TryGetValue(connectionId, out var userId) && Leave(session.ChannelId, connectionId))
                left.Add((session.ChannelId, userId));
        }
        return left;
    }

    public void SetPresence(Guid channelId, string userId, JsonElement presence)
    {
        if (_sessions.TryGetValue(channelId, out var session))
            session.Presence[userId] = presence.Clone();
    }

    public StudioTransportState SetTransport(Guid channelId, bool isPlaying, double positionBeats, string userId)
    {
        var state = new StudioTransportState(isPlaying, Math.Max(0, positionBeats), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), userId);
        if (_sessions.TryGetValue(channelId, out var session)) session.Transport = state;
        return state;
    }

    public bool IsAssetReferenced(Guid channelId, string assetId)
    {
        if (!_sessions.TryGetValue(channelId, out var session)) return false;
        lock (session.Lock)
        {
            var clips = session.Doc["clips"] as JsonObject;
            return clips != null && clips.Any(kv => kv.Value is JsonObject c && c["assetId"]?.GetValue<string>() == assetId);
        }
    }

    /// <summary>Replaces the doc with a fresh default (used by project reset). Returns the new doc and version.</summary>
    public async Task<(JsonObject Doc, long Version)> ResetAsync(Guid channelId)
    {
        var session = await GetOrLoadAsync(channelId);
        lock (session.Lock)
        {
            session.Doc = CreateDefaultDoc();
            session.Version++;
            session.Dirty = true;
            return ((JsonObject)session.Doc.DeepClone(), session.Version);
        }
    }

    // ───────────────────────── Voice links ─────────────────────────

    public void LinkVoice(Guid voiceChannelId, Guid studioChannelId) => _voiceLinks[voiceChannelId] = studioChannelId;
    public bool UnlinkVoice(Guid voiceChannelId) => _voiceLinks.TryRemove(voiceChannelId, out _);
    public Guid? GetVoiceLink(Guid voiceChannelId) => _voiceLinks.TryGetValue(voiceChannelId, out var s) ? s : null;

    public Dictionary<Guid, Guid> GetVoiceLinks(IEnumerable<Guid> voiceChannelIds)
    {
        var result = new Dictionary<Guid, Guid>();
        foreach (var id in voiceChannelIds)
            if (_voiceLinks.TryGetValue(id, out var studio)) result[id] = studio;
        return result;
    }

    /// <summary>Drops voice links pointing at a studio channel (e.g. it was deleted).</summary>
    public List<Guid> UnlinkStudio(Guid studioChannelId)
    {
        var removed = _voiceLinks.Where(kv => kv.Value == studioChannelId).Select(kv => kv.Key).ToList();
        foreach (var v in removed) _voiceLinks.TryRemove(v, out _);
        return removed;
    }

    // ───────────────────────── Op application ─────────────────────────

    /// <summary>
    /// Validates and applies a batch. Invalid ops are dropped individually; the
    /// accepted ops (in normalized form) are returned for broadcast. Returns
    /// null if nothing was accepted.
    /// </summary>
    public (long Version, List<JsonObject> Accepted)? ApplyBatch(Guid channelId, List<StudioOp> ops)
    {
        if (!_sessions.TryGetValue(channelId, out var session)) return null;
        if (ops.Count == 0 || ops.Count > MaxOpsPerBatch) return null;

        lock (session.Lock)
        {
            var accepted = new List<JsonObject>();
            foreach (var op in ops)
            {
                var normalized = TryApply(session.Doc, op);
                if (normalized != null) accepted.Add(normalized);
            }
            if (accepted.Count == 0) return null;
            session.Version++;
            session.Dirty = true;
            return (session.Version, accepted);
        }
    }

    private static JsonObject? TryApply(JsonObject doc, StudioOp op)
    {
        var path = op.Path;
        if (path == null || path.Count < 2 || path.Count > 5) return null;
        var isSet = op.T == "set";
        if (!isSet && op.T != "del") return null;
        if (isSet && op.Value is null) return null;

        var tracks = (JsonObject)doc["tracks"]!;
        var clips = (JsonObject)doc["clips"]!;
        JsonNode? value = null;

        switch (path[0])
        {
            case "meta":
            {
                if (path.Count != 2 || !isSet) return null;
                value = ValidateMetaField(path[1], op.Value!.Value);
                if (value == null) return null;
                ((JsonObject)doc["meta"]!)[path[1]] = value;
                break;
            }
            case "tracks":
            {
                var id = path[1];
                if (!IdRegex.IsMatch(id)) return null;
                if (path.Count == 2)
                {
                    if (isSet)
                    {
                        if (!tracks.ContainsKey(id) && tracks.Count >= MaxTracks) return null;
                        value = ValidateTrack(op.Value!.Value);
                        if (value == null) return null;
                        tracks[id] = value;
                    }
                    else
                    {
                        if (!tracks.Remove(id)) return null;
                        // Cascade: clips on a deleted track are removed (clients mirror this).
                        foreach (var clipId in clips.Where(kv => (kv.Value as JsonObject)?["trackId"]?.GetValue<string>() == id).Select(kv => kv.Key).ToList())
                            clips.Remove(clipId);
                    }
                }
                else if (path.Count == 3)
                {
                    if (!isSet || tracks[id] is not JsonObject track) return null;
                    value = ValidateTrackField(path[2], op.Value!.Value, track["kind"]?.GetValue<string>());
                    if (value == null) return null;
                    track[path[2]] = value;
                }
                else return null;
                break;
            }
            case "clips":
            {
                var id = path[1];
                if (!IdRegex.IsMatch(id)) return null;
                if (path.Count == 2)
                {
                    if (isSet)
                    {
                        if (!clips.ContainsKey(id) && clips.Count >= MaxClips) return null;
                        var clip = ValidateClip(op.Value!.Value, tracks);
                        if (clip == null) return null;
                        var newNotes = (clip["notes"] as JsonObject)?.Count ?? 0;
                        var oldNotes = (clips[id]?["notes"] as JsonObject)?.Count ?? 0;
                        if (CountNotes(clips) - oldNotes + newNotes > MaxTotalNotes) return null;
                        clips[id] = clip;
                        value = clip;
                    }
                    else if (!clips.Remove(id)) return null;
                }
                else if (path.Count == 3)
                {
                    if (!isSet || clips[id] is not JsonObject clip) return null;
                    if (path[2] == "notes") return null; // replace notes via whole-clip set
                    value = ValidateClipField(path[2], op.Value!.Value, tracks, clip);
                    if (value == null) return null;
                    clip[path[2]] = value;
                }
                else
                {
                    // ["clips", id, "notes", noteId] or ["clips", id, "notes", noteId, field]
                    if (path[2] != "notes" || clips[id] is not JsonObject clip) return null;
                    if (clip["kind"]?.GetValue<string>() != "midi") return null;
                    var noteId = path[3];
                    if (!IdRegex.IsMatch(noteId)) return null;
                    var notes = clip["notes"] as JsonObject;
                    if (notes == null) { notes = new JsonObject(); clip["notes"] = notes; }

                    if (path.Count == 4)
                    {
                        if (isSet)
                        {
                            if (!notes.ContainsKey(noteId) && (notes.Count >= MaxNotesPerClip || CountNotes(clips) >= MaxTotalNotes)) return null;
                            value = ValidateNote(op.Value!.Value);
                            if (value == null) return null;
                            notes[noteId] = value;
                        }
                        else if (!notes.Remove(noteId)) return null;
                    }
                    else
                    {
                        if (!isSet || notes[noteId] is not JsonObject note) return null;
                        value = ValidateNoteField(path[4], op.Value!.Value);
                        if (value == null) return null;
                        note[path[4]] = value;
                    }
                }
                break;
            }
            default:
                return null;
        }

        var result = new JsonObject
        {
            ["t"] = op.T,
            ["path"] = new JsonArray(path.Select(p => (JsonNode)JsonValue.Create(p)!).ToArray()),
        };
        if (isSet) result["value"] = value!.DeepClone();
        return result;
    }

    private static int CountNotes(JsonObject clips) =>
        clips.Sum(kv => ((kv.Value as JsonObject)?["notes"] as JsonObject)?.Count ?? 0);

    private static void EnsureShape(JsonObject doc)
    {
        if (doc["meta"] is not JsonObject) doc["meta"] = CreateDefaultDoc()["meta"]!.DeepClone();
        if (doc["tracks"] is not JsonObject) doc["tracks"] = new JsonObject();
        if (doc["clips"] is not JsonObject) doc["clips"] = new JsonObject();
    }

    // ───────────────────────── Schema validation ─────────────────────────

    private static double? Num(JsonElement v, double min, double max)
    {
        if (v.ValueKind != JsonValueKind.Number || !v.TryGetDouble(out var d) || double.IsNaN(d) || double.IsInfinity(d)) return null;
        return d < min || d > max ? null : d;
    }

    private static bool? Bool(JsonElement v) =>
        v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null };

    private static string? Str(JsonElement v, int maxLen, bool allowEmpty = false)
    {
        if (v.ValueKind != JsonValueKind.String) return null;
        var s = v.GetString()!;
        if (s.Length > maxLen || (!allowEmpty && s.Length == 0)) return null;
        return s;
    }

    private static readonly Regex ColorRegex = new(@"^#[0-9a-fA-F]{6}$", RegexOptions.Compiled);

    private static JsonNode? ValidateMetaField(string field, JsonElement v) => field switch
    {
        "bpm" => Num(v, 20, 400) is { } d ? JsonValue.Create(d) : null,
        "timeSigNum" => Num(v, 1, 16) is { } d && d == Math.Floor(d) ? JsonValue.Create((int)d) : null,
        "timeSigDen" => Num(v, 1, 16) is { } d && d is 2 or 4 or 8 or 16 ? JsonValue.Create((int)d) : null,
        "loopEnabled" => Bool(v) is { } b ? JsonValue.Create(b) : null,
        "loopStart" or "loopEnd" => Num(v, 0, 100000) is { } d ? JsonValue.Create(d) : null,
        _ => null,
    };

    private static JsonObject? ValidateTrack(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        if (!v.TryGetProperty("kind", out var kindEl)) return null;
        var kind = Str(kindEl, 16);
        if (kind is not ("audio" or "instrument")) return null;

        var track = new JsonObject { ["kind"] = kind };
        foreach (var prop in v.EnumerateObject())
        {
            if (prop.Name == "kind") continue;
            var node = ValidateTrackField(prop.Name, prop.Value, kind);
            if (node == null) return null;
            track[prop.Name] = node;
        }
        track["name"] ??= kind == "audio" ? "Audio" : "Instrument";
        track["order"] ??= 0;
        track["volume"] ??= 0;
        track["pan"] ??= 0;
        track["mute"] ??= false;
        track["solo"] ??= false;
        if (kind == "instrument") track["instrument"] ??= new JsonObject { ["type"] = "synth" };
        return track;
    }

    private static JsonNode? ValidateTrackField(string field, JsonElement v, string? kind) => field switch
    {
        "name" => Str(v, 40) is { } s ? JsonValue.Create(s) : null,
        "order" => Num(v, -1e6, 1e6) is { } d ? JsonValue.Create(d) : null,
        "color" => Str(v, 7) is { } s && ColorRegex.IsMatch(s) ? JsonValue.Create(s) : null,
        "volume" => Num(v, -60, 12) is { } d ? JsonValue.Create(d) : null,
        "pan" => Num(v, -1, 1) is { } d ? JsonValue.Create(d) : null,
        "mute" or "solo" => Bool(v) is { } b ? JsonValue.Create(b) : null,
        "instrument" => kind == "instrument" ? ValidateInstrument(v) : null,
        "effects" => ValidateEffects(v),
        _ => null,
    };

    private static JsonObject? ValidateInstrument(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        if (!v.TryGetProperty("type", out var t) || Str(t, 24) is not { } type || !InstrumentTypes.Contains(type)) return null;
        var inst = new JsonObject { ["type"] = type };
        if (v.TryGetProperty("params", out var p))
        {
            var parms = ValidateParams(p);
            if (parms == null) return null;
            inst["params"] = parms;
        }
        return inst;
    }

    /// Flat map of up to 24 numeric/string/bool params (synth envelope, oscillator type, etc.).
    private static JsonObject? ValidateParams(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        var result = new JsonObject();
        var count = 0;
        foreach (var prop in v.EnumerateObject())
        {
            if (++count > 24 || prop.Name.Length > 32) return null;
            JsonNode? node = prop.Value.ValueKind switch
            {
                JsonValueKind.Number => Num(prop.Value, -1e6, 1e6) is { } d ? JsonValue.Create(d) : null,
                JsonValueKind.String => Str(prop.Value, 32, allowEmpty: true) is { } s ? JsonValue.Create(s) : null,
                JsonValueKind.True or JsonValueKind.False => JsonValue.Create(prop.Value.GetBoolean()),
                _ => null,
            };
            if (node == null) return null;
            result[prop.Name] = node;
        }
        return result;
    }

    private static JsonArray? ValidateEffects(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Array || v.GetArrayLength() > 8) return null;
        var arr = new JsonArray();
        foreach (var fx in v.EnumerateArray())
        {
            if (fx.ValueKind != JsonValueKind.Object) return null;
            if (!fx.TryGetProperty("type", out var t) || Str(t, 24) is not { } type || !EffectTypes.Contains(type)) return null;
            if (!fx.TryGetProperty("id", out var idEl) || Str(idEl, 40) is not { } id || !IdRegex.IsMatch(id)) return null;
            var node = new JsonObject { ["id"] = id, ["type"] = type };
            if (fx.TryGetProperty("bypass", out var b)) node["bypass"] = Bool(b) ?? false;
            if (fx.TryGetProperty("params", out var p))
            {
                var parms = ValidateParams(p);
                if (parms == null) return null;
                node["params"] = parms;
            }
            arr.Add(node);
        }
        return arr;
    }

    private static JsonObject? ValidateClip(JsonElement v, JsonObject tracks)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        if (!v.TryGetProperty("kind", out var kindEl) || Str(kindEl, 8) is not { } kind || kind is not ("audio" or "midi")) return null;
        if (!v.TryGetProperty("trackId", out var trackEl) || Str(trackEl, 40) is not { } trackId) return null;
        if (tracks[trackId] is not JsonObject track) return null;
        // Audio clips live on audio tracks, MIDI clips on instrument tracks.
        var trackKind = track["kind"]?.GetValue<string>();
        if ((kind == "audio") != (trackKind == "audio")) return null;

        var clip = new JsonObject { ["kind"] = kind, ["trackId"] = trackId };
        foreach (var prop in v.EnumerateObject())
        {
            if (prop.Name is "kind" or "trackId") continue;
            JsonNode? node;
            if (prop.Name == "notes")
            {
                if (kind != "midi") return null;
                node = ValidateNotes(prop.Value);
            }
            else node = ValidateClipField(prop.Name, prop.Value, tracks, clip);
            if (node == null) return null;
            clip[prop.Name] = node;
        }
        if (clip["start"] == null || clip["length"] == null) return null;
        if (kind == "audio" && clip["assetId"] == null) return null;
        clip["gain"] ??= 0;
        if (kind == "audio")
        {
            clip["offset"] ??= 0;
            clip["fadeIn"] ??= 0;
            clip["fadeOut"] ??= 0;
        }
        else clip["notes"] ??= new JsonObject();
        return clip;
    }

    private static JsonNode? ValidateClipField(string field, JsonElement v, JsonObject tracks, JsonObject clip)
    {
        var kind = clip["kind"]?.GetValue<string>();
        switch (field)
        {
            case "trackId":
            {
                if (Str(v, 40) is not { } id || tracks[id] is not JsonObject t) return null;
                var trackKind = t["kind"]?.GetValue<string>();
                return (kind == "audio") == (trackKind == "audio") ? JsonValue.Create(id) : null;
            }
            case "start": return Num(v, 0, 100000) is { } st ? JsonValue.Create(st) : null;
            case "length": return Num(v, 1.0 / 64, 100000) is { } len ? JsonValue.Create(len) : null;
            case "name": return Str(v, 60, allowEmpty: true) is { } nm ? JsonValue.Create(nm) : null;
            case "gain": return Num(v, -60, 24) is { } gn ? JsonValue.Create(gn) : null;
            case "color": return Str(v, 7) is { } col && ColorRegex.IsMatch(col) ? JsonValue.Create(col) : null;
            case "assetId": return kind == "audio" && Str(v, 40) is { } aid && Guid.TryParse(aid, out _) ? JsonValue.Create(aid) : null;
            // Audio-only fields are in seconds of source audio (clips play at native rate).
            case "offset": return kind == "audio" && Num(v, 0, 86400) is { } off ? JsonValue.Create(off) : null;
            case "fadeIn" or "fadeOut": return kind == "audio" && Num(v, 0, 600) is { } fd ? JsonValue.Create(fd) : null;
            default: return null;
        }
    }

    private static JsonObject? ValidateNotes(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        var notes = new JsonObject();
        foreach (var prop in v.EnumerateObject())
        {
            if (notes.Count >= MaxNotesPerClip || !IdRegex.IsMatch(prop.Name)) return null;
            var note = ValidateNote(prop.Value);
            if (note == null) return null;
            notes[prop.Name] = note;
        }
        return notes;
    }

    private static JsonObject? ValidateNote(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        var note = new JsonObject();
        foreach (var prop in v.EnumerateObject())
        {
            var node = ValidateNoteField(prop.Name, prop.Value);
            if (node == null) return null;
            note[prop.Name] = node;
        }
        if (note["pitch"] == null || note["start"] == null || note["len"] == null) return null;
        note["vel"] ??= 0.8;
        return note;
    }

    private static JsonNode? ValidateNoteField(string field, JsonElement v) => field switch
    {
        "pitch" => Num(v, 0, 127) is { } d && d == Math.Floor(d) ? JsonValue.Create((int)d) : null,
        "start" => Num(v, 0, 100000) is { } d ? JsonValue.Create(d) : null,
        "len" => Num(v, 1.0 / 64, 100000) is { } d ? JsonValue.Create(d) : null,
        "vel" => Num(v, 0, 1) is { } d ? JsonValue.Create(d) : null,
        _ => null,
    };

    // ───────────────────────── Persistence ─────────────────────────

    public async Task FlushDirtyAsync(CancellationToken ct = default)
    {
        var dirty = _sessions.Values.Where(s => s.Dirty).ToList();
        if (dirty.Count == 0) return;

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        foreach (var session in dirty)
        {
            string json;
            long version;
            lock (session.Lock)
            {
                json = session.Doc.ToJsonString();
                version = session.Version;
                session.Dirty = false;
            }
            try
            {
                await db.StudioProjects
                    .Where(p => p.Id == session.ProjectId)
                    .ExecuteUpdateAsync(u => u
                        .SetProperty(p => p.DocJson, json)
                        .SetProperty(p => p.Version, version)
                        .SetProperty(p => p.UpdatedAt, DateTime.UtcNow), ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to flush studio project {ProjectId}", session.ProjectId);
                lock (session.Lock) session.Dirty = true;
            }
        }
    }

    /// <summary>Evicts sessions that have been empty (and flushed) for a while.</summary>
    public void EvictIdle()
    {
        foreach (var session in _sessions.Values)
        {
            if (session.Connections.IsEmpty && !session.Dirty && DateTime.UtcNow - session.EmptySince > EvictAfter)
            {
                _sessions.TryRemove(session.ChannelId, out _);
                _loadLocks.TryRemove(session.ChannelId, out _);
            }
        }
    }

    /// <summary>Drops a session without flushing (channel deleted).</summary>
    public void Discard(Guid channelId)
    {
        _sessions.TryRemove(channelId, out _);
        UnlinkStudio(channelId);
    }
}

public class StudioFlushService : BackgroundService
{
    private readonly StudioSessionService _studio;
    private readonly ILogger<StudioFlushService> _logger;

    public StudioFlushService(StudioSessionService studio, ILogger<StudioFlushService> logger)
    {
        _studio = studio;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                await _studio.FlushDirtyAsync(stoppingToken);
                _studio.EvictIdle();
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Studio flush loop error");
            }
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        // Final flush on shutdown so edits from the last few seconds aren't lost.
        await _studio.FlushDirtyAsync(CancellationToken.None);
    }
}
