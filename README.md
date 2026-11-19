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
| `adt_create_toc` | Create and release a Transport of Copies (see below) |
| `adt_guide` | Usage rules for Claude |

## Transport of Copies

`adt_create_toc {system, transport, target}` uses [`ZCL_RELEASE_TOC`](https://github.com/rafafreitas87/sap_abap_toc_automation)
and works in confirmed steps, each one returning the question Claude must ask:

1. **System** - confirm that `system` is the development system the user is working on (`systemConfirmed=true`).
2. **Objects** - if `ZCL_RELEASE_TOC` / its runner do not exist, ask whether to create them as local `$TMP` objects
   (`install=true`); the ABAP source is downloaded from the pinned commit of that repository. If they exist, continue.
3. **Plan** - transport text, tasks, objects and a target suggested from the user's ToC history.
4. **Run** (`confirm=true`) - sets the runner constants, activates, triggers, resets the constants and verifies
   `E070`/`E07T`/`E071`.

Trigger by release: SAP_BASIS 7.50 uses the ABAP Unit runner with risk level DANGEROUS, called directly on the ADT
`abapunit/testruns` endpoint (ARC-1 itself only runs harmless tests); the client must allow dangerous tests
(`SAUNIT_CLIENT_SETUP`). SAP_BASIS 7.52+ uses the console app `ZCL_RELEASE_TOC_RUN` (`/sap/bc/adt/oo/classrun`).
The tool uses its own ARC-1 instance limited to `$TMP` writes and read-only SQL, independent of the connection's
permissions.

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
