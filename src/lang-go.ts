import * as wsrpc from '@sourcegraph/vscode-ws-jsonrpc'
import LRUCache from 'lru-cache'
import { ajax } from 'rxjs/ajax'
import * as sourcegraph from 'sourcegraph'
import { Location, Position, Range } from 'sourcegraph'
import * as rpc from 'vscode-jsonrpc'
import * as lsp from 'vscode-languageserver-protocol'
import * as convert from './convert-lsp-to-sea'
import * as lspext from './lspext'

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
import {
    concat,
    concatMap,
    delay,
    distinct,
    distinctUntilChanged,
    flatMap,
    map,
    mergeMap,
    scan,
    share,
    shareReplay,
    switchMap,
    take,
    toArray,
    finalize,
} from 'rxjs/operators'
import * as langserverHTTP from 'sourcegraph-langserver-http/src/extension'

import { ConsoleLogger, createWebSocketConnection } from '@sourcegraph/vscode-ws-jsonrpc'
import gql from 'tagged-template-noop'
import { Settings } from './settings'

// If we can rid ourselves of file:// URIs, this type won't be necessary and we
// can use lspext.Xreference directly.
type XRef = lspext.Xreference & { currentDocURI: string }

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
    // URL.pathname is different on Chrome vs Safari, so don't rely on it. Instead, constr
    return (
        zipURL.protocol + '//' + (token ? token + '@' : '') + zipURL.host + '/' + repoName + '@' + revision + '/-/raw'
    )
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
    const accessToken = sourcegraph.configuration.get<Settings>().get('go.accessToken') as string | undefined
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
            { user: currentUserId, scopes: ['user:all'], note: 'go' }
        )
        const token: string = result.createAccessToken.token
        await sourcegraph.configuration.get<Settings>().update('go.accessToken', token)
        return token
    }
}

async function connectAndInitialize(address: string, root: URL): Promise<rpc.MessageConnection> {
    const connection = (await new Promise((resolve, reject) => {
        const webSocket = new WebSocket(address)
        const conn = createWebSocketConnection(wsrpc.toSocket(webSocket), new ConsoleLogger())
        webSocket.addEventListener('open', () => resolve(conn))
        webSocket.addEventListener('error', reject)
    })) as rpc.MessageConnection

    connection.listen()

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
            initializationOptions: {
                zipURL: constructZipURL({
                    repoName: pathname(root.href).replace(/^\/+/, ''),
                    revision: root.search.substr(1),
                    token: await getOrTryToCreateAccessToken(),
                }),
            },
        }
    )

    connection.sendNotification(lsp.InitializedNotification.type)

    return connection
}

interface SendRequestParams {
    rootURI: URL
    requestType: any
    request: any
    useCache: boolean
}

type SendRequest = (params: SendRequestParams) => Promise<any>

function rootURIFromDoc(doc: sourcegraph.TextDocument): URL {
    const url = new URL(doc.uri)
    url.hash = ''
    return url
}

/**
 * Creates a function of type SendRequest that can be used to send LSP
 * requests to the corresponding language server. This returns an Observable
 * so that all the connections to that language server can be disposed of
 * when calling .unsubscribe().
 *
 * Internally, this maintains a mapping from rootURI to the connection
 * associated with that rootURI, so it supports multiple roots (untested).
 */
function mkSendRequest(address: string): Observable<SendRequest> {
    const rootURIToConnection: { [rootURI: string]: Promise<rpc.MessageConnection> } = {}
    function connectionFor(root: URL): Promise<rpc.MessageConnection> {
        if (rootURIToConnection[root.href]) {
            return rootURIToConnection[root.href]
        } else {
            rootURIToConnection[root.href] = connectAndInitialize(address, root)
            rootURIToConnection[root.href].then(connection => {
                connection.onDispose(() => {
                    delete rootURIToConnection[root.href]
                })
                connection.onClose(() => {
                    delete rootURIToConnection[root.href]
                })
            })
            return rootURIToConnection[root.href]
        }
    }

    const sendRequest: SendRequest = async ({ rootURI, requestType, request, useCache }) => {
        if (useCache) {
            return await (await connectionFor(rootURI)).sendRequest(requestType, request)
        } else {
            const connection = await connectAndInitialize(address, rootURI)
            const response = await connection.sendRequest(requestType, request)
            connection.dispose()
            return response
        }
    }

    return Observable.create((observer: Observer<SendRequest>) => {
        observer.next(sendRequest)
        return () => {
            for (const rootURI of Object.keys(rootURIToConnection)) {
                if (rootURIToConnection[rootURI]) {
                    rootURIToConnection[rootURI].then(connection => connection.dispose())
                    delete rootURIToConnection[rootURI]
                }
            }
        }
    })
}

