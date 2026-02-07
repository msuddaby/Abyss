using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Abyss.Api.Data;
using Abyss.Api.Hubs;
using Abyss.Api.Models;
using Abyss.Api.Services;

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
var connectionString = $"Host={pgHost};Port={pgPort};Database={pgDb};Username={pgUser};Password={pgPass}";
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
builder.Services.AddSingleton<VoiceStateService>();
builder.Services.AddSingleton<ImageService>();
builder.Services.AddSingleton<MediaConfig>();
builder.Services.AddScoped<MediaValidator>();

// HTTP Client for push notifications
builder.Services.AddHttpClient();

// SignalR
builder.Services.AddSignalR();

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
                .WithMethods("GET", "POST", "PUT", "PATCH", "DELETE")
                .WithHeaders("content-type", "authorization", "x-requested-with");
        });
    });
}



var app = builder.Build();

// Auto-migrate database
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}

app.UseCors();
app.UseAuthentication();
app.UseAuthorization();
app.UseStaticFiles();

app.MapControllers();
app.MapHub<ChatHub>("/hubs/chat");
app.MapGet("/health", () => Results.Ok());

app.Run();
