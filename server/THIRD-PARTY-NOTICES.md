# Bundled runtime components

The launcher bundles unmodified Windows runtimes. Versions and SHA-256 digests are recorded in runtime-manifest.json. Third-party components retain their licenses; application code is separate.

- Node.js: MIT and bundled third-party notices, https://github.com/nodejs/node/blob/main/LICENSE
- PostgreSQL: PostgreSQL License, https://www.postgresql.org/about/licence/ ; Windows distribution by EDB, https://www.enterprisedb.com/download-postgresql-binaries
- Caddy: Apache-2.0, https://github.com/caddyserver/caddy/blob/master/LICENSE
- cloudflared: Apache-2.0, https://github.com/cloudflare/cloudflared/blob/master/LICENSE
- .NET runtime: MIT and third-party notices, https://github.com/dotnet/runtime/blob/main/LICENSE.TXT
- Microsoft Visual C++ runtime: Microsoft redistributable terms and REDIST list, https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files ; application-local release DLLs are copied from the licensed Visual Studio build machine's Microsoft-signed runtime and versioned in the manifest. No system runtime installation is performed by the launcher.
- npm packages: license files are included in functions/node_modules with each package.

Before external redistribution, preserve the complete upstream license/notice files and inspect any bundled native dependency's redistribution requirements. Runtime downloads come from the listed publishers; recording a local hash alone is not an independent publisher signature for PostgreSQL.
