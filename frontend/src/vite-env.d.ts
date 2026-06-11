/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_APP_BUILD_SHA: string
    readonly VITE_APP_VERSION: string
    // more env variables...
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
