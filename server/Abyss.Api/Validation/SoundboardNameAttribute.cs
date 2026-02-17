using System.ComponentModel.DataAnnotations;
using System.Text.RegularExpressions;

namespace Abyss.Api.Validation;

[AttributeUsage(AttributeTargets.Property | AttributeTargets.Field | AttributeTargets.Parameter)]
public class SoundboardNameAttribute : ValidationAttribute
{
    private static readonly Regex SoundboardNameRegex = new("^[a-zA-Z0-9_\\- ]{2,32}$", RegexOptions.Compiled);

    protected override ValidationResult? IsValid(object? value, ValidationContext validationContext)
    {
        if (value is null)
        {
            return ValidationResult.Success;
        }

        if (value is string name && SoundboardNameRegex.IsMatch(name))
        {
            return ValidationResult.Success;
        }

        return new ValidationResult("Soundboard name must be 2-32 characters, alphanumeric, spaces, hyphens, or underscores.");
    }
}
