⚠️ WIP Go extension ⚠️

This extension provides Go code intelligence in 2 ways:

- **LSP Proxy**: this extension literally `import`s [langserver-http](https://github.com/sourcegraph/sourcegraph-langserver-http) (deprecated)
- **Standalone [go-langserver](https://github.com/sourcegraph/go-langserver)**: connects over WebSockets

Currently, this extension **always use LSP proxy** (this is hard-coded in [./src/lang-go.ts](./src/lang-go.ts)).

Here's the plan for dropping the LSP Proxy way:

- Generate an access token and construct an authenticated `zipURL` that looks like `https://TOKEN@<host>/.../raw/` and pass it in the `initializaationOptions` through LSP Proxy to the Go buildserver
- Go buildserver will prefer to fetch the zip archive from the zip URL, falling back to gitserver if it's not in the `initializationOptions`zip archive
- Implement cross-repo code intelligence using search and existing code intelligence features (not sure what this will look like yet)
- Construct an authenticated zip URL from the token and pass it directly to the standalone go-langserver via `rootUri`
- Drop LSP Proxy once all customers have upgraded
