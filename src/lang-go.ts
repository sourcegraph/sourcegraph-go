import '@babel/polyfill'

import * as basicCodeIntel from '@sourcegraph/basic-code-intel'
import * as wsrpc from '@sourcegraph/vscode-ws-jsonrpc'
import { ajax } from 'rxjs/ajax'
import * as sourcegraph from 'sourcegraph'
import * as rpc from 'vscode-jsonrpc'
import * as lsp from 'vscode-languageserver-protocol'
import * as convert from './convert-lsp-to-sea'
import * as lspext from './lspext'

import * as path from 'path'

import {
    BehaviorSubject,
    from,
    Observable,
    Observer,
    of,
    throwError,
    race,
    combineLatest,
    ObservableInput,
    merge,
} from 'rxjs'
import {
    concatMap,
    distinctUntilChanged,
    map,
    mergeMap,
    scan,
    shareReplay,
    switchMap,
    take,
    finalize,
    tap,
    delay,
    mapTo,
    startWith,
    takeUntil,
    share,
    filter,
    endWith,
} from 'rxjs/operators'

import { ConsoleLogger, createWebSocketConnection } from '@sourcegraph/vscode-ws-jsonrpc'
import gql from 'tagged-template-noop'
import { Settings } from './settings'
import { documentSelector } from '@sourcegraph/basic-code-intel/lib/handler'

// If we can rid ourselves of file:// URIs, this type won't be necessary and we
// can use lspext.Xreference directly.
type XRef = lspext.Xreference & { currentDocURI: string }

// Useful when go-langserver is running in a Docker container.
function sourcegraphURL(): string {
    return (
        (sourcegraph.configuration.get<Settings>().get('go.sourcegraphUrl') as string | undefined) ||
        sourcegraph.internal.sourcegraphURL.toString()
    )
}

interface AccessTokenResponse {
    currentUser: {
        accessTokens: {
            nodes: { note: string }[]
            pageInfo: {
                hasNextPage: boolean
            }
        }
    }
    errors: string[]
}

async function userHasAccessTokenWithNote(note: string): Promise<boolean> {
    const response: AccessTokenResponse = await queryGraphQL(`
    query {
        currentUser {
            accessTokens(first: 1000) {
                nodes {
                    note
                },
                pageInfo {
                    hasNextPage
                }
            }
        }
    }
    `)

    if (
        !response ||
        !response.currentUser ||
        !response.currentUser.accessTokens ||
        !response.currentUser.accessTokens.nodes ||
        !Array.isArray(response.currentUser.accessTokens.nodes)
    ) {
        return false
    }
    if (response.currentUser.accessTokens.pageInfo && response.currentUser.accessTokens.pageInfo.hasNextPage) {
        throw new Error('You have too many access tokens (over 1000).')
    }
    return response.currentUser.accessTokens.nodes.some(token => token.note === note)
}

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
    const zipURL = new URL(sourcegraphURL())
    // URL.pathname is different on Chrome vs Safari, so don't rely on it. Instead, constr
    return (
        zipURL.protocol +
        '//' +
        (token ? token + '@' : '') +
        zipURL.host +
        '/' +
        repoName +
        '@' +
        encodeURIComponent(revision) +
        '/-/raw'
    )
}

// Returns a URL template to the raw API. For example: 'https://%s@localhost:3080/%s@%s/-/raw'
function zipURLTemplate(token: string | undefined): string | undefined {
    const url = new URL(sourcegraphURL())
    return url.protocol + '//' + (token ? token + '@' : '') + url.host + '/%s@%s/-/raw'
}

async function queryGraphQL(query: string, variables: any = {}): Promise<any> {
    const { data, errors } = await sourcegraph.commands.executeCommand('queryGraphQL', query, variables)
    if (errors) {
        throw Object.assign(new Error(errors.map((err: any) => err.message).join('\n')), { errors })
    }
    return data
}

const NOTE_FOR_GO_ACCESS_TOKEN = 'go'

// Undefined means the current user is anonymous.
let accessTokenPromise: Promise<string | undefined>
export async function getOrTryToCreateAccessToken(): Promise<string | undefined> {
    const hasToken = await userHasAccessTokenWithNote(NOTE_FOR_GO_ACCESS_TOKEN)
    const setting = sourcegraph.configuration.get<Settings>().get('go.accessToken')
    if (hasToken && setting) {
        return setting
    } else {
        return accessTokenPromise || (accessTokenPromise = tryToCreateAccessToken())
    }
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
            { user: currentUserId, scopes: ['user:all'], note: NOTE_FOR_GO_ACCESS_TOKEN }
        )
        const token: string = result.createAccessToken.token
        await sourcegraph.configuration.get<Settings>().update('go.accessToken', token)
        return token
    }
}

