import { IEngine } from './interfaces'
import { IconType } from 'react-icons'
import { Ollama } from './ollama'
import { OllamaIcon } from '@/common/components/icons/OllamaIcon'
import { MdOfflineBolt } from 'react-icons/md'
import { StandardPython } from './standard-python'

export type Provider = 'Standard' | 'Ollama'

export const engineIcons: Record<Provider, IconType> = {
    Standard: MdOfflineBolt,
    Ollama: OllamaIcon,
}

export const providerToEngine: Record<Provider, { new (): IEngine }> = {
    Standard: StandardPython,
    Ollama: Ollama,
}

export function getEngine(provider: Provider): IEngine {
    const cls = providerToEngine[provider]
    return new cls()
}
