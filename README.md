# SAP ADT Hub (ARC-1)

An MCP server that connects Claude to **several SAP ABAP systems at the same time** through ADT.
It runs one [ARC-1](https://github.com/arc-mcp/arc-1) process per SAP connection and exposes ARC-1's tools
(SAPRead, SAPSearch, SAPContext, SAPWrite, SAPDiagnose, SAPTransport, ...) with an extra `system` argument.

- **Many systems, one chat**: `SAPRead {system: "DEV", ...}` and `SAPRead {system: "QAS", ...}` side by side.
- **Add connections in the chat** ("connect to DEV at https://host:44300, client 100, user JDOE"): the password is
  typed in a Windows dialog, stored DPAPI-encrypted for the Windows user, and never passes through the chat.
  Or define one connection in the extension settings.
- **Always the newest ARC-1**: whenever a connection starts, the hub checks npm, installs a newer ARC-1 and
  returns its release notes so Claude knows what is new.
- **Read-only by default**: writes, free SQL, data preview and transport/Git writes are enabled per connection with
  `adt_set_permissions`. Write tools only appear when at least one connection allows them.
- **Compatible with the ARC-1 multi-system helper** (`~/.arc1/systems/<ID>.env` + `~/.arc1/secrets/<ID>.sec`).

Setup for end users: [INSTALL.md](INSTALL.md).

## How it works

```
Claude (Desktop / Code) ──MCP stdio──> server/index.js (hub, no dependencies)
                                         ├─ ARC-1 child for DEV ──ADT/HTTP──> SAP DEV
                                         ├─ ARC-1 child for QAS ──ADT/HTTP──> SAP QAS
                                         └─ ...
```

- ARC-1 is installed on demand with npm into `%LOCALAPPDATA%\sap-adt-hub\arc1` (falls back to a global `arc-1`).
- The tool schema is read once from ARC-1 and cached per ARC-1 version.
- Children start lazily on the first call for a system and stop with the hub.

## Hub tools

| Tool | Purpose |
|------|---------|
| `adt_connections` | List connections, permissions, password status, ARC-1 version |
| `adt_add_connection` | Add/update a connection, ask for the password in a Windows dialog, check updates, test |
| `adt_set_password` | Enter or change a password (Windows dialog) |
| `adt_test_connection` | Check for ARC-1 updates and read the system info |
| `adt_set_permissions` | Allow writes (+ packages/transports), transport/Git writes, free SQL, data preview |
| `adt_remove_connection` | Delete a connection and its password |
| `adt_check_updates` | Check npm now and install a newer ARC-1 |
| `adt_guide` | Usage rules for Claude |

## Install

- **Claude Desktop**: download `sap-adt-hub.mcpb` from the [latest release](../../releases/latest) and double-click it.
- **Claude Code**: `claude mcp add sap-adt-hub -- node <path>/server/index.js`

Requirements: Windows, Node.js LTS with npm, network access to the SAP ADT service (`/sap/bc/adt`).

## Configuration (environment)

| Variable | Meaning |
|----------|---------|
| `ADT_CONFIG_DIR` | Connections folder (default `~/.arc1`) |
| `ADT_DEFAULT_SYSTEM` | Connection used when no `system` is given |
| `ADT_AUTO_UPDATE` | `false` to only report new ARC-1 versions |
| `ADT_CONN_ID`, `ADT_CONN_URL`, `ADT_CONN_CLIENT`, `ADT_CONN_USER`, `ADT_CONN_PASSWORD`, `ADT_CONN_INSECURE` | One connection defined by settings |

Connection file `systems/<ID>.env`:

```
SAP_URL=https://host:44300
SAP_CLIENT=100
SAP_USER=JDOE
# optional: SAP_LANGUAGE, SAP_INSECURE=true, SAP_ALLOW_WRITES=true, SAP_ALLOWED_PACKAGES=$TMP, ...
```

## Build

```bash
npx @anthropic-ai/mcpb pack . dist/sap-adt-hub.mcpb
```

## License

MIT. ARC-1 is a separate project by its authors under its own license.