interface FileMatch {
    repository: {
        name: string
    }
}

interface SearchResponse {
    search: {
        results: {
            results: FileMatch[]
        }
    }
    errors: string[]
}

interface GDDOImportersResponse {
    results: { path: string }[]
}

async function repositoriesThatImportViaGDDO(gddoURL: string, importPath: string, limit: number): Promise<Set<string>> {
    const importersURL = new URL(gddoURL)
    importersURL.pathname = 'importers/' + importPath
    const response = (await ajax({ url: importersURL.href, responseType: 'json' }).toPromise())
        .response as GDDOImportersResponse
    if (!response || !response.results || !Array.isArray(response.results)) {
        throw new Error('Invalid response from godoc.org:' + response)
    } else {
        const repoNames: string[] = (await Promise.all(
            response.results
                .map(result => result.path)
                .filter(repo =>
                    // This helps filter out repos that do not exist on the Sourcegraph.com instance
                    repo.startsWith('github.com/')
                )
                .slice(0, limit)
                .map(async repo => {
                    const gqlResponse = await queryGraphQL(
                        `
                        query($cloneURL: String!) {
                            repository(cloneURL: $cloneURL) {
                                name
                            }
                        }
                    `,
                        { cloneURL: repo }
                    )
                    if (!gqlResponse || !gqlResponse.repository || !gqlResponse.repository.name) {
                        // We only know how to construct zip URLs for fetching repos
                        // on Sourcegraph instances. Since this candidate repo is absent from
                        // the Sourcegraph instance, discard it.
                        return undefined
                    }
                    return gqlResponse.repository.name as string
                })
        )).filter((repo): repo is string => !!repo)
        return new Set(
            repoNames.map(name => {
                function modifyComponents(f: (components: string[]) => string[], path: string): string {
                    return f(path.split('/')).join('/')
                }
                // Converts import paths to repositories by stripping everything
                // after the third path component. This is not very accurate,
                // and breaks when the repository is not a prefix of the import
                // path.
                return modifyComponents(components => components.slice(0, 3), name)
            })
        )
    }
}

/**
 * Returns an array of repositories that import the given import path.
 */
async function repositoriesThatImportViaSearch(importPath: string, limit: number): Promise<Set<string>> {
    const query = `\t"${importPath}"`
    const data = (await queryGraphQL(
        `
query FindDependents($query: String!) {
  search(query: $query) {
    results {
      results {
        ... on FileMatch {
          repository {
            name
          }
        }
      }
    }
  }
}
	`,
        { query }
    )) as SearchResponse
    if (
        !data ||
        !data.search ||
        !data.search.results ||
        !data.search.results.results ||
        !Array.isArray(data.search.results.results)
    ) {
        throw new Error('No search results - this should not happen.')
    }
    return new Set(
        data.search.results.results
            .filter(r => r.repository)
            .map(r => r.repository.name)
            .slice(0, limit)
    )
}

/**
 * Finds external references to the symbol at the given position in a 3 step
 * process:
 *
 * - Call xdefinition to get the symbol name and package
 * - Run a search for files that import the symbol's package, and aggregate the
 *   set of matching repositories
 * - Loop through each repository, create a new connection to the language
 *   server, and call xreferences
 */
