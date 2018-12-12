export interface FullSettings {
    /**
     * The address to the Go language server listening for WebSocket connections.
     */
    'go.serverUrl': string
    /**
     * The key in settings where this extension looks to find the access token
     * for the current user.
     */
    'go.accessToken': string
    /**
     * Whether or not to return external references (from other repositories)
     * along with local references.
     */
    'go.showExternalReferences': boolean
    /**
     * The maximum number of repositories to look in when searching for external
     * references for a symbol (defaults to 50).
     */
    'go.maxExternalReferenceRepos': number
    /**
     * When set, will cause this extension to use to use gddo's (Go Doc Dot Org) API
     * (https://github.com/golang/gddo) to find packages that import a given
     * package (used in finding external references). This cannot be set to
     * `https://godoc.org` because gddo does not set CORS headers. You'll
     * need a proxy to get around this.
     */
    'go.gddoURL': string
    /**
     * The URL of the Sourcegraph instance from the perspective of the Go
     * language server. This is useful for development when Sourcegraph is
     * running on localhost and the Go language server is running in a Docker
     * container. When developing on macOS, set this to
     * 'http://host.docker.internal:3080'. See
     * https://stackoverflow.com/a/43541681/2061958
     */
    'go.sourcegraphUrl': string
}

export type Settings = Partial<FullSettings>
