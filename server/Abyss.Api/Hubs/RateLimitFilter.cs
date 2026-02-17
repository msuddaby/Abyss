using System.Security.Claims;
using Microsoft.AspNetCore.SignalR;
using Abyss.Api.Services;

namespace Abyss.Api.Hubs;

public class RateLimitFilter : IHubFilter
{
    private readonly HubRateLimiter _rateLimiter;

    public RateLimitFilter(HubRateLimiter rateLimiter)
    {
        _rateLimiter = rateLimiter;
    }

    public async ValueTask<object?> InvokeMethodAsync(
        HubInvocationContext invocationContext,
        Func<HubInvocationContext, ValueTask<object?>> next)
    {
        var methodName = invocationContext.HubMethodName;

        if (_rateLimiter.IsExempt(methodName))
            return await next(invocationContext);

        var userId = invocationContext.Context.User?.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(userId))
            return await next(invocationContext);

        var retryAfter = _rateLimiter.TryConsume(userId, methodName);
        if (retryAfter == null)
            return await next(invocationContext);

        // Rate limited — notify the client
        var retrySeconds = Math.Ceiling(retryAfter.Value.TotalSeconds);
        var clients = invocationContext.Hub.Clients;

        await clients.Caller.SendAsync("RateLimited", methodName, retrySeconds);

        // Show error toast for non-silent categories
        if (!_rateLimiter.IsSilent(methodName))
        {
            await clients.Caller.SendAsync("Error",
                $"You're doing that too quickly. Please wait {retrySeconds:0}s.");
        }

        // Return a sensible default so SignalR doesn't throw
        var returnType = invocationContext.HubMethod.ReturnType;
        // Unwrap Task<T> or ValueTask<T>
        if (returnType.IsGenericType)
        {
            var genericDef = returnType.GetGenericTypeDefinition();
            if (genericDef == typeof(Task<>) || genericDef == typeof(ValueTask<>))
                returnType = returnType.GetGenericArguments()[0];
        }

        if (returnType == typeof(Task) || returnType == typeof(ValueTask) || returnType == typeof(void))
            return null;

        // For methods that return a value, create a default instance
        if (returnType.IsValueType)
            return Activator.CreateInstance(returnType);

        return null;
    }
}
