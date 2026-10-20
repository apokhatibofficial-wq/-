using MailKit.Net.Smtp;
using MailKit.Security;
using MedLink.Api.Config;
using MimeKit;

namespace MedLink.Api.Email;

public sealed record EmailMessage(string Kind, string To, string Subject, string TextBody);

public interface IEmailSender
{
    Task SendAsync(EmailMessage message, CancellationToken ct = default);
}

/// <summary>
/// SMTP delivery. Development uses Mailpit (no credentials). Production uses the transactional
/// provider's SMTP relay with EMAIL_API_KEY as the password (e.g. Resend: smtp.resend.com:465, user "resend").
/// </summary>
public sealed class SmtpEmailSender(MedLinkOptions options, ILogger<SmtpEmailSender> log) : IEmailSender
{
    public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        var mime = new MimeMessage();
        mime.From.Add(MailboxAddress.Parse(options.EmailFrom));
        mime.To.Add(MailboxAddress.Parse(message.To));
        mime.Subject = message.Subject;
        mime.Body = new TextPart("plain") { Text = message.TextBody };

        using var client = new SmtpClient();
        var tls = options.SmtpTls switch
        {
            "ssl" => SecureSocketOptions.SslOnConnect,
            "starttls" => SecureSocketOptions.StartTls,
            _ => SecureSocketOptions.None,
        };
        await client.ConnectAsync(options.SmtpHost, options.SmtpPort, tls, ct);
        if (!string.IsNullOrEmpty(options.SmtpUser))
            await client.AuthenticateAsync(options.SmtpUser, options.SmtpPassword ?? "", ct);
        await client.SendAsync(mime, ct);
        await client.DisconnectAsync(true, ct);
        // Never log the recipient or body: the body contains a one-time link.
        log.LogInformation("email sent: {Kind}", message.Kind);
    }
}

/// <summary>Trilingual one-time-link emails (Arabic first). No secrets other than the link itself.</summary>
public static class LinkEmails
{
    public static EmailMessage Build(string to, string purpose, string url, TimeSpan validFor)
    {
        var hours = validFor.TotalHours >= 1 ? $"{validFor.TotalHours:0}" : null;
        var minutes = $"{validFor.TotalMinutes:0}";
        var (ar, en, tr) = purpose switch
        {
            "setup" => ("إعداد حساب مسؤول الشركة", "Set up your company admin account", "Şirket yönetici hesabınızı kurun"),
            "activation" => ("تفعيل حسابك في MEDLINK", "Activate your MEDLINK account", "MEDLINK hesabınızı etkinleştirin"),
            _ => ("إعادة تعيين كلمة المرور في MEDLINK", "Reset your MEDLINK password", "MEDLINK şifrenizi sıfırlayın"),
        };
        var validAr = hours is not null ? $"{hours} ساعة" : $"{minutes} دقيقة";
        var validEn = hours is not null ? $"{hours} hour(s)" : $"{minutes} minutes";
        var validTr = hours is not null ? $"{hours} saat" : $"{minutes} dakika";
        var body = $"""
            {ar}
            افتح الرابط التالي لاختيار كلمة المرور وتفعيل التحقق الثنائي. الرابط صالح لمدة {validAr} ولمرة واحدة فقط.
            لن يطلب منك أحد من MEDLINK كلمة المرور أو رمز التحقق أبدًا.

            {en}
            Open this link to choose your password and set up two-step verification. It works once and expires in {validEn}.
            Nobody from MEDLINK will ever ask you for your password or verification code.

            {tr}
            Şifrenizi seçmek ve iki adımlı doğrulamayı kurmak için bu bağlantıyı açın. Tek kullanımlıktır ve {validTr} içinde sona erer.

            {url}

            KHATIB TECHNICAL SOLUTIONS — الخطيب للحلول التقنية
            """;
        return new EmailMessage(purpose, to, $"MEDLINK — {en} | {ar}", body);
    }
}
