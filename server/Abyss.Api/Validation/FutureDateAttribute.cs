using System.ComponentModel.DataAnnotations;

namespace Abyss.Api.Validation;

[AttributeUsage(AttributeTargets.Property | AttributeTargets.Field | AttributeTargets.Parameter)]
public class FutureDateAttribute : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext validationContext)
    {
        if (value is null)
        {
            return ValidationResult.Success;
        }

        if (value is DateTime dateTime && dateTime > DateTime.UtcNow)
        {
            return ValidationResult.Success;
        }

        return new ValidationResult("Date must be in the future.");
    }
}
