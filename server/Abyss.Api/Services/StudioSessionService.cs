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
    /// History rows not yet written (flushed with the doc)
    public List<StudioChange> PendingChanges { get; } = new();
    /// Latest snapshot (auto or named), for spacing automatic ones
    public DateTime LastSnapshotAt { get; set; } = DateTime.MinValue;
    public long LastSnapshotVersion { get; set; } = -1;
    public DateTime LastPruneAt { get; set; } = DateTime.MinValue;
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
    public const int MaxTracks = 48;
    public const int MaxMarkers = 200;
    public const int MaxTempoEvents = 200;
    public const int MaxSends = 16;
    public const int MaxClips = 2000;
    public const int MaxNotesPerClip = 4096;
    public const int MaxTotalNotes = 50000;
    public const int MaxOpsPerBatch = 500;
    private static readonly TimeSpan EvictAfter = TimeSpan.FromMinutes(10);
    /// Automatic snapshots: at most one per interval while the project changes.
    private static readonly TimeSpan AutoSnapshotEvery = TimeSpan.FromMinutes(30);
    public const int MaxAutoSnapshots = 48;
    public const int MaxNamedSnapshots = 100;
    public const int MaxHistoryRows = 20000;
    private static readonly TimeSpan HistoryRetention = TimeSpan.FromDays(90);

    private static readonly Regex IdRegex = new(@"^[A-Za-z0-9_-]{1,40}$", RegexOptions.Compiled);
    private static readonly HashSet<string> InstrumentTypes = new() { "synth", "fm", "am", "mono", "pluck", "drums", "bass", "sampler" };
    private static readonly HashSet<string> EffectTypes = new() { "reverb", "delay", "eq", "compressor", "distortion", "chorus", "filter", "tape", "limiter" };

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
            ["markers"] = new JsonObject(),
            ["tempo"] = new JsonObject(),
        };
    }

    private static string NewId() => Guid.NewGuid().ToString("N")[..12];

    // ───────────────────────── Session lifecycle ─────────────────────────

    /// <summary>Test hook: an in-memory session over <paramref name="doc"/> (no database).</summary>
    internal StudioSession AttachForTest(Guid channelId, JsonObject doc)
    {
        EnsureShape(doc);
        var session = new StudioSession { ChannelId = channelId, ProjectId = Guid.NewGuid(), Doc = doc };
        _sessions[channelId] = session;
        return session;
    }

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

            var last = await db.StudioVersions.Where(v => v.ProjectId == project.Id)
                .OrderByDescending(v => v.CreatedAt).Select(v => new { v.CreatedAt, v.DocVersion }).FirstOrDefaultAsync();
            var session = new StudioSession
            {
                ChannelId = channelId,
                ProjectId = project.Id,
                Doc = doc,
                Version = project.Version,
                LastSnapshotAt = last?.CreatedAt ?? DateTime.MinValue,
                LastSnapshotVersion = last?.DocVersion ?? -1,
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

    public static bool DocReferences(string docJson, string assetId) =>
        docJson.Contains(assetId, StringComparison.OrdinalIgnoreCase);

    /// <summary>Live doc JSON (null when the session isn't loaded).</summary>
    public string? DocJson(Guid channelId)
    {
        if (!_sessions.TryGetValue(channelId, out var session)) return null;
        lock (session.Lock) return session.Doc.ToJsonString();
    }

    public bool IsAssetReferenced(Guid channelId, string assetId)
    {
        if (!_sessions.TryGetValue(channelId, out var session)) return false;
        lock (session.Lock)
        {
            // Clips, sampler instruments and drum-rack pads all reference assets by
            // id; ids are GUIDs, so a text search can't false-positive.
            return DocReferences(session.Doc.ToJsonString(), assetId);
        }
    }

    /// <summary>Replaces the doc with a fresh default (used by project reset). Returns the new doc and version.</summary>
    public Task<(JsonObject Doc, long Version)> ResetAsync(Guid channelId, string userId) =>
        ReplaceDocAsync(channelId, CreateDefaultDoc(), userId, "Reset the project", "Before reset");

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
    public (long Version, List<JsonObject> Accepted)? ApplyBatch(Guid channelId, List<StudioOp> ops, string userId)
    {
        if (!_sessions.TryGetValue(channelId, out var session)) return null;
        if (ops.Count == 0 || ops.Count > MaxOpsPerBatch) return null;

        lock (session.Lock)
        {
            var accepted = new List<JsonObject>();
            // Inverse ops per accepted op, captured from the doc just before it applied.
            var inverses = new List<List<JsonObject>>();
            var summary = new ChangeSummary();
            foreach (var op in ops)
            {
                var inverse = CaptureInverse(session.Doc, op);
                var normalized = TryApply(session.Doc, op);
                if (normalized == null) continue;
                accepted.Add(normalized);
                inverses.Add(inverse);
                summary.Add(op, inverse, session.Doc);
            }
            if (accepted.Count == 0) return null;
            session.Version++;
            session.Dirty = true;

            inverses.Reverse();
            session.PendingChanges.Add(new StudioChange
            {
                ProjectId = session.ProjectId,
                Version = session.Version,
                UserId = userId,
                CreatedAt = DateTime.UtcNow,
                Summary = summary.ToText(),
                OpCount = accepted.Count,
                OpsJson = new JsonArray(accepted.Select(a => (JsonNode)a.DeepClone()).ToArray()).ToJsonString(),
                InverseJson = new JsonArray(inverses.SelectMany(x => x).Select(a => (JsonNode)a).ToArray()).ToJsonString(),
            });
            return (session.Version, accepted);
        }
    }

    // ───────────────────────── History ─────────────────────────

    private static JsonNode? NodeAt(JsonObject doc, IReadOnlyList<string> path)
    {
        JsonNode? cur = doc;
        foreach (var key in path)
        {
            if (cur is not JsonObject obj || !obj.TryGetPropertyValue(key, out var next)) return null;
            cur = next;
        }
        return cur;
    }

    private static JsonObject InverseOp(IReadOnlyList<string> path, JsonNode? prev)
    {
        var o = new JsonObject
        {
            ["t"] = prev == null ? "del" : "set",
            ["path"] = new JsonArray(path.Select(p => (JsonNode)JsonValue.Create(p)!).ToArray()),
        };
        if (prev != null) o["value"] = prev.DeepClone();
        return o;
    }

    /// <summary>Ops that restore what <paramref name="op"/> is about to change (including cascades).</summary>
    private static List<JsonObject> CaptureInverse(JsonObject doc, StudioOp op)
    {
        var list = new List<JsonObject>();
        if (op.Path == null || op.Path.Count < 2) return list;
        list.Add(InverseOp(op.Path, NodeAt(doc, op.Path)));
        // Deleting a track also deletes its clips: restore them after the track.
        if (op.T == "del" && op.Path.Count == 2 && op.Path[0] == "tracks" && doc["clips"] is JsonObject clips)
        {
            foreach (var (clipId, clip) in clips)
                if ((clip as JsonObject)?["trackId"]?.GetValue<string>() == op.Path[1])
                    list.Add(InverseOp(new[] { "clips", clipId }, clip));
        }
        return list;
    }

    /// <summary>Human-readable one-liner for a batch ("Added 2 clips on Bass · Changed tempo").</summary>
    private sealed class ChangeSummary
    {
        private readonly Dictionary<string, int> _counts = new();
        private readonly HashSet<string> _meta = new();
        private readonly List<string> _tracks = new();

        private void Count(string key, int n = 1) => _counts[key] = _counts.GetValueOrDefault(key) + n;
        private void Track(string? name)
        {
            if (!string.IsNullOrEmpty(name) && !_tracks.Contains(name) && _tracks.Count < 3) _tracks.Add(name);
        }

        public void Add(StudioOp op, List<JsonObject> inverse, JsonObject docAfter)
        {
            var path = op.Path;
            var existed = inverse.Count > 0 && inverse[0]["t"]?.GetValue<string>() == "set";
            var prev = existed ? inverse[0]["value"] : null;
            string? TrackName(string? trackId) =>
                trackId == null ? null : (NodeAt(docAfter, new[] { "tracks", trackId, "name" }) ?? FindInInverse(inverse, trackId))?.GetValue<string>();

            switch (path[0])
            {
                case "meta":
                    _meta.Add(path[1] switch
                    {
                        "bpm" => "tempo",
                        "timeSigNum" or "timeSigDen" => "time signature",
                        "loopEnabled" or "loopStart" or "loopEnd" => "loop",
                        "scaleRoot" or "scaleMode" => "scale",
                        "masterEffects" => "master effects",
                        "masterVolume" => "master volume",
                        _ => path[1],
                    });
                    break;
                case "tracks":
                {
                    var name = TrackName(path[1]) ?? (prev as JsonObject)?["name"]?.GetValue<string>();
                    Track(name);
                    if (path.Count == 2) Count(op.T == "del" ? "track-" : existed ? "track~" : "track+");
                    else if (path.Count >= 3) Count(path[2] switch
                    {
                        "volume" or "pan" or "mute" or "solo" => "mixer",
                        "instrument" => "instrument",
                        "effects" => "effects",
                        "automation" => "automation",
                        "sends" => "sends",
                        "output" => "routing",
                        "name" => "rename",
                        "color" => "color",
                        _ => "track~",
                    });
                    break;
                }
                case "clips":
                {
                    var clip = NodeAt(docAfter, new[] { "clips", path[1] }) as JsonObject ?? prev as JsonObject;
                    Track(TrackName(clip?["trackId"]?.GetValue<string>()));
                    if (path.Count == 2) Count(op.T == "del" ? "clip-" : existed ? "clip~" : "clip+");
                    else if (path.Count >= 4 && path[2] == "notes") Count("note");
                    else Count("clip~");
                    break;
                }
                case "markers":
                    Count(path.Count == 2 && op.T == "del" ? "marker-" : path.Count == 2 && !existed ? "marker+" : "marker~");
                    break;
                case "tempo":
                    Count("tempo-map");
                    break;
            }
        }

        private static JsonNode? FindInInverse(List<JsonObject> inverse, string trackId)
        {
            foreach (var inv in inverse)
                if (inv["path"] is JsonArray p && p.Count == 2 && p[0]?.GetValue<string>() == "tracks" && p[1]?.GetValue<string>() == trackId)
                    return (inv["value"] as JsonObject)?["name"];
            return null;
        }

        public string ToText()
        {
            var parts = new List<string>();
            string N(int n, string one, string many) => n == 1 ? one : $"{n} {many}";
            foreach (var (key, n) in _counts)
            {
                parts.Add(key switch
                {
                    "track+" => $"Added {N(n, "a track", "tracks")}",
                    "track-" => $"Deleted {N(n, "a track", "tracks")}",
                    "track~" => "Changed track settings",
                    "mixer" => "Mixer",
                    "instrument" => "Instrument",
                    "effects" => "Effects",
                    "automation" => "Automation",
                    "sends" => "Sends",
                    "routing" => "Routing",
                    "marker+" => $"Added {N(n, "a marker", "markers")}",
                    "marker-" => $"Deleted {N(n, "a marker", "markers")}",
                    "marker~" => "Edited markers",
                    "tempo-map" => "Changed tempo map",
                    "rename" => "Renamed",
                    "color" => "Colour",
                    "clip+" => $"Added {N(n, "a clip", "clips")}",
                    "clip-" => $"Deleted {N(n, "a clip", "clips")}",
                    "clip~" => $"Edited {N(n, "a clip", "clips")}",
                    "note" => $"Edited {N(n, "a note", "notes")}",
                    _ => key,
                });
            }
            if (_meta.Count > 0) parts.Add("Changed " + string.Join(", ", _meta));
            var text = string.Join(" · ", parts.Distinct());
            if (_tracks.Count > 0) text += " — " + string.Join(", ", _tracks);
            return text.Length > 300 ? text[..297] + "…" : text;
        }
    }

    /// <summary>Snapshots the live doc as a version. Returns it, or null when the named limit is reached.</summary>
    public async Task<StudioVersion?> SaveVersionAsync(Guid channelId, string name, string? userId, bool auto = false)
    {
        var session = await GetOrLoadAsync(channelId);
        StudioVersion version;
        lock (session.Lock)
        {
            version = new StudioVersion
            {
                Id = Guid.NewGuid(),
                ProjectId = session.ProjectId,
                Name = name.Length > 80 ? name[..80] : name,
                Auto = auto,
                CreatedById = userId,
                CreatedAt = DateTime.UtcNow,
                DocVersion = session.Version,
                DocJson = session.Doc.ToJsonString(),
            };
            session.LastSnapshotAt = version.CreatedAt;
            session.LastSnapshotVersion = session.Version;
        }
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        if (!auto && await db.StudioVersions.CountAsync(v => v.ProjectId == session.ProjectId && !v.Auto) >= MaxNamedSnapshots) return null;
        db.StudioVersions.Add(version);
        await db.SaveChangesAsync();
        if (auto) await PruneAutoSnapshotsAsync(db, session.ProjectId);
        return version;
    }

    private static async Task PruneAutoSnapshotsAsync(AppDbContext db, Guid projectId)
    {
        var keep = await db.StudioVersions.Where(v => v.ProjectId == projectId && v.Auto)
            .OrderByDescending(v => v.CreatedAt).Skip(MaxAutoSnapshots).Select(v => v.Id).ToListAsync();
        if (keep.Count > 0) await db.StudioVersions.Where(v => keep.Contains(v.Id)).ExecuteDeleteAsync();
    }

    /// <summary>
    /// Replaces the live doc wholesale (restore a version / reset). The current
    /// state is snapshotted first so the replace itself can be undone.
    /// </summary>
    public async Task<(JsonObject Doc, long Version)> ReplaceDocAsync(Guid channelId, JsonObject doc, string userId, string summary, string beforeName)
    {
        await SaveVersionAsync(channelId, beforeName, null, auto: true);
        var session = await GetOrLoadAsync(channelId);
        EnsureShape(doc);
        lock (session.Lock)
        {
            session.Doc = doc;
            session.Version++;
            session.Dirty = true;
            session.PendingChanges.Add(new StudioChange
            {
                ProjectId = session.ProjectId,
                Version = session.Version,
                UserId = userId,
                Kind = "restore",
                Summary = summary.Length > 300 ? summary[..300] : summary,
            });
            return ((JsonObject)session.Doc.DeepClone(), session.Version);
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
                if (path.Count != 2) return null;
                if (!isSet)
                {
                    // Optional meta fields can be cleared (reverting a first-time set).
                    if (!OptionalMetaFields.Contains(path[1]) || !((JsonObject)doc["meta"]!).Remove(path[1])) return null;
                    break;
                }
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
                    if (tracks[id] is not JsonObject track) return null;
                    if (!isSet)
                    {
                        // Optional fields can be cleared (reverting a first-time set).
                        if (RequiredTrackFields.Contains(path[2]) || path[2] == "instrument" || !track.Remove(path[2])) return null;
                        break;
                    }
                    value = ValidateTrackField(path[2], op.Value!.Value, track["kind"]?.GetValue<string>());
                    if (value == null) return null;
                    track[path[2]] = value;
                }
                else if (path.Count == 4 && path[2] == "sends")
                {
                    // ["tracks", id, "sends", returnTrackId] — one send level
                    if (tracks[id] is not JsonObject track || !IdRegex.IsMatch(path[3]) || path[3] == id) return null;
                    if (track["kind"]?.GetValue<string>() == "return") return null; // returns don't send
                    var sends = track["sends"] as JsonObject;
                    if (isSet)
                    {
                        if (Num(op.Value!.Value, -60, 6) is not { } lvl) return null;
                        value = JsonValue.Create(lvl);
                        if (sends == null) { sends = new JsonObject(); track["sends"] = sends; }
                        if (!sends.ContainsKey(path[3]) && sends.Count >= MaxSends) return null;
                        sends[path[3]] = value;
                    }
                    else if (sends == null || !sends.Remove(path[3])) return null;
                }
                else if (path.Count == 4 && path[2] == "automation")
                {
                    // ["tracks", id, "automation", laneKey] — one lane's breakpoints
                    if (tracks[id] is not JsonObject track || !LaneKeyRegex.IsMatch(path[3])) return null;
                    var lanes = track["automation"] as JsonObject;
                    if (isSet)
                    {
                        value = ValidateLane(op.Value!.Value);
                        if (value == null) return null;
                        if (lanes == null) { lanes = new JsonObject(); track["automation"] = lanes; }
                        if (!lanes.ContainsKey(path[3]) && lanes.Count >= MaxLanes) return null;
                        lanes[path[3]] = value;
                    }
                    else if (lanes == null || !lanes.Remove(path[3])) return null;
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
                    if (clips[id] is not JsonObject clip) return null;
                    if (path[2] == "notes") return null; // replace notes via whole-clip set
                    if (!isSet)
                    {
                        if (RequiredClipFields.Contains(path[2]) || path[2] == "assetId" || !clip.Remove(path[2])) return null;
                        break;
                    }
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
            case "markers":
            case "tempo":
            {
                var coll = doc[path[0]] as JsonObject;
                if (coll == null) { coll = new JsonObject(); doc[path[0]] = coll; }
                var id = path[1];
                if (!IdRegex.IsMatch(id)) return null;
                var isMarker = path[0] == "markers";
                if (path.Count == 2)
                {
                    if (isSet)
                    {
                        if (!coll.ContainsKey(id) && coll.Count >= (isMarker ? MaxMarkers : MaxTempoEvents)) return null;
                        value = isMarker ? ValidateMarker(op.Value!.Value) : ValidateTempoEvent(op.Value!.Value);
                        if (value == null) return null;
                        coll[id] = value;
                    }
                    else if (!coll.Remove(id)) return null;
                }
                else if (path.Count == 3)
                {
                    if (coll[id] is not JsonObject item) return null;
                    if (!isSet)
                    {
                        // beat / name are required; tempo events keep at least one change
                        if (path[2] is "beat" or "name" || !item.ContainsKey(path[2])) return null;
                        var copy = (JsonObject)item.DeepClone();
                        copy.Remove(path[2]);
                        if (!isMarker && !TempoEventHasChange(copy)) return null;
                        item.Remove(path[2]);
                        break;
                    }
                    value = isMarker ? ValidateMarkerField(path[2], op.Value!.Value) : ValidateTempoField(path[2], op.Value!.Value);
                    if (value == null) return null;
                    item[path[2]] = value;
                }
                else return null;
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
        if (doc["markers"] is not JsonObject) doc["markers"] = new JsonObject();
        if (doc["tempo"] is not JsonObject) doc["tempo"] = new JsonObject();
    }

    private static readonly HashSet<string> OptionalMetaFields = new() { "scaleRoot", "scaleMode", "masterEffects", "masterVolume" };
    private static readonly HashSet<string> RequiredTrackFields = new() { "name", "kind", "order", "volume", "pan", "mute", "solo" };
    private static readonly HashSet<string> RequiredClipFields = new() { "trackId", "kind", "start", "length", "gain", "notes" };

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
        "scaleRoot" => Num(v, 0, 11) is { } d && d == Math.Floor(d) ? JsonValue.Create((int)d) : null,
        "scaleMode" => Str(v, 24) is { } m && ScaleModes.Contains(m) ? JsonValue.Create(m) : null,
        "masterEffects" => ValidateEffects(v),
        "masterVolume" => Num(v, -60, 12) is { } d ? JsonValue.Create(d) : null,
        _ => null,
    };

    private static JsonObject? ValidateMarker(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        var m = new JsonObject();
        foreach (var prop in v.EnumerateObject())
        {
            var node = ValidateMarkerField(prop.Name, prop.Value);
            if (node == null) return null;
            m[prop.Name] = node;
        }
        if (m["beat"] == null) return null;
        m["name"] ??= "Marker";
        return m;
    }

    private static JsonNode? ValidateMarkerField(string field, JsonElement v) => field switch
    {
        "beat" => Num(v, 0, 100000) is { } d ? JsonValue.Create(d) : null,
        "name" => Str(v, 40, allowEmpty: true) is { } s ? JsonValue.Create(s) : null,
        "color" => Str(v, 7) is { } s && ColorRegex.IsMatch(s) ? JsonValue.Create(s) : null,
        _ => null,
    };

    private static JsonObject? ValidateTempoEvent(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        var e = new JsonObject();
        foreach (var prop in v.EnumerateObject())
        {
            var node = ValidateTempoField(prop.Name, prop.Value);
            if (node == null) return null;
            e[prop.Name] = node;
        }
        if (e["beat"] == null || !TempoEventHasChange(e)) return null;
        // A signature needs both halves.
        if ((e["num"] == null) != (e["den"] == null)) return null;
        return e;
    }

    private static bool TempoEventHasChange(JsonObject e) => e["bpm"] != null || (e["num"] != null && e["den"] != null);

    private static JsonNode? ValidateTempoField(string field, JsonElement v) => field switch
    {
        "beat" => Num(v, 1.0 / 64, 100000) is { } d ? JsonValue.Create(d) : null,
        "bpm" => Num(v, 20, 400) is { } d ? JsonValue.Create(d) : null,
        "num" => Num(v, 1, 16) is { } d && d == Math.Floor(d) ? JsonValue.Create((int)d) : null,
        "den" => Num(v, 1, 16) is { } d && d is 2 or 4 or 8 or 16 ? JsonValue.Create((int)d) : null,
        _ => null,
    };

    /// Must match client/src/studio/scales.ts.
    private static readonly HashSet<string> ScaleModes = new()
    {
        "none", "major", "minor", "dorian", "phrygian", "lydian", "mixolydian", "locrian",
        "harmonicMinor", "melodicMinor", "majorPentatonic", "minorPentatonic", "blues",
    };

    private static JsonObject? ValidateTrack(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        if (!v.TryGetProperty("kind", out var kindEl)) return null;
        var kind = Str(kindEl, 16);
        if (kind is not ("audio" or "instrument" or "return" or "group")) return null;

        var track = new JsonObject { ["kind"] = kind };
        foreach (var prop in v.EnumerateObject())
        {
            if (prop.Name == "kind") continue;
            var node = ValidateTrackField(prop.Name, prop.Value, kind);
            if (node == null) return null;
            track[prop.Name] = node;
        }
        track["name"] ??= kind switch { "audio" => "Audio", "return" => "Return", "group" => "Group", _ => "Instrument" };
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
        "automation" => ValidateAutomation(v),
        // Group track this one feeds ("" = master). Dangling ids fall back to master on clients.
        "output" => kind != "return" && Str(v, 40, allowEmpty: true) is { } o && (o.Length == 0 || IdRegex.IsMatch(o)) ? JsonValue.Create(o) : null,
        "sends" => kind != "return" ? ValidateSends(v) : null,
        "collapsed" => kind == "group" && Bool(v) is { } b ? JsonValue.Create(b) : null,
        _ => null,
    };

    private static JsonObject? ValidateSends(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        var result = new JsonObject();
        foreach (var prop in v.EnumerateObject())
        {
            if (result.Count >= MaxSends || !IdRegex.IsMatch(prop.Name) || Num(prop.Value, -60, 6) is not { } lvl) return null;
            result[prop.Name] = lvl;
        }
        return result;
    }

    /// Audio clips live on audio tracks, MIDI clips on instrument tracks; returns/groups hold none.
    private static bool ClipFitsTrack(string? clipKind, string? trackKind) =>
        (clipKind == "audio" && trackKind == "audio") || (clipKind == "midi" && trackKind == "instrument");

    public const int MaxLanes = 48;
    public const int MaxLanePoints = 4000;
    private static readonly Regex LaneKeyRegex = new(@"^[A-Za-z0-9:_-]{1,80}$", RegexOptions.Compiled);

    /// Automation lanes: { laneKey: [[beat, value], ...] }
    private static JsonObject? ValidateAutomation(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        var result = new JsonObject();
        foreach (var prop in v.EnumerateObject())
        {
            if (result.Count >= MaxLanes || !LaneKeyRegex.IsMatch(prop.Name)) return null;
            var lane = ValidateLane(prop.Value);
            if (lane == null) return null;
            result[prop.Name] = lane;
        }
        return result;
    }

    /// One lane: up to MaxLanePoints [beat, value] pairs, returned sorted by beat.
    private static JsonArray? ValidateLane(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Array || v.GetArrayLength() > MaxLanePoints) return null;
        var points = new List<(double Beat, double Value)>();
        foreach (var pt in v.EnumerateArray())
        {
            if (pt.ValueKind != JsonValueKind.Array || pt.GetArrayLength() != 2) return null;
            if (Num(pt[0], 0, 100000) is not { } beat || Num(pt[1], -1e6, 1e6) is not { } val) return null;
            points.Add((beat, val));
        }
        var arr = new JsonArray();
        foreach (var (beat, val) in points.OrderBy(p => p.Beat))
            arr.Add(new JsonArray(JsonValue.Create(beat), JsonValue.Create(val)));
        return arr;
    }

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

    /// Flat map of up to 256 numeric/string/bool params (EQ Eight bands, wavetable synth + mod matrix).
    private static JsonObject? ValidateParams(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        var result = new JsonObject();
        var count = 0;
        foreach (var prop in v.EnumerateObject())
        {
            // EQ Eight carries 8 bands x 5 params; the Drum Rack up to 16 pads x 10.
            if (++count > 256 || prop.Name.Length > 32) return null;
            JsonNode? node = prop.Value.ValueKind switch
            {
                JsonValueKind.Number => Num(prop.Value, -1e6, 1e6) is { } d ? JsonValue.Create(d) : null,
                // 40 fits an asset id (GUID) for the sampler
                JsonValueKind.String => Str(prop.Value, 40, allowEmpty: true) is { } s ? JsonValue.Create(s) : null,
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
        if (!ClipFitsTrack(kind, track["kind"]?.GetValue<string>())) return null;

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
                return ClipFitsTrack(kind, t["kind"]?.GetValue<string>()) ? JsonValue.Create(id) : null;
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
            case "mute": return Bool(v) is { } mu ? JsonValue.Create(mu) : null;
            case "warp" or "reverse": return kind == "audio" && Bool(v) is { } wb ? JsonValue.Create(wb) : null;
            case "srcBpm": return kind == "audio" && Num(v, 20, 400) is { } sb ? JsonValue.Create(sb) : null;
            case "pitch": return kind == "audio" && Num(v, -24, 24) is { } pt ? JsonValue.Create(pt) : null;
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
            List<StudioChange> changes;
            lock (session.Lock)
            {
                json = session.Doc.ToJsonString();
                version = session.Version;
                session.Dirty = false;
                changes = session.PendingChanges.ToList();
                session.PendingChanges.Clear();
            }
            if (changes.Count > 0)
            {
                try
                {
                    db.StudioChanges.AddRange(changes);
                    await db.SaveChangesAsync(ct);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to write studio history for {ProjectId}", session.ProjectId);
                    db.ChangeTracker.Clear();
                    lock (session.Lock) { session.PendingChanges.InsertRange(0, changes); session.Dirty = true; }
                }
            }
            await MaintainHistoryAsync(db, session, version, ct);
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

    /// <summary>Automatic snapshots while the project changes, and history retention.</summary>
    private async Task MaintainHistoryAsync(AppDbContext db, StudioSession session, long version, CancellationToken ct)
    {
        try
        {
            if (version != session.LastSnapshotVersion && DateTime.UtcNow - session.LastSnapshotAt > AutoSnapshotEvery)
                await SaveVersionAsync(session.ChannelId, "Auto-save", null, auto: true);
            if (DateTime.UtcNow - session.LastPruneAt > TimeSpan.FromHours(1))
            {
                session.LastPruneAt = DateTime.UtcNow;
                var cutoffTime = DateTime.UtcNow - HistoryRetention;
                await db.StudioChanges.Where(c => c.ProjectId == session.ProjectId && c.CreatedAt < cutoffTime).ExecuteDeleteAsync(ct);
                var cutoffId = await db.StudioChanges.Where(c => c.ProjectId == session.ProjectId)
                    .OrderByDescending(c => c.Id).Skip(MaxHistoryRows).Select(c => (long?)c.Id).FirstOrDefaultAsync(ct);
                if (cutoffId != null) await db.StudioChanges.Where(c => c.ProjectId == session.ProjectId && c.Id <= cutoffId).ExecuteDeleteAsync(ct);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Studio history maintenance failed for {ProjectId}", session.ProjectId);
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
