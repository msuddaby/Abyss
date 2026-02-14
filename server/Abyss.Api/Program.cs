using System.Threading.RateLimiting;
using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;
using Microsoft.IdentityModel.Tokens;
using Microsoft.AspNetCore.DataProtection;
using Abyss.Api.Data;
using Abyss.Api.Hubs;
using Abyss.Api.Models;
using Abyss.Api.Services;
using Abyss.Api.Services.MediaProviders;

// Load env file from project root (.env.dev takes priority for local dev, then .env)
// In Docker containers, env vars come from docker-compose env_file directive instead.
var projectRoot = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "..", ".."));
var envDevPath = Path.Combine(projectRoot, ".env.dev");
var envPath = Path.Combine(projectRoot, ".env");
var envFile = File.Exists(envDevPath) ? envDevPath : File.Exists(envPath) ? envPath : null;
if (envFile is not null)
{
    foreach (var line in File.ReadAllLines(envFile))
    {
        var trimmed = line.Trim();
        if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith('#')) continue;
        var eq = trimmed.IndexOf('=');
        if (eq <= 0) continue;
        var key = trimmed[..eq].Trim();
        var val = trimmed[(eq + 1)..].Trim();
        if (!string.IsNullOrEmpty(val))
            Environment.SetEnvironmentVariable(key, val);
    }
}

var builder = WebApplication.CreateBuilder(args);

// Database
var pgHost = Environment.GetEnvironmentVariable("POSTGRES_HOST") ?? "localhost";
var pgPort = Environment.GetEnvironmentVariable("POSTGRES_PORT") ?? "5433";
var pgDb = Environment.GetEnvironmentVariable("POSTGRES_DB") ?? "abyss";
var pgUser = Environment.GetEnvironmentVariable("POSTGRES_USER") ?? "abyss";
var pgPass = Environment.GetEnvironmentVariable("POSTGRES_PASSWORD")
    ?? throw new InvalidOperationException("POSTGRES_PASSWORD is not configured. Check your .env file.");
var connectionString = $"Host={pgHost};Port={pgPort};Database={pgDb};Username={pgUser};Password={pgPass};" +
    "Maximum Pool Size=100;Minimum Pool Size=10;Connection Idle Lifetime=300;Connection Pruning Interval=10";
builder.Services.AddDbContext<AppDbContext>(opt =>
    opt.UseNpgsql(connectionString));

// Identity
builder.Services.AddIdentity<AppUser, IdentityRole>(opt =>
{
    opt.Password.RequireNonAlphanumeric = false;
    opt.Password.RequireUppercase = false;
    opt.Password.RequiredLength = 6;
})
.AddEntityFrameworkStores<AppDbContext>()
.AddDefaultTokenProviders();

// JWT
var jwtKey = Environment.GetEnvironmentVariable("JWT_KEY")
    ?? throw new InvalidOperationException("JWT_KEY is not configured. Check your .env file.");
var jwtIssuer = Environment.GetEnvironmentVariable("JWT_ISSUER") ?? "Abyss";
var jwtAudience = Environment.GetEnvironmentVariable("JWT_AUDIENCE") ?? "Abyss";
builder.Services.AddAuthentication(opt =>
{
    opt.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    opt.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(opt =>
{
    opt.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = true,
        ValidateAudience = true,
        ValidateLifetime = true,
        ValidateIssuerSigningKey = true,
        ValidIssuer = jwtIssuer,
        ValidAudience = jwtAudience,
        IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey))
    };

    // SignalR sends JWT via query string
    opt.Events = new JwtBearerEvents
    {
        OnMessageReceived = context =>
        {
            var accessToken = context.Request.Query["access_token"];
            var path = context.HttpContext.Request.Path;
            if (!string.IsNullOrEmpty(accessToken) && path.StartsWithSegments("/hubs"))
            {
                context.Token = accessToken;
            }
            return Task.CompletedTask;
        }
    };
});

builder.Services.AddAuthorization();

// Services
builder.Services.AddScoped<TokenService>();
builder.Services.AddScoped<PermissionService>();
builder.Services.AddScoped<NotificationService>();
builder.Services.AddScoped<SystemMessageService>();
builder.Services.AddSingleton<VoiceStateService>();
builder.Services.AddSingleton<TurnCredentialService>();
builder.Services.AddSingleton<ImageService>();
builder.Services.AddSingleton<VideoPosterService>();
builder.Services.AddSingleton<MediaConfig>();
builder.Services.AddScoped<MediaValidator>();
builder.Services.AddScoped<MediaUploadService>();
builder.Services.AddScoped<CosmeticService>();

