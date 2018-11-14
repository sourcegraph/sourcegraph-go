import * as sourcegraph from 'sourcegraph'
import { Location, Position, Range } from 'sourcegraph'
import * as rpc from 'vscode-jsonrpc'
import * as lsp from 'vscode-languageserver-protocol'
import * as wsrpc from 'vscode-ws-jsonrpc'

import { BehaviorSubject, combineLatest, EMPTY, from, of, Subject, Subscription, Unsubscribable } from 'rxjs'
import { distinct, distinctUntilChanged, map, shareReplay, switchMap, take } from 'rxjs/operators'
import * as langserverHTTP from 'sourcegraph-langserver-http/src/extension'
import { toSocket } from 'vscode-ws-jsonrpc'

import gql from 'tagged-template-noop'

const ACCESS_TOKEN_SETTING = 'go.accessToken'

function addAuthToURL(url: string, token: string): string {
    const authedURL = new URL(url)
    authedURL.username = token
    return authedURL.href
}

function constructZipURL({ repoName, revision, token }: { repoName: string; revision: string; token: string }): string {
    const zipURL = new URL(sourcegraph.internal.sourcegraphURL.toString())
    zipURL.pathname = repoName + '@' + revision + '/-/raw'
    zipURL.username = token
    return zipURL.href
}

async function queryGraphQL(query: string, variables: any = {}): Promise<any> {
    const { data, errors } = await sourcegraph.commands.executeCommand('queryGraphQL', query, variables)
    if (errors) {
        throw Object.assign(new Error(errors.map((err: any) => err.message).join('\n')), { errors })
    }
    return data
}

let accessTokenPromise: Promise<string>
export async function getOrCreateAccessToken(): Promise<string> {
    const accessToken = sourcegraph.configuration.get().get(ACCESS_TOKEN_SETTING) as string | undefined
    if (accessToken) {
        return accessToken
    }
    if (accessTokenPromise) {
        return await accessTokenPromise
    }
    accessTokenPromise = createAccessToken()
    return await accessTokenPromise
}

