FROM mcr.microsoft.com/dotnet/sdk:10.0-preview AS build
WORKDIR /src
COPY Abyss.Api/Abyss.Api.csproj Abyss.Api/
RUN dotnet restore Abyss.Api/Abyss.Api.csproj
COPY . .
RUN dotnet publish Abyss.Api/Abyss.Api.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0-preview
WORKDIR /app
COPY --from=build /app/publish .
RUN mkdir -p wwwroot/uploads
ENV ASPNETCORE_URLS=http://+:5000
ENV ASPNETCORE_ENVIRONMENT=Production
EXPOSE 5000
USER $APP_UID
ENTRYPOINT ["dotnet", "Abyss.Api.dll"]
