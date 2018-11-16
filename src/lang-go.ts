import * as wsrpc from '@sourcegraph/vscode-ws-jsonrpc'
import * as sourcegraph from 'sourcegraph'
import { Location, Position, Range } from 'sourcegraph'
import * as rpc from 'vscode-jsonrpc'
import * as lsp from 'vscode-languageserver-protocol'
import * as convert from './convert-lsp-to-sea'

import {
    BehaviorSubject,
    combineLatest,
    EMPTY,
    from,
    Observable,
    Observer,
    of,
    Subject,
    Subscribable,
    Subscription,
    throwError,
    Unsubscribable,
} from 'rxjs'
import { distinct, distinctUntilChanged, map, share, shareReplay, switchMap, take } from 'rxjs/operators'
import * as langserverHTTP from 'sourcegraph-langserver-http/src/extension'

import gql from 'tagged-template-noop'

// The key in settings where this extension looks to find the access token for
// the current user.
const ACCESS_TOKEN_SETTING = 'go.accessToken'

/**
 * Returns a URL to Sourcegraph's raw API, given a repo, rev, and optional
 * token. When the token is not provided, the resulting URL will not be
 * authenticated.
 *
 * @param repoName looks like `github.com/gorilla/mux`
 * @param revision whatever Sourcegraph's raw API supports (40 char hash,
 * `master`, etc.)
 * @param token an authentication token for the current user
 */
function constructZipURL({
    repoName,
    revision,
    token,
}: {
    repoName: string
    revision: string
    token: string | undefined
}): string {
    const zipURL = new URL(sourcegraph.internal.sourcegraphURL.toString())
    zipURL.pathname = repoName + '@' + revision + '/-/raw'
    if (token) {
        zipURL.username = token
    }
    return zipURL.href
}

async function queryGraphQL(query: string, variables: any = {}): Promise<any> {
    const { data, errors } = await sourcegraph.commands.executeCommand('queryGraphQL', query, variables)
    if (errors) {
        throw Object.assign(new Error(errors.map((err: any) => err.message).join('\n')), { errors })
    }
    return data
}

// Undefined means the current user is anonymous.
let accessTokenPromise: Promise<string | undefined>
export async function getOrTryToCreateAccessToken(): Promise<string | undefined> {
    const accessToken = sourcegraph.configuration.get().get(ACCESS_TOKEN_SETTING) as string | undefined
    if (accessToken) {
        return accessToken
    }
    if (accessTokenPromise) {
        return await accessTokenPromise
    }
    accessTokenPromise = tryToCreateAccessToken()
    return await accessTokenPromise
}

async function tryToCreateAccessToken(): Promise<string | undefined> {
    const { currentUser } = await queryGraphQL(gql`
        query {
            currentUser {
                id
            }
        }
    `)
    if (!currentUser) {
        return undefined
    } else {
        const currentUserId: string = currentUser.id
        const result = await queryGraphQL(
            gql`
                mutation CreateAccessToken($user: ID!, $scopes: [String!]!, $note: String!) {
                    createAccessToken(user: $user, scopes: $scopes, note: $note) {
                        id
                        token
                    }
                }
            `,
            { user: currentUserId, scopes: ['user:all'], note: 'lang-go' }
        )
        const token: string = result.createAccessToken.token
        await sourcegraph.configuration.get().update(ACCESS_TOKEN_SETTING, token)
        return token
    }
}

const LANGSERVER_ADDRESS_SETTING = 'lang-go.address'

interface FullSettings {
    'lang-go.address': string
}

type Settings = Partial<FullSettings>

function connectTo(address: string): Promise<rpc.MessageConnection> {
    return new Promise(resolve => {
        const webSocket = new WebSocket(address)
        const conn = rpc.createMessageConnection(
            new wsrpc.WebSocketMessageReader(wsrpc.toSocket(webSocket)),
            new wsrpc.WebSocketMessageWriter(wsrpc.toSocket(webSocket))
        )
        webSocket.addEventListener('open', () => resolve(conn))
    })
}

