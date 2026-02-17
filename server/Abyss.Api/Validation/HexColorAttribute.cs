using System.ComponentModel.DataAnnotations;
using System.Text.RegularExpressions;

namespace Abyss.Api.Validation;

[AttributeUsage(AttributeTargets.Property | AttributeTargets.Field | AttributeTargets.Parameter)]
public class HexColorAttribute : ValidationAttribute
{
    private static readonly Regex HexColorRegex = new("^#[0-9A-Fa-f]{6}$", RegexOptions.Compiled);

    protected override ValidationResult? IsValid(object? value, ValidationContext validationContext)
    {
        if (value is null)
        {
            return ValidationResult.Success;
        }

        if (value is string color && HexColorRegex.IsMatch(color))
        {
            return ValidationResult.Success;
        }

        return new ValidationResult("Invalid hex color format. Expected #RRGGBB.");
    }
}
