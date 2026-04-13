import { invoke } from '@tauri-apps/api/core'

import { getSettings } from '../utils'
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

            // HY-MT1.5 model requires a specific prompt format:
            // Chinese involved: 将以下文本翻译为{target}，注意只需要输出翻译后的结果，不要额外解释：\n{text}
            // Non-Chinese:      Translate the following segment into {target}, without additional explanation.\n{text}
            const sourceText = req.sourceText || ''
            const targetLang = req.targetLang || 'English'
            const sourceLang = req.sourceLang || ''

            const isChineseInvolved =
                /chinese|中文|简体|繁體/i.test(targetLang) || /chinese|中文|简体|繁體/i.test(sourceLang)

            let prompt: string
            if (isChineseInvolved) {
                prompt = `将以下文本翻译为${targetLang}，注意只需要输出翻译后的结果，不要额外解释：\n${sourceText}`
            } else {
                prompt = `Translate the following segment into ${targetLang}, without additional explanation.\n${sourceText}`
            }

            console.debug('[StandardPython] prompt:', prompt)

            const settings = await getSettings()
            const hf = (settings.hfEndpoint ?? '').trim()
            const resp = await invoke<StandardTranslateResponse>('standard_translate', {
                prompt,
                hfEndpoint: hf.length > 0 ? hf : null,
            })

            await req.onMessage({ role: 'assistant', content: resp.text, isFullText: true })
            req.onFinished('stop')
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            req.onError(msg)
        }
    }
}