function xrefs({
    doc,
    pos,
    sendRequest,
}: {
    doc: sourcegraph.TextDocument
    pos: sourcegraph.Position
    sendRequest: SendRequest
}): Observable<lspext.Xreference & { currentDocURI: string }> {
    const candidates = (async () => {
        const definitions = (await sendRequest({
            rootURI: rootURIFromDoc(doc),
            requestType: new lsp.RequestType<any, any, any, void>('textDocument/xdefinition') as any,
            request: positionParams(doc, pos),
            useCache: true,
        })) as lspext.Xdefinition[] | null
        if (!definitions) {
            console.error('No response to xdefinition')
            return Promise.reject()
        }
        if (definitions.length === 0) {
            console.error('No definitions')
            return Promise.reject()
        }
        const definition = definitions[0]
        const limit = sourcegraph.configuration.get<Settings>().get('go.maxExternalReferenceRepos') || 20
        const gddoURL = sourcegraph.configuration.get<Settings>().get('go.gddoURL')
        const repositoriesThatImport = gddoURL
            ? (importPath: string, limit: number) => repositoriesThatImportViaGDDO(gddoURL, importPath, limit)
            : repositoriesThatImportViaSearch
        const repos = new Set(Array.from(await repositoriesThatImport(definition.symbol.package, limit)))
        // Assumes the import path is the same as the repo name - not always true!
        repos.delete(definition.symbol.package)
        return Array.from(repos).map(repo => ({ repo, definition }))
    })()

    return from(candidates).pipe(
        concatMap(candidates => candidates),
        mergeMap(
            async ({ repo, definition }) => {
                // Assumes master is the default branch - not always valid!
                const rootURI = new URL(`git://${repo}?master`)
                // This creates a new connection and immediately disposes it because
                // each xreferences request here has a different rootURI (enforced
                // by `new Set` above), rendering caching useless.
                const response = (await sendRequest({
                    rootURI,
                    requestType: new lsp.RequestType<any, any, any, void>('workspace/xreferences') as any,
                    request: {
                        query: definition.symbol,
                        limit: 20,
                    } as { query: lspext.LSPSymbol; limit: number },
                    useCache: false,
                })) as lspext.Xreference[]

                return (response || []).map(ref => ({ ...ref, currentDocURI: rootURI.href }))
            },
            undefined,
            10 // 10 concurrent connections
        ),
        concatMap(references => references)
    )
}

function positionParams(doc: sourcegraph.TextDocument, pos: sourcegraph.Position): lsp.TextDocumentPositionParams {
    return {
        textDocument: {
            uri: `file:///${new URL(doc.uri).hash.slice(1)}`,
        },
        position: {
            line: pos.line,
            character: pos.character,
        },
    }
}

/**
 * Uses WebSockets to communicate with a language server.
 */
