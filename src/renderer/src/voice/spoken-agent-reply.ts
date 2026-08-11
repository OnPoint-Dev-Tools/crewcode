import type { AgentMessage } from '../types'

function textBlocks(message: AgentMessage): string {
  const blocks = message.blocks
    .filter((block): block is ['t', string] => block[0] === 't')
    .map(([, text]) => text.trim())
    .filter(Boolean)
  return blocks.length > 0 ? blocks.join('\n') : (message.text ?? '')
}

export function naturalSpokenReply(raw: string): string {
  const prose = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      if (!trimmed) return true
      if (/^\|.*\|$/.test(trimmed)) return false
      if (/^(diff --git|index [\da-f]+\.\.[\da-f]+|@@ |--- |\+\+\+ )/i.test(trimmed)) return false
      if (/^[+-]\s*(const|let|var|function|class|import|export|return|if|for|while)\b/.test(trimmed)) return false
      return true
    })
    .join(' ')
    .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)]\((?:https?:\/\/|mailto:)[^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    // Strip Markdown emphasis delimiters rather than replacing them with spaces:
    // `**important**` should be spoken as "important", not "asterisk" or as
    // two artificially separated words. Include common Unicode asterisk forms
    // because pasted/model-generated Markdown is not always ASCII.
    .replace(/\\([*_~])/g, '$1')
    .replace(/[＊*⁎∗✱✲✳✴✵✶✷✸✹✺✻✼✽✾❃❉❊❋]/gu, '')
    .replace(/[_~>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!prose) return 'The coding agent finished. The full technical result is available in the chat.'
  return prose
}

export function spokenAgentMessage(message: AgentMessage): string {
  return naturalSpokenReply(textBlocks(message))
}
