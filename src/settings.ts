export interface FullSettings {
    /**
     * The address to the Go language server listening for WebSocket connections.
     */
    'lang-go.address': string
    /**
     * The key in settings where this extension looks to find the access token
     * for the current user.
     */
    'lang-go.accessToken': string
    /**
     * Whether or not a second references provider for external references will be
     * registered (defaults to false).
     */
    'lang-go.externalReferences': boolean
    /**
     * The maximum number of repositories to look in when searching for external
     * references for a symbol (defaults to 50).
     */
    'lang-go.maxExternalReferenceRepos': number
}

export type Settings = Partial<FullSettings>
