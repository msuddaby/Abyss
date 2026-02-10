FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY Abyss.Api/Abyss.Api.csproj Abyss.Api/
RUN dotnet restore Abyss.Api/Abyss.Api.csproj
COPY . .
RUN dotnet publish Abyss.Api/Abyss.Api.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/publish .
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    mkdir -p wwwroot/uploads/emojis /app/uploads && \
    chown -R $APP_UID:$APP_UID wwwroot/uploads /app/uploads
ENV ASPNETCORE_URLS=http://+:5000
ENV ASPNETCORE_ENVIRONMENT=Production
EXPOSE 5000
USER $APP_UID
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["dotnet", "Abyss.Api.dll"]
