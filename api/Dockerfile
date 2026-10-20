# MEDLINK API — multi-stage build. Works on the Oracle Always Free ARM VM (linux/arm64) and on x64.
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY src/MedLink.Api/MedLink.Api.csproj src/MedLink.Api/
RUN dotnet restore src/MedLink.Api/MedLink.Api.csproj
COPY src/ src/
RUN dotnet publish src/MedLink.Api/MedLink.Api.csproj -c Release -o /out --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out .
# Runs as the image's non-root "app" user. No secrets are baked in: everything comes from the environment.
# The data-protection key directory must belong to "app"; a fresh named volume copies this ownership.
RUN mkdir -p /var/lib/medlink/keys && chown app:app /var/lib/medlink/keys && chmod 700 /var/lib/medlink/keys
USER app
ENV ASPNETCORE_HTTP_PORTS=8080 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DATA_PROTECTION_KEYS_PATH=/var/lib/medlink/keys
EXPOSE 8080
ENTRYPOINT ["dotnet", "medlink.dll"]
