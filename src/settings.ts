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
     * registered.
     */
    'lang-go.externalReferences': boolean
    /**
     * Whether or not to use godoc.org's API to find packages that import a
     * given package (used in finding external references).
     */
    'lang-go.useGoDocDotOrg': boolean
}

export type Settings = Partial<FullSettings>
