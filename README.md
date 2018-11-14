⚠️ WIP Go extension ⚠️

This extension provides Go code intelligence in 2 ways:

- **LSP Proxy**: this extension literally `import`s [langserver-http](https://github.com/sourcegraph/sourcegraph-langserver-http) (deprecated)
- **Standalone [go-langserver](https://github.com/sourcegraph/go-langserver)**: connects over WebSockets

Currently, this extension **always use LSP proxy** (this is hard-coded in [./src/lang-go.ts](./src/lang-go.ts)).

Here's the plan for dropping the LSP Proxy way:

- Generate an access token and pass it in the `initializaationOptions` to LSP Proxy
  - Sourcegraph 2: no-op
  - Sourcegraph 3: when the token is present, translate the `rootUri` from `git://` to `https://TOKEN@frontend/.../raw/`, and `xlang-go` will fetch that zip archive
- Implement cross-repo code intelligence using search and existing code intelligence features (not sure what this will look like yet)
- Construct an authenticated zip URL from the token and pass it directly to the standalone go-langserver via `rootUri`
- Drop LSP Proxy once all customers have upgraded