async function connectAndInitialize(
    address: string,
    root: URL,
    token: string | undefined
): Promise<rpc.MessageConnection> {
    const connection = (await new Promise((resolve, reject) => {
        const webSocket = new WebSocket(address)
        const conn = createWebSocketConnection(wsrpc.toSocket(webSocket), new ConsoleLogger())
        webSocket.addEventListener('open', () => resolve(conn))
        webSocket.addEventListener('error', event =>
            reject(new Error(`unable to connect to the Go language server at ${address}`))
        )
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
                    token,
                }),
                zipURLTemplate: zipURLTemplate(token),
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

function repoNameFromDoc(doc: sourcegraph.TextDocument): string {
    const url = new URL(doc.uri)
    return url.pathname.slice(2)
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
function mkSendRequest(address: string, token: string | undefined): Observable<SendRequest> {
    const rootURIToConnection: { [rootURI: string]: Promise<rpc.MessageConnection> } = {}
    async function connectionFor(root: URL): Promise<rpc.MessageConnection> {
        if (rootURIToConnection[root.href]) {
            return rootURIToConnection[root.href]
        } else {
            rootURIToConnection[root.href] = connectAndInitialize(address, root, token)
            const connection = await rootURIToConnection[root.href]
            connection.onDispose(() => {
                delete rootURIToConnection[root.href]
            })
            connection.onClose(() => {
                delete rootURIToConnection[root.href]
            })
            return connection
        }
    }

    const sendRequest: SendRequest = async ({ rootURI, requestType, request, useCache }) => {
        if (useCache) {
            return await (await connectionFor(rootURI)).sendRequest(requestType, request)
        } else {
            const connection = await connectAndInitialize(address, rootURI, token)
            const response = await connection.sendRequest(requestType, request)
            connection.dispose()
            return response
        }
    }

    return new Observable((observer: Observer<SendRequest>) => {
        observer.next(sendRequest)
        return () => {
            for (const rootURI of Object.keys(rootURIToConnection)) {
                if (rootURIToConnection[rootURI]) {
                    // tslint:disable-next-line: no-floating-promises
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

async function repositoriesThatImportViaGDDO(
    buildGDDOURL: (path: string) => string,
    importPath: string,
    limit: number
): Promise<Set<string>> {
    const response = (await ajax({ url: buildGDDOURL(importPath), responseType: 'json' }).toPromise())
        .response as GDDOImportersResponse
    if (!response || !response.results || !Array.isArray(response.results)) {
        throw new Error('Invalid response from godoc.org:' + response)
    } else {
        const repoNames: string[] = (await Promise.all(
            response.results
                .map(result => result.path)
                .filter(path =>
                    // This helps filter out repos that do not exist on the Sourcegraph.com instance
                    path.startsWith('github.com/')
                )
                .map(path => {
                    // Chop off portion after "github.com/owner/repo".
                    const parts = path.split('/')
                    return parts.slice(0, 3).join('/')
                })
                .filter(repo => !!repo)
                .slice(0, limit)
                .map(async repo => {
                    try {
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
                    } catch (err) {
                        if (err.message && err.message.includes('ExternalRepo:<nil>')) {
                            console.warn(
                                `Unable to find cross-repository references in ${repo}, probably because the repository was renamed and Sourcegraph does not support renamed repositories yet.`
                            )
                        } else {
                            console.warn(err)
                        }
                        return undefined
                    }
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
        const corsAnywhereURL = sourcegraph.configuration.get<Settings>().get('go.corsAnywhereURL')
        function composeForward<A, B, C>(f: (a: A) => B, g: (b: B) => C): (a: A) => C {
            return a => g(f(a))
        }
        function identity<A>(a: A): A {
            return a
        }
        function mkBuildGDDOURL(gddoURL: string): (path: string) => string {
            return composeForward(
                (path: string): string => {
                    const importersURL = new URL(gddoURL)
                    importersURL.pathname = 'importers/' + path
                    return importersURL.href
                },
                corsAnywhereURL ? (url: string): string => corsAnywhereURL + url : (identity as (url: string) => string)
            )
        }
        const repositoriesThatImport = gddoURL
            ? (importPath: string, limit: number) =>
                  repositoriesThatImportViaGDDO(mkBuildGDDOURL(gddoURL), importPath, limit)
            : repositoriesThatImportViaSearch
        const repos = new Set(Array.from(await repositoriesThatImport(definition.symbol.package, limit)))
        // Skip the current repository because the local references provider will cover it.
        repos.delete(repoNameFromDoc(doc))
        // Assumes the import path is the same as the repo name - not always true!
        repos.delete(definition.symbol.package)
        return Array.from(repos).map(repo => ({ repo, definition }))
    })()

    return from(candidates).pipe(
        concatMap(candidates => candidates),
        mergeMap(
            async ({ repo, definition }) => {
                const rootURI = new URL(`git://${repo}?HEAD`)
                // This creates a new connection and immediately disposes it because
                // each xreferences request here has a different rootURI (enforced
                // by `new Set` above), rendering caching useless.
                const response = (await sendRequest({
                    rootURI,
                    requestType: new lsp.RequestType<any, any, any, void>('workspace/xreferences') as any,
                    // tslint:disable-next-line:no-object-literal-type-assertion
                    request: {
                        query: definition.symbol,
                        limit: 20,
                    } as { query: lspext.LSPSymbol; limit: number },
                    useCache: false,
                })) as lspext.Xreference[]

                return (response || []).map(ref => ({ ...ref, currentDocURI: rootURI.href }))
            },
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
 * Emits from `fallback` after `delayMilliseconds`. Useful for falling back to
 * basic-code-intel while the language server is running.
 */
function withFallback<T>({
    main,
    fallback,
    delayMilliseconds,
}: {
    main: ObservableInput<T>
    fallback: ObservableInput<T>
    delayMilliseconds: number
}): Observable<T> {
    return race(
        of(null).pipe(switchMap(() => from(main))),
        of(null).pipe(
            delay(delayMilliseconds),
            switchMap(() => from(fallback))
        )
    )
}

/**
 * Uses WebSockets to communicate with a language server.
 */
export async function activateUsingWebSockets(
    ctx: sourcegraph.ExtensionContext,
    basicCodeIntelHandler: basicCodeIntel.Handler
): Promise<void> {
    const accessToken = await getOrTryToCreateAccessToken()
    const settings: BehaviorSubject<Settings> = new BehaviorSubject<Settings>({})
    ctx.subscriptions.add(
        sourcegraph.configuration.subscribe(() => {
            settings.next(sourcegraph.configuration.get<Settings>().value)
        })
    )
    const langserverAddress = settings.pipe(map(settings => settings['go.serverUrl']))

    const NO_ADDRESS_ERROR = `To get Go code intelligence, add "${'go.address' as keyof Settings}": "wss://example.com" to your settings.`

    const sendRequestObservable = langserverAddress.pipe(
        switchMap(address => (address ? mkSendRequest(address, accessToken) : of(undefined))),
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

    ctx.subscriptions.add(
        sourcegraph.languages.registerHoverProvider([{ pattern: '*.go' }], {
            provideHover: (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) =>
                withFallback({
                    main: sendDocPositionRequest({ doc, pos, ty: lsp.HoverRequest.type, useCache: true }).then(
                        convert.hover
                    ),
                    fallback: basicCodeIntelHandler.hover(doc, pos),
                    delayMilliseconds: 500,
                }),
        })
    )

    ctx.subscriptions.add(
        sourcegraph.languages.registerDefinitionProvider([{ pattern: '*.go' }], {
            provideDefinition: (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) =>
                withFallback({
                    main: sendDocPositionRequest({
                        doc,
                        pos,
                        ty: new lsp.RequestType<any, any, any, void>('textDocument/xdefinition') as any,
                        useCache: true,
                    }).then(response => convert.xdefinition({ currentDocURI: doc.uri, xdefinition: response })),
                    fallback: basicCodeIntelHandler.definition(doc, pos),
                    delayMilliseconds: 500,
                }),
        })
    )

    ctx.subscriptions.add(
        sourcegraph.languages.registerReferenceProvider([{ pattern: '*.go' }], {
            provideReferences: (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) =>
                withFallback({
                    main: sendDocPositionRequest({
                        doc,
                        pos,
                        ty: lsp.ReferencesRequest.type,
                        useCache: true,
                    }).then(response => ({
                        kind: 'main',
                        result: convert.references({ currentDocURI: doc.uri, references: response }),
                    })),
                    fallback: basicCodeIntelHandler.references(doc, pos).then(result => ({ kind: 'fallback', result })),
                    delayMilliseconds: 2000,
                }).pipe(
                    // Indicate in the UI that the results are imprecise
                    tap(({ kind }) => {
                        sourcegraph.internal.updateContext({ isImprecise: kind === 'fallback' })
                    }),
                    map(({ result }) => result)
                ),
        })
    )

    /**
     * Automatically registers/deregisters a provider based on the given predicate of the settings.
     */
    function registerWhile({
        register,
        settingsPredicate,
    }: {
        register: () => sourcegraph.Unsubscribable
        settingsPredicate: (settings: Settings) => boolean
    }): sourcegraph.Unsubscribable {
        let registration: sourcegraph.Unsubscribable | undefined
        return from(settings)
            .pipe(
                map(settingsPredicate),
                distinctUntilChanged(),
                map(enabled => {
                    if (enabled) {
                        registration = register()
                    } else {
                        if (registration) {
                            registration.unsubscribe()
                            registration = undefined
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

    ctx.subscriptions.add(
        registerWhile({
            register: () =>
                sourcegraph.languages.registerReferenceProvider([{ pattern: '*.go' }], {
                    provideReferences: (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) =>
                        xrefs({
                            doc,
                            pos,
                            sendRequest,
                        }).pipe(
                            scan((acc: XRef[], curr: XRef) => [...acc, curr], [] as XRef[]),
                            map(response => convert.xreferences({ references: response }))
                        ),
                }),
            settingsPredicate: settings => Boolean(settings['go.showExternalReferences']),
        })
    )

    // Implementations panel.
    const IMPL_ID = 'go.impl' // implementations panel and provider ID
    ctx.subscriptions.add(
        sourcegraph.languages.registerLocationProvider(IMPL_ID, [{ pattern: '*.go' }], {
            provideLocations: async (doc: sourcegraph.TextDocument, pos: sourcegraph.Position) => {
                const response = await sendDocPositionRequest({
                    doc,
                    pos,
                    ty: lsp.ImplementationRequest.type,
                    useCache: true,
                })
                return convert.references({ currentDocURI: doc.uri, references: response })
            },
        })
    )
    const panelView = sourcegraph.app.createPanelView(IMPL_ID)
    panelView.title = 'Go ifaces/impls'
    panelView.component = { locationProvider: IMPL_ID }
    panelView.priority = 160
    ctx.subscriptions.add(panelView)
}

function pathname(url: string): string {
    let pathname = url
    pathname = pathname.slice('git://'.length)
    pathname = pathname.slice(0, pathname.indexOf('?'))
    return pathname
}

const basicCodeIntelHandlerArgs: basicCodeIntel.HandlerArgs = {
    sourcegraph,
    languageID: 'go',
    fileExts: ['go'],
    filterDefinitions: ({ repo, filePath, fileContent, results }) => {
        const currentFileImportedPaths = fileContent
            .split('\n')
            .map(line => {
                // Matches the import at index 3
                const match = /^(import |\t)(\w+ |\. )?"(.*)"$/.exec(line)
                return match ? match[3] : undefined
            })
            .filter((x): x is string => Boolean(x))

        const currentFileImportPath = repo + '/' + path.dirname(filePath)

        const filteredResults = results.filter(result => {
            const resultImportPath = result.repo + '/' + path.dirname(result.file)
            return [...currentFileImportedPaths, currentFileImportPath].some(i => resultImportPath === i)
        })

        return filteredResults.length === 0 ? results : filteredResults
    },
    commentStyle: {
        lineRegex: /\/\/\s?/,
    },
}

// No-op for Sourcegraph versions prior to 3.0.
const DUMMY_CTX = { subscriptions: { add: (_unsubscribable: any) => void 0 } }

export function activate(ctx: sourcegraph.ExtensionContext = DUMMY_CTX): void {
    async function afterActivate(): Promise<void> {
        const basicCodeIntelHandler = new basicCodeIntel.Handler(basicCodeIntelHandlerArgs)
        const address = sourcegraph.configuration.get<Settings>().get('go.serverUrl')
        if (address) {
            await activateUsingWebSockets(ctx, basicCodeIntelHandler)
        } else {
            sourcegraph.internal.updateContext({ isImprecise: true })

            ctx.subscriptions.add(
                sourcegraph.languages.registerHoverProvider(documentSelector(basicCodeIntelHandler.fileExts), {
                    provideHover: (doc, pos) => basicCodeIntelHandler.hover(doc, pos),
                })
            )
            ctx.subscriptions.add(
                sourcegraph.languages.registerDefinitionProvider(documentSelector(basicCodeIntelHandler.fileExts), {
                    provideDefinition: (doc, pos) => basicCodeIntelHandler.definition(doc, pos),
                })
            )
            ctx.subscriptions.add(
                sourcegraph.languages.registerReferenceProvider(documentSelector(basicCodeIntelHandler.fileExts), {
                    provideReferences: (doc, pos) => basicCodeIntelHandler.references(doc, pos),
                })
            )
        }
    }
    setTimeout(afterActivate, 100)
}
