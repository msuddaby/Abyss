using Microsoft.AspNetCore.DataProtection;

namespace Abyss.Api.Services.MediaProviders;

public class ProviderConfigProtector
{
    private readonly IDataProtector _protector;

    public ProviderConfigProtector(IDataProtectionProvider provider)
    {
        _protector = provider.CreateProtector("MediaProvider.Config.v1");
    }

    public string Encrypt(string plainText) => _protector.Protect(plainText);

    public string Decrypt(string cipherText)
    {
        try
        {
            return _protector.Unprotect(cipherText);
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            // Legacy rows stored plain-text JSON before encryption was enforced
            return cipherText;
        }
    }
}