export function activateUsingWebSockets(): void {
    const settings: BehaviorSubject<Settings> = new BehaviorSubject<Settings>({})
    sourcegraph.configuration.subscribe(() => {
        settings.next(sourcegraph.configuration.get<Settings>().value)
    })
    const langserverAddress = settings.pipe(map(settings => settings['go.serverUrl']))

    const NO_ADDRESS_ERROR = `To get Go code intelligence, add "${'go.address' as keyof Settings}": "wss://example.com" to your settings.`

    const sendRequestObservable = langserverAddress.pipe(
        switchMap(address => (address ? mkSendRequest(address) : of(undefined))),
        shareReplay(1)
    )

    function sendRequest(params: SendRequestParams): Promise<any> {
        return sendRequestObservable
            .pipe(
                take(1),
                switchMap(send => (send ? send(params) : throwError(NO_ADDRESS_ERROR)))
            )
            .toPromise()
    }

    // TODO When go.langserver-address is set to an invalid address
    // and this extension fails to connect, the hover spinner hangs
    // indefinitely. @felix, could you take a look? I'm guessing the
    // error is not getting propagated, but despite 30 minutes of
    // debugging I can't figure out why.
    const sendDocPositionRequest = ({
        doc,
        pos,
        ty,
        useCache,
    }: {
        doc: sourcegraph.TextDocument
        pos: sourcegraph.Position
        ty: any
        useCache: boolean
    }): Promise<any> =>
        sendRequest({
            rootURI: rootURIFromDoc(doc),
            requestType: ty,
            request: positionParams(doc, pos),
            useCache,
        })

    sourcegraph.languages.registerHoverProvider([{ pattern: '*.go' }], {
        provideHover: async (doc, pos) => {
            const response = await sendDocPositionRequest({ doc, pos, ty: lsp.HoverRequest.type, useCache: true })
            return convert.hover(response)
        },
    })

    sourcegraph.languages.registerDefinitionProvider([{ pattern: '*.go' }], {
        provideDefinition: async (doc, pos) => {
            const response = await sendDocPositionRequest({
                doc,
                pos,
                ty: new lsp.RequestType<any, any, any, void>('textDocument/xdefinition') as any,
                useCache: true,
            })
            return convert.xdefinition({ currentDocURI: doc.uri, xdefinition: response })
        },
    })

    sourcegraph.languages.registerReferenceProvider([{ pattern: '*.go' }], {
        provideReferences: async (doc, pos) => {
            const response = await sendDocPositionRequest({ doc, pos, ty: lsp.ReferencesRequest.type, useCache: true })
            return convert.references({ currentDocURI: doc.uri, references: response })
        },
    })

    // Automatically registers/deregisters a provider based on some setting.
    function registerWhile({
        register,
        p,
    }: {
        register: () => sourcegraph.Unsubscribable
        p: (settings: Settings) => boolean
    }): sourcegraph.Unsubscribable {
        let registration: sourcegraph.Unsubscribable | undefined
        return from(settings)
            .pipe(
                map(p),
                map(enabled => {
                    console.log('registerWhile enabled', enabled)
                    if (enabled) {
                        registration = register()
                    } else {
                        if (registration) {
                            registration.unsubscribe()
                            registration = undefined
                        } else {
                            console.debug('Not unsubscribing provider: no registration found.')
                        }
                    }
                }),
                finalize(() => {
                    if (registration) {
                        registration.unsubscribe()
                        registration = undefined
                    }
                })
            )
            .subscribe()
    }

    registerWhile({
        register: () =>
            sourcegraph.languages.registerReferenceProvider([{ pattern: '*.go' }], {
                provideReferences: (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) =>
                    xrefs({ doc, pos, sendRequest }).pipe(
                        scan((acc: XRef[], curr: XRef) => [...acc, curr], [] as XRef[]),
                        map(response => convert.xreferences({ references: response }))
                    ),
            }),
        p: settings => Boolean(settings['go.showExternalReferences']),
    })

    // TODO implement streaming external references in the Sourcegraph extension
    // API then uncomment this.
    // sourcegraph.languages.registerExternalReferenceProvider([{ pattern: '*.go' }], {
    //     provideExternalReferences: (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) =>
    //         xrefs({ doc, pos, sendRequest }).pipe(map(response => convert.xreferences({ references: response }))),
    // })

    sourcegraph.languages.registerImplementationProvider([{ pattern: '*.go' }], {
        provideImplementation: async (doc, pos) => {
            const response = await sendDocPositionRequest({
                doc,
                pos,
                ty: lsp.ImplementationRequest.type,
                useCache: true,
            })
            return convert.references({ currentDocURI: doc.uri, references: response })
        },
    })
}

function pathname(url: string): string {
    let pathname = url
    pathname = pathname.slice('git://'.length)
    pathname = pathname.slice(0, pathname.indexOf('?'))
    return pathname
}

export function activateUsingLSPProxy(): void {
    langserverHTTP.activateWith({
        provideLSPResults: async (method, doc, pos) => {
            const docURL = new URL(doc.uri)
            const zipURL = constructZipURL({
                repoName: pathname(docURL.href).replace(/^\/+/, ''),
                revision: docURL.search.substr(1),
                token: await getOrTryToCreateAccessToken(),
            })
            return langserverHTTP.provideLSPResults(method, doc, pos, { zipURL })
        },
    })
}

export function activate(): void {
    function afterActivate(): void {
        const address = sourcegraph.configuration.get<Settings>().get('go.serverUrl')
        if (address) {
            console.log('Detected langserver address', address, 'using WebSockets to communicate with it.')
            activateUsingWebSockets()
        } else {
            // We can remove the LSP proxy implementation once all customers
            // with Go code intelligence have spun up their own language server
            // (post Sourcegraph 3).
            console.log(
                `Did not detect a langserver address in the setting ${'go.address' as keyof Settings}, falling back to using the LSP gateway.`
            )
            activateUsingLSPProxy()
        }
    }
    setTimeout(afterActivate, 100)
}
