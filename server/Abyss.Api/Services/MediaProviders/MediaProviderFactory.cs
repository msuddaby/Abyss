using Abyss.Api.Models;

namespace Abyss.Api.Services.MediaProviders;

public class MediaProviderFactory
{
    private readonly IServiceProvider _serviceProvider;

    public MediaProviderFactory(IServiceProvider serviceProvider)
    {
        _serviceProvider = serviceProvider;
    }

    public IMediaProvider? GetProvider(MediaProviderType type)
    {
        return type switch
        {
            MediaProviderType.Plex => _serviceProvider.GetService<PlexMediaProvider>(),
            _ => null
        };
    }
}
