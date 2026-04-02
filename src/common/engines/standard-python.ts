import { invoke } from '@tauri-apps/api/core'

import { AbstractEngine } from './abstract-engine'
import type { IMessageRequest, IModel } from './interfaces'

type StandardTranslateResponse = {
    text: string
}

export class StandardPython extends AbstractEngine {
    isLocal() {
        return true
    }

    supportCustomModel(): boolean {
        return false
    }

    async getModel(): Promise<string> {
        return 'tencent/HY-MT1.5-1.8B-GGUF (Q4_K_M)'
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async listModels(apiKey_: string | undefined): Promise<IModel[]> {
        return [
            {
                id: 'tencent/HY-MT1.5-1.8B-GGUF',
                name: 'HY-MT1.5 1.8B (GGUF Q4_K_M)',
                description: 'Default local GGUF model (download on first use).',
            },
        ]
    }

    async sendMessage(req: IMessageRequest): Promise<void> {
        try {
            req.onStatusCode?.(200)

            const prompt = [req.rolePrompt, req.commandPrompt].filter(Boolean).join('\n\n').trim()
            const resp = await invoke<StandardTranslateResponse>('standard_translate', {
                prompt,
            })

            await req.onMessage({ role: 'assistant', content: resp.text, isFullText: true })
            req.onFinished('stop')
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            req.onError(msg)
        }
    }
}
