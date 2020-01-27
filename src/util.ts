import {Observable} from 'rxjs'

export async function* observableToAsyncGenerator<T>(o: Observable<T>): AsyncGenerator<T, void, undefined> {
    const values: T[] = []
    let done = false
    let error: Error | null = null

    o.subscribe(data => values.push(data), err => (error = err), () => (done = true))

    while (true) {
        while (values.length > 0) {
            const val = values.pop()
            if (val) {
                yield val
            }
        }

        if (error) {
            throw error
        }
        if (done) {
            return
        }

        await Promise.resolve(null)
    }
}
