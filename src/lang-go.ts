import * as sourcegraph from 'sourcegraph'

export function activate(): void {
   sourcegraph.languages.registerHoverProvider(['*'], {
       provideHover: () => ({ contents: { value: 'Hello world from Code intelligence for Go! 🎉🎉🎉' } })
   })
}

// Learn what else is possible by visiting the [Sourcegraph extension documentation](https://github.com/sourcegraph/sourcegraph-extension-docs)
