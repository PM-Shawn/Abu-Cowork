// src/core/tools/enterprise-kb-query.ts
// Agent tool that queries enterprise knowledge bases via RAG.
// Only registered when client is in enterprise mode AND has visible KBs.

import type { ToolDefinition } from '@/types'
import { toolRegistry } from './registry'
import { useEnterpriseKbStore } from '@/stores/enterpriseKbStore'
import { queryKb, listKbs } from '@/core/enterprise/kb/api'

export const TOOL_NAME = 'enterprise_kb_query'

/** JSON Schema for agent — tells the LLM how to call this tool. */
const inputSchema: ToolDefinition['inputSchema'] = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The natural-language question or keywords to search in the knowledge base.',
    },
    kbId: {
      type: 'string',
      description: 'Optional. The ID of a specific knowledge base. If omitted, searches all visible KBs.',
    },
    topK: {
      type: 'number',
      description: 'Number of chunks to return (default 6, max 20).',
    },
  },
  required: ['query'],
}

async function buildDescription(): Promise<string> {
  const catalog = useEnterpriseKbStore.getState().catalog ?? []
  if (catalog.length === 0) return 'Query enterprise and personal knowledge bases (none currently available).'
  const enterprise = catalog.filter(c => c.scope !== 'personal_synced')
  const personal = catalog.filter(c => c.scope === 'personal_synced')
  const sections: string[] = [
    'Query enterprise and personal knowledge bases via RAG retrieval. Returns ranked text chunks with filename + relevance score.',
  ]
  if (enterprise.length > 0) {
    const list = enterprise.slice(0, 10).map(c => `  - ${c.name} (id: ${c.id}${c.description ? `; ${c.description}` : ''})`).join('\n')
    sections.push(`\nEnterprise / team KBs (shared with your org or team):\n${list}`)
  }
  if (personal.length > 0) {
    const list = personal.slice(0, 10).map(c => `  - ${c.name} (id: ${c.id})`).join('\n')
    sections.push(`\nPersonal KBs (only you can access — your own uploaded documents):\n${list}`)
  }
  sections.push('\nCall this tool when the user\'s question is likely answerable from documented knowledge (policies, OKRs, FAQs, meeting notes, personal notes). Pass a specific kbId if known; otherwise omit to search all visible KBs.')
  return sections.join('')
}

async function execute(input: Record<string, unknown>): Promise<string> {
  const query = String(input.query ?? '').trim()
  if (!query) return JSON.stringify({ ok: false, error: 'query is required' })
  const topK = Math.min(20, Math.max(1, (typeof input.topK === 'number' ? input.topK : 6)))
  const kbId = typeof input.kbId === 'string' ? input.kbId : undefined

  const catalog = useEnterpriseKbStore.getState().catalog ?? (await listKbs().catch(() => []))

  // pick KB(s)
  const targets = kbId ? catalog.filter(c => c.id === kbId) : catalog
  if (targets.length === 0) return JSON.stringify({ ok: false, error: 'no accessible knowledge base' })

  // Fan-out: query each KB in parallel, merge results sorted by score, take top-K
  const settled = await Promise.allSettled(
    targets.slice(0, 5).map(t => queryKb(t.id, query, topK).then(r => r.results.map(c => ({ ...c, kbName: t.name }))))
  )
  const all = settled.flatMap(s => s.status === 'fulfilled' ? s.value : [])
  all.sort((a, b) => b.score - a.score)
  const top = all.slice(0, topK)

  return JSON.stringify({
    ok: true,
    chunks: top.map(c => ({
      text: c.text,
      filename: c.filename,
      score: c.score,
      kbName: c.kbName,
    })),
  })
}

/** Public registration entrypoint — called by App.tsx after enterprise mode init. */
export async function registerEnterpriseKbTool(): Promise<void> {
  const description = await buildDescription()
  const toolDef: ToolDefinition = {
    name: TOOL_NAME,
    description,
    inputSchema,
    execute,
    isConcurrencySafe: true,
  }
  toolRegistry.register(toolDef)
  console.info(`[enterprise] registered tool: ${TOOL_NAME}`)
}

export { buildDescription as describe, execute }
