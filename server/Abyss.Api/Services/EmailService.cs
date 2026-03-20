using System.Net;
using System.Net.Mail;

namespace Abyss.Api.Services;

public class EmailService
{
    private readonly string? _host;
    private readonly int _port;
    private readonly string? _username;
    private readonly string? _password;
    private readonly string _fromAddress;
    private readonly string _fromName;
    private readonly bool _enableSsl;
    private readonly bool _configured;

    public EmailService()
    {
        _host = Environment.GetEnvironmentVariable("SMTP_HOST");
        var portStr = Environment.GetEnvironmentVariable("SMTP_PORT");
        _port = int.TryParse(portStr, out var port) ? port : 587;
        _username = Environment.GetEnvironmentVariable("SMTP_USERNAME");
        _password = Environment.GetEnvironmentVariable("SMTP_PASSWORD");
        _fromAddress = Environment.GetEnvironmentVariable("SMTP_FROM_ADDRESS") ?? "noreply@example.com";
        _fromName = Environment.GetEnvironmentVariable("SMTP_FROM_NAME") ?? "Abyss";
        var sslStr = Environment.GetEnvironmentVariable("SMTP_ENABLE_SSL");
        _enableSsl = sslStr == null || !bool.TryParse(sslStr, out var ssl) || ssl; // default true

        _configured = !string.IsNullOrWhiteSpace(_host);
        if (!_configured)
        {
            Console.WriteLine("SMTP not configured — password reset emails disabled.");
        }
    }

    public bool IsConfigured => _configured;

    public async Task SendPasswordResetEmailAsync(string toEmail, string resetUrl)
    {
        if (!_configured)
            throw new InvalidOperationException("SMTP is not configured.");

        var subject = "Reset Your Abyss Password";
        var body = $"""
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #5865F2;">Abyss Password Reset</h2>
                <p>We received a request to reset your password. Click the button below to choose a new password:</p>
                <div style="text-align: center; margin: 30px 0;">
                    <a href="{resetUrl}" style="background-color: #5865F2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: 600;">Reset Password</a>
                </div>
                <p style="color: #888; font-size: 14px;">If you didn't request this, you can safely ignore this email. The link expires in 1 hour.</p>
                <p style="color: #888; font-size: 14px;">Or copy and paste this URL into your browser:</p>
                <p style="color: #888; font-size: 12px; word-break: break-all;">{resetUrl}</p>
            </div>
            """;

        await SendEmailAsync(toEmail, subject, body);
    }

    private async Task SendEmailAsync(string to, string subject, string htmlBody)
    {
        using var client = new SmtpClient(_host!, _port);
        client.EnableSsl = _enableSsl;

        if (!string.IsNullOrWhiteSpace(_username) && !string.IsNullOrWhiteSpace(_password))
        {
            client.Credentials = new NetworkCredential(_username, _password);
        }

        var message = new MailMessage
        {
            From = new MailAddress(_fromAddress, _fromName),
            Subject = subject,
            Body = htmlBody,
            IsBodyHtml = true
        };
        message.To.Add(to);

        await client.SendMailAsync(message);
    }
}
