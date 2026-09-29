# Tether documentation

Try your first comment exchange with the [getting-started guide](getting-started.md). Tether runs locally on your Mac, so your agent needs access to the same files and CLI.

## Using Tether

- [Folio and sharing](guide/folio.md): organize documents, preserve conversations, and share reviews.
- [Host setup](guide/hosts.md): choose cmux, Wave, or a separate browser.
- [Agent setup](guide/agent-setup.md): install and maintain the optional review skill.
- [Installation and updates](guide/installation.md): package locations, updates, and uninstall.
- [Recovery and backups](guide/recovery.md): reconnect saved views and restore private data.

## Using the CLI

Use the [CLI reference](reference/cli.md) to review comments and work with files. For pagination, diagnostics, limits, and write guarantees, see [protocol details](reference/protocol.md). Run `tether <command> --help` for exact arguments.

## Contributing

Start with [CONTRIBUTING.md](../CONTRIBUTING.md) to run Tether from source and check your changes. The [architecture and code map](contributing/architecture.md) helps you find your way through the code; [package verification](contributing/packages.md) covers builds and installation checks. Agents working on a checkout should read [AGENTS.md](../AGENTS.md).

The [browser embedding contract](contributing/browser-embedding.md) describes host-supplied transport and return navigation, including the server authorization work required before remote embedding.
