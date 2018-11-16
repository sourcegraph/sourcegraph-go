export const LANGSERVER_ADDRESS_SETTING = 'lang-go.address'

export interface FullSettings {
    'lang-go.address': string
}

export type Settings = Partial<FullSettings>
