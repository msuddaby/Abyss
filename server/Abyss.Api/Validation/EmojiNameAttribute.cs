using System.ComponentModel.DataAnnotations;
using System.Text.RegularExpressions;

namespace Abyss.Api.Validation;

[AttributeUsage(AttributeTargets.Property | AttributeTargets.Field | AttributeTargets.Parameter)]
public class EmojiNameAttribute : ValidationAttribute
{
    private static readonly Regex EmojiNameRegex = new("^[a-zA-Z0-9_]{2,32}$", RegexOptions.Compiled);

    protected override ValidationResult? IsValid(object? value, ValidationContext validationContext)
    {
        if (value is null)
        {
            return ValidationResult.Success;
        }

        if (value is string name && EmojiNameRegex.IsMatch(name))
        {
            return ValidationResult.Success;
        }

        return new ValidationResult("Emoji name must be 2-32 characters, alphanumeric or underscore.");
    }
}
