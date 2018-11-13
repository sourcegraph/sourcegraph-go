import * as sourcegraph from 'sourcegraph'
import { Location, Position, Range } from 'sourcegraph'
import * as rpc from 'vscode-jsonrpc'
import * as lsp from 'vscode-languageserver-protocol'
import * as wsrpc from 'vscode-ws-jsonrpc'

import { BehaviorSubject, combineLatest, EMPTY, from, of, Subject, Subscription, Unsubscribable } from 'rxjs'
import { distinct, distinctUntilChanged, map, shareReplay, switchMap, take } from 'rxjs/operators'
import { toSocket } from 'vscode-ws-jsonrpc'

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

export function activate(): void {
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