export function activateUsingWebSockets(): void {
    const lsaddress: BehaviorSubject<string | undefined> = new BehaviorSubject<string | undefined>(undefined)
    sourcegraph.configuration.subscribe(() => {
        lsaddress.next(sourcegraph.configuration.get<Settings>().get('lang-go.address'))
    })

    type SendType = (doc: sourcegraph.TextDocument, requestType: any, request: any) => Promise<lsp.Hover>
    function mkSendRequest(address: string): Observable<SendType> {
        function rootURIFromDoc(doc: sourcegraph.TextDocument): URL {
            const url = new URL(doc.uri)
            url.hash = ''
            return url
        }
        const rootURIToConnection: { [rootURI: string]: Promise<rpc.MessageConnection> } = {}
        function connectionFor(root: URL): Promise<rpc.MessageConnection> {
            if (rootURIToConnection[root.href]) {
                return rootURIToConnection[root.href]
            } else {
                rootURIToConnection[root.href] = connectTo(address).then(async (connection: rpc.MessageConnection) => {
                    connection.listen()

                    const zipURL = constructZipURL({
                        repoName: root.pathname.replace(/^\/+/, ''),
                        revision: root.search.substr(1),
                        token: await getOrTryToCreateAccessToken(),
                    })

                    await connection.sendRequest(
                        new lsp.RequestType<
                            lsp.InitializeParams & {
                                originalRootUri: string
                                rootPath: string
                            },
                            lsp.InitializeResult,
                            lsp.InitializeError,
                            void
                        >('initialize') as any,
                        {
                            originalRootUri: root.href,
                            rootUri: 'file:///',
                            rootPath: '/',
                            initializationOptions: { zipURL },
                        }
                    )
                    connection.sendNotification(lsp.InitializedNotification.type)
                    return connection
                })
            }
            return rootURIToConnection[root.href]
        }
        const send: SendType = async (doc, requestType, request) => {
            try {
                return (await (await connectionFor(rootURIFromDoc(doc))).sendRequest(requestType, request)) as lsp.Hover
            } catch (e) {
                return {
                    contents: { value: e },
                } as lsp.Hover
            }
        }

        return Observable.create((observer: Observer<SendType>) => {
            observer.next(send)
            observer.complete()
            return () => {
                for (const rootHref in Object.keys(rootURIToConnection)) {
                    if (rootURIToConnection[rootHref]) {
                        rootURIToConnection[rootHref].then(connection => connection.dispose())
                        delete rootURIToConnection[rootHref]
                    }
                }
            }
        })
    }
    const NO_ADDRESS_ERROR = `To get Go code intelligence, add "${LANGSERVER_ADDRESS_SETTING}": "wss://example.com" to your settings.`
    const NO_CONNECTION_ERROR =
        'Not yet connected to the Go language server. Check the devtools console for connection errors and make sure the langserver is running.'
    const send = lsaddress.pipe(
        switchMap(address => (address ? mkSendRequest(address) : of(undefined))),
        shareReplay(1)
    )

    function sendRequest(doc: sourcegraph.TextDocument, requestType: any, request: any): Promise<lsp.Hover> {
        return send
            .pipe(
                take(1),
                switchMap(send => (send ? send(doc, requestType, request) : throwError(NO_ADDRESS_ERROR)))
            )
            .toPromise()
    }

    sourcegraph.languages.registerHoverProvider([{ pattern: '*.go' }], {
        provideHover: async (doc, pos) =>
            sendRequest(doc, lsp.HoverRequest.type, {
                textDocument: {
                    uri: `file:///${new URL(doc.uri).hash.slice(1)}`,
                },
                position: {
                    line: pos.line,
                    character: pos.character,
                },
            })
                .then(resp => convert.hover(resp))
                .catch(e => ({ contents: { value: e } })),
    })

    // sourcegraph.languages.registerDefinitionProvider([{ pattern: '*.go' }], {
    //     provideDefinition: async (doc, pos) =>
    //         lsConnection
    //             .pipe(
    //                 switchMap(async conn => {
    //                     if (!conn) {
    //                         return null
    //                     } else {
    //                         return lspToSEA.definition({
    //                             currentDocURI: doc.uri,
    //                             definition: await conn.sendRequest(lsp.DefinitionRequest.type, {
    //                                 textDocument: {
    //                                     uri: `file:///${new URL(doc.uri).hash.slice(1)}`,
    //                                 },
    //                                 position: {
    //                                     line: pos.line,
    //                                     character: pos.character,
    //                                 },
    //                             }),
    //                         })
    //                     }
    //                 })
    //             )
    //             .toPromise(),
    // })

    // sourcegraph.languages.registerReferenceProvider([{ pattern: '*.go' }], {
    //     provideReferences: async (doc, pos) =>
    //         lsConnection
    //             .pipe(
    //                 switchMap(async conn => {
    //                     if (!conn) {
    //                         return null
    //                     } else {
    //                         return lspToSEA.references({
    //                             currentDocURI: doc.uri,
    //                             references: await conn.sendRequest(lsp.ReferencesRequest.type, {
    //                                 textDocument: {
    //                                     uri: `file:///${new URL(doc.uri).hash.slice(1)}`,
    //                                 },
    //                                 position: {
    //                                     line: pos.line,
    //                                     character: pos.character,
    //                                 },
    //                             }),
    //                         })
    //                     }
    //                 })
    //             )
    //             .toPromise(),
    // })

    // sourcegraph.languages.registerImplementationProvider([{ pattern: '*.go' }], {
    //     provideImplementation: async (doc, pos) =>
    //         lsConnection
    //             .pipe(
    //                 switchMap(async conn => {
    //                     if (!conn) {
    //                         return null
    //                     } else {
    //                         return lspToSEA.definition({
    //                             currentDocURI: doc.uri,
    //                             definition: await conn.sendRequest(lsp.ImplementationRequest.type, {
    //                                 textDocument: {
    //                                     uri: `file:///${new URL(doc.uri).hash.slice(1)}`,
    //                                 },
    //                                 position: {
    //                                     line: pos.line,
    //                                     character: pos.character,
    //                                 },
    //                             }),
    //                         })
    //                     }
    //                 })
    //             )
    //             .toPromise(),
    // })

    function afterActivate(): void {
        const address = sourcegraph.configuration.get<Settings>().get('lang-go.address')
        if (!address) {
            console.warn('No lang-go.address is set, so Go code intelligence will not work.')
            return
        }
    }
    // Error creating extension host: Error: Configuration is not yet available.
    // `sourcegraph.configuration.get` is not usable until after the extension
    // `activate` function is finished executing. This is a known issue and will
    // be fixed before the beta release of Sourcegraph extensions. In the
    // meantime, work around this limitation by deferring calls to `get`.
    setTimeout(afterActivate, 0)
}

export function activateUsingLSPProxy(): void {
    activateUsingLSPProxyAsync()
}

async function activateUsingLSPProxyAsync(): Promise<void> {
    langserverHTTP.activateWith({
        provideLSPResults: async (method, doc, pos) => {
            const docURL = new URL(doc.uri)
            const zipURL = constructZipURL({
                repoName: docURL.pathname.replace(/^\/+/, ''),
                revision: docURL.search.substr(1),
                token: await getOrTryToCreateAccessToken(),
            })
            return langserverHTTP.provideLSPResults(method, doc, pos, { zipURL })
        },
    })
}

export function activate(): void {
    function afterActivate(): void {
        // TODO choose which implementation to use based on config so that we can
        // switch back and forth for testing.
        const newLanguageServer = true
        if (newLanguageServer) {
            activateUsingWebSockets()
        } else {
            // We can remove the LSP proxy implementation once all customers with Go
            // code intelligence have spun up their own language server (post
            // Sourcegraph 3).
            activateUsingLSPProxy()
        }
    }
    setTimeout(afterActivate, 0)
}
