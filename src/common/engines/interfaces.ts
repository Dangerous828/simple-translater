export interface IModel {
    id: string
    name: string
    description?: string
}

export interface IMessage {
    role: string
    content: string
}

export interface IMessageRequest {
    rolePrompt: string
    commandPrompt: string
    modelOverride?: string
    thinkingBudget?: number
    /** Raw source text for local translation engines (avoids prompt parsing). */
    sourceText?: string
    /** Target language name for local translation engines (e.g. "简体中文", "English"). */
    targetLang?: string
    /** Source language name for local translation engines (e.g. "English", "简体中文"). */
    sourceLang?: string
    onMessage: (message: { content: string; role: string; isFullText?: boolean }) => Promise<void>
    onError: (error: string) => void
    onFinished: (reason: string) => void
    onStatusCode?: (statusCode: number) => void
    signal: AbortSignal
}

export interface IEngine {
    checkLogin: () => Promise<boolean>
    isLocal(): boolean
    supportCustomModel(): boolean
    getModel(): Promise<string>
    listModels(apiKey: string | undefined): Promise<IModel[]>
    sendMessage(req: IMessageRequest): Promise<void>
}