// Watch party / media providers
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo("/app/data-protection-keys"));
builder.Services.AddSingleton<ProviderConfigProtector>();
builder.Services.AddScoped<MediaProviderFactory>();
builder.Services.AddSingleton<WatchPartyService>();
builder.Services.AddMemoryCache(opt => opt.SizeLimit = 2000); // ~2000 cached thumbnails
builder.Services.AddHttpClient<PlexMediaProvider>();
builder.Services.AddHttpClient<YouTubeMediaProvider>();

// Rate Limiting
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddFixedWindowLimiter("api", opt =>
    {
        opt.Window = TimeSpan.FromMinutes(1);
        opt.PermitLimit = 200;
        opt.QueueLimit = 0;
    });

    options.AddFixedWindowLimiter("auth", opt =>
    {
        opt.Window = TimeSpan.FromMinutes(15);
        opt.PermitLimit = 10;
        opt.QueueLimit = 0;
    });

    options.AddFixedWindowLimiter("upload", opt =>
    {
        opt.Window = TimeSpan.FromMinutes(1);
        opt.PermitLimit = 20;
        opt.QueueLimit = 0;
    });
});

// Request size limits
builder.Services.Configure<KestrelServerOptions>(options =>
{
    options.Limits.MaxRequestBodySize = 52_428_800; // 50MB
});
builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = 52_428_800; // 50MB
});

// Voice state cleanup
builder.Services.AddHostedService<VoiceStateCleanupService>();

// Audit log cleanup
builder.Services.AddHostedService<AuditLogCleanupService>();

// HTTP Client for push notifications
builder.Services.AddHttpClient();

// SignalR
builder.Services.AddSignalR(options =>
{
    options.EnableDetailedErrors = true;
});

// Controllers
builder.Services.AddControllers();

// CORS
var corsEnv = Environment.GetEnvironmentVariable("CORS_ORIGINS");
var allowedOrigins = !string.IsNullOrEmpty(corsEnv)
    ? corsEnv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
    : new[] { "http://localhost:5173" };
if (builder.Environment.IsDevelopment())
{
    builder.Services.AddCors(opt =>
    {
        opt.AddDefaultPolicy(policy =>
        {
            policy.WithOrigins(allowedOrigins)
                .AllowAnyHeader()
                .AllowAnyMethod()
                .AllowCredentials();
        });
    });
}
else
{
    builder.Services.AddCors(opt =>
    {
        opt.AddDefaultPolicy(policy =>
        {
            policy.WithOrigins(allowedOrigins)
                .AllowCredentials()
                .AllowAnyMethod()
                .AllowAnyHeader();
        });
    });
}



var app = builder.Build();

// Auto-migrate database and seed data
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
    await CosmeticSeeder.SeedAsync(db);
}

// Exception handler for production (prevents stack trace leaking)
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/error");
}

app.UseCors();
app.UseRateLimiter();

// Security headers
app.Use(async (context, next) =>
{
    context.Response.Headers["X-Frame-Options"] = "DENY";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    await next();
});

app.UseAuthentication();
app.UseAuthorization();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx =>
    {
        var origin = ctx.Context.Request.Headers.Origin.FirstOrDefault();
        if (origin != null && allowedOrigins.Contains(origin))
        {
            ctx.Context.Response.Headers["Access-Control-Allow-Origin"] = origin;
        }
    }
});

var soundsDir = Path.Combine(Directory.GetCurrentDirectory(), "uploads", "sounds");
Directory.CreateDirectory(soundsDir);
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(soundsDir),
    RequestPath = "/uploads/sounds",
    OnPrepareResponse = ctx =>
    {
        ctx.Context.Response.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
        var origin = ctx.Context.Request.Headers.Origin.FirstOrDefault();
        if (origin != null && allowedOrigins.Contains(origin))
        {
            ctx.Context.Response.Headers["Access-Control-Allow-Origin"] = origin;
        }
    }
});

var soundboardDir = Path.Combine(Directory.GetCurrentDirectory(), "uploads", "soundboard");
Directory.CreateDirectory(soundboardDir);
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(soundboardDir),
    RequestPath = "/uploads/soundboard",
    OnPrepareResponse = ctx =>
    {
        ctx.Context.Response.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
        var origin = ctx.Context.Request.Headers.Origin.FirstOrDefault();
        if (origin != null && allowedOrigins.Contains(origin))
        {
            ctx.Context.Response.Headers["Access-Control-Allow-Origin"] = origin;
        }
    }
});

app.MapControllers().RequireRateLimiting("api");
app.MapHub<ChatHub>("/hubs/chat");
app.MapGet("/health", () => Results.Ok());

app.Map("/error", (HttpContext context) =>
{
    var logger = context.RequestServices.GetRequiredService<ILogger<Program>>();
    var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;
    logger.LogError(exception, "Unhandled exception");
    return Results.Problem(title: "An error occurred", statusCode: 500);
});

app.Run();