async function createAccessToken(): Promise<string> {
    const { currentUser } = await queryGraphQL(gql`
        query {
            currentUser {
                id
            }
        }
    `)
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

interface FullSettings {
    'go.langserver-address': string
}

type Settings = Partial<FullSettings>

function connectTo(address: string): Promise<rpc.MessageConnection> {
    return new Promise(resolve => {
        const webSocket = new WebSocket(address)
        const conn = rpc.createMessageConnection(
            new wsrpc.WebSocketMessageReader(toSocket(webSocket)),
            new wsrpc.WebSocketMessageWriter(toSocket(webSocket))
        )
        webSocket.addEventListener('open', () => resolve(conn))
    })
}

const lspToSEA = {
    location: ({
        currentDocURI,
        location: { range, uri: uriFromLangServer },
    }: {
        currentDocURI: string
        location: lsp.Location
    }): Location => {
        let definitionURI: sourcegraph.URI
        if (/^file:\/\/\//.test(uriFromLangServer)) {
            // The definition is in a file in the same repo
            const docURL = new URL(currentDocURI)
            docURL.hash = uriFromLangServer.slice('file:///'.length)
            definitionURI = new sourcegraph.URI(docURL.href)
        } else {
            definitionURI = new sourcegraph.URI(uriFromLangServer)
        }

        return new Location(
            definitionURI,
            range &&
                new Range(
                    new Position(range.start.line, range.start.character),
                    new Position(range.end.line, range.end.character)
                )
        )
    },
    definition: ({
        currentDocURI,
        definition,
    }: {
        currentDocURI: string
        definition: lsp.Definition
    }): sourcegraph.Definition => {
        if (!definition) {
            return null
        }

        if (Array.isArray(definition)) {
            return definition.map(location => lspToSEA.location({ currentDocURI, location }))
        } else {
            const location = definition
            return lspToSEA.location({
                currentDocURI,
                location,
            })
        }
    },
    references: ({
        currentDocURI,
        references,
    }: {
        currentDocURI: string
        references: lsp.Location[] | null
    }): Location[] => {
        if (!references) {
            return []
        }

        return references.map(location => lspToSEA.location({ currentDocURI, location }))
    },
    hover: (hover: lsp.Hover | null) => {
        if (!hover) {
            return null
        }

        return {
            contents: { value: '' },
            __backcompatContents: hover.contents,
        } as sourcegraph.Hover
    },
}

export function activateUsingWebSockets(): void {
    const lsaddress: BehaviorSubject<string | undefined> = new BehaviorSubject<string | undefined>(undefined)
    sourcegraph.configuration.subscribe(() => {
        lsaddress.next(sourcegraph.configuration.get<Settings>().get('go.langserver-address'))
    })
    const docSubject = new BehaviorSubject<URL | undefined>(undefined)
    sourcegraph.workspace.onDidOpenTextDocument.subscribe(doc => {
        docSubject.next(new URL(doc.uri))
    })

    const lsConnection = combineLatest(lsaddress, docSubject).pipe(
        take(1),
        switchMap(([address, docDoNotMutate]) =>
            address && docDoNotMutate
                ? from(
                      connectTo(address).then(async (connection: rpc.MessageConnection) => {
                          connection.listen()

                          const doc = new URL(docDoNotMutate.href)
                          doc.hash = ''

                          // TODO put the InitializeParams with originalRootUri type somewhere
                          // like sourcegraph-extension-api or sourcegraph-langserver-js
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
                                  originalRootUri: doc.href,
                                  rootUri: 'file:///',
                                  rootPath: '/',
                              }
                          )
                          connection.sendNotification(lsp.InitializedNotification.type)
                          return connection
                      })
                  )
                : of(undefined)
        ),
        shareReplay(1)
    )

    sourcegraph.languages.registerHoverProvider([{ pattern: '*.go' }], {
        provideHover: async (doc, pos) =>
            lsConnection
                .pipe(
                    switchMap(async conn => {
                        if (!conn) {
                            return {
                                contents: {
                                    value:
                                        'Not yet connected to the Go language server. Check the devtools console for connection errors and make sure the langserver is running.',
                                    kind: sourcegraph.MarkupKind.Markdown,
                                },
                            }
                        } else {
                            return lspToSEA.hover(
                                await conn.sendRequest(lsp.HoverRequest.type, {
                                    textDocument: {
                                        uri: `file:///${new URL(doc.uri).hash.slice(1)}`,
                                    },
                                    position: {
                                        line: pos.line,
                                        character: pos.character,
                                    },
                                })
                            )
                        }
                    })
                )
                .toPromise(),
    })

    sourcegraph.languages.registerDefinitionProvider([{ pattern: '*.go' }], {
        provideDefinition: async (doc, pos) =>
            lsConnection
                .pipe(
                    switchMap(async conn => {
                        if (!conn) {
                            return null
                        } else {
                            return lspToSEA.definition({
                                currentDocURI: doc.uri,
                                definition: await conn.sendRequest(lsp.DefinitionRequest.type, {
                                    textDocument: {
                                        uri: `file:///${new URL(doc.uri).hash.slice(1)}`,
                                    },
                                    position: {
                                        line: pos.line,
                                        character: pos.character,
                                    },
                                }),
                            })
                        }
                    })
                )
                .toPromise(),
    })

    sourcegraph.languages.registerReferenceProvider([{ pattern: '*.go' }], {
        provideReferences: async (doc, pos) =>
            lsConnection
                .pipe(
                    switchMap(async conn => {
                        if (!conn) {
                            return null
                        } else {
                            return lspToSEA.references({
                                currentDocURI: doc.uri,
                                references: await conn.sendRequest(lsp.ReferencesRequest.type, {
                                    textDocument: {
                                        uri: `file:///${new URL(doc.uri).hash.slice(1)}`,
                                    },
                                    position: {
                                        line: pos.line,
                                        character: pos.character,
                                    },
                                }),
                            })
                        }
                    })
                )
                .toPromise(),
    })

    sourcegraph.languages.registerImplementationProvider([{ pattern: '*.go' }], {
        provideImplementation: async (doc, pos) =>
            lsConnection
                .pipe(
                    switchMap(async conn => {
                        if (!conn) {
                            return null
                        } else {
                            return lspToSEA.definition({
                                currentDocURI: doc.uri,
                                definition: await conn.sendRequest(lsp.ImplementationRequest.type, {
                                    textDocument: {
                                        uri: `file:///${new URL(doc.uri).hash.slice(1)}`,
                                    },
                                    position: {
                                        line: pos.line,
                                        character: pos.character,
                                    },
                                }),
                            })
                        }
                    })
                )
                .toPromise(),
    })

    function afterActivate(): void {
        const address = sourcegraph.configuration.get<Settings>().get('go.langserver-address')
        if (!address) {
            console.warn('No go.langserver-address is set, so Go code intelligence will not work.')
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
                token: await getOrCreateAccessToken(),
            })
            return langserverHTTP.provideLSPResults(method, doc, pos, { zipURL })
        },
    })
}

export function activate(): void {
    function afterActivate(): void {
        // TODO choose which implementation to use based on config so that we can
        // switch back and forth for testing.
        const newLanguageServer = false
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
