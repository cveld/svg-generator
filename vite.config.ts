import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import Anthropic from '@anthropic-ai/sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { Connect } from 'vite'

const SYSTEM_PROMPT = `You are an expert SVG artist and graphic designer. Your sole task is to generate high-quality, visually compelling SVG graphics based on the user's description.

CRITICAL RULES — follow these without exception:
1. Return ONLY the raw SVG markup. Start your response with <svg and end with </svg>.
2. Do NOT include markdown code fences, the word "svg", any explanation, or any text before or after the SVG.
3. Every SVG must include: xmlns="http://www.w3.org/2000/svg", viewBox, width, and height attributes.
4. Use fills, gradients, patterns, and shapes creatively to make visually rich graphics.
5. Keep the SVG self-contained — no external references or scripts.
6. Aim for artwork that is detailed and beautiful, not minimal placeholder graphics.
7. Use <defs> with gradients and filters where they enhance the result.
8. Width and height should typically be 800x600 or 600x600 unless the description implies otherwise.`

// Strip ANSI escape codes that the claude CLI injects into stdout
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[mGKHF]/g, '')

function callViaCLI(prompt: string, env: Record<string, string>): Promise<string> {
  const fullPrompt = `${SYSTEM_PROMPT}\n\nUser request: ${prompt}`
  const claudePath = env.CLAUDE_CLI_PATH ?? 'claude'
  const isWindows = process.platform === 'win32'

  return new Promise((resolve, reject) => {
    let tmpFile: string | null = null
    let proc: ReturnType<typeof spawn>

    if (isWindows) {
      tmpFile = join(tmpdir(), `claude-${randomBytes(4).toString('hex')}.ps1`)
      const script = `$prompt = @'\n${fullPrompt}\n'@\n& ${claudePath} -p $prompt\n`
      writeFileSync(tmpFile, script, 'utf8')
      console.log(`[proxy] wrote script to ${tmpFile}`)
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', tmpFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      })
    } else {
      proc = spawn(claudePath, ['-p', fullPrompt], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      })
    }

    console.log(`[proxy] process spawned (pid=${proc.pid})`)

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(`[proxy] out: ${text}`)
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(`[proxy] err: ${text}`)
    })

    proc.on('close', (code) => {
      if (tmpFile) { try { unlinkSync(tmpFile) } catch { /* ignore */ } }
      console.log(`[proxy] exited code=${code} stdout=${stdout.length}chars`)
      if (code === 0) resolve(stripAnsi(stdout).trim())
      else reject(new Error(stripAnsi(stderr).trim() || `claude exited with code ${code}`))
    })

    proc.on('error', (err) => {
      if (tmpFile) { try { unlinkSync(tmpFile) } catch { /* ignore */ } }
      console.error('[proxy] spawn error:', err.message)
      reject(err)
    })
  })
}

async function streamViaAgentSDK(
  prompt: string,
  env: Record<string, string>,
  onThinking: (chunk: string) => void,
): Promise<string> {
  const oauthToken = env.CLAUDE_OAUTH_TOKEN
  if (oauthToken) process.env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken
  console.log(`[proxy] Agent SDK — auth: ${oauthToken ? 'OAuth token' : 'ANTHROPIC_API_KEY'}`)

  const fullPrompt = `${SYSTEM_PROMPT}\n\nUser request: ${prompt}`
  let result = ''

  for await (const msg of query({
    prompt: fullPrompt,
    options: { maxTurns: 1, includePartialMessages: true, thinking: { type: 'adaptive' } },
  })) {
    if (msg.type === 'stream_event') {
      const ev = msg.event
      if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta') {
        onThinking(ev.delta.thinking)
      }
    } else if (msg.type === 'result') {
      if (msg.subtype === 'success') result = msg.result
      else throw new Error(`Agent error (${msg.subtype}): ${msg.errors?.join(', ')}`)
    }
  }
  return result
}

async function callViaMessagesAPI(prompt: string, env: Record<string, string>): Promise<string> {
  const oauthToken = env.CLAUDE_OAUTH_TOKEN
  const apiKey = env.ANTHROPIC_API_KEY
  if (!oauthToken && !apiKey) throw new Error('Set ANTHROPIC_API_KEY or CLAUDE_OAUTH_TOKEN in .env')

  const client = oauthToken
    ? new Anthropic({ authToken: oauthToken })
    : new Anthropic({ apiKey })
  console.log(`[proxy] Messages API — auth: ${oauthToken ? 'OAuth token' : 'API key'}`)
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  })
  const textBlock = response.content.find((b) => b.type === 'text')
  return textBlock?.type === 'text' ? textBlock.text : ''
}

function attachMiddleware(middlewares: Connect.Server, env: Record<string, string>) {
  middlewares.use('/api/generate', (req, res, next) => {
    if (req.method !== 'POST') { next(); return }

    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', async () => {
      console.log('[proxy] request received')

      // SSE setup
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

      try {
        const { prompt } = JSON.parse(body) as { prompt: string }
        console.log(`[proxy] prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`)

        const useCLI = env.USE_CLAUDE_CLI === 'true'
        const useAgentSDK = !useCLI && !!env.CLAUDE_OAUTH_TOKEN
        const mode = useCLI ? 'CLI' : useAgentSDK ? 'Agent SDK' : 'Messages API'
        console.log(`[proxy] mode: ${mode}`)

        let text: string
        if (useAgentSDK) {
          text = await streamViaAgentSDK(prompt, env, (chunk) => send('thinking', { chunk }))
        } else if (useCLI) {
          text = await callViaCLI(prompt, env)
        } else {
          text = await callViaMessagesAPI(prompt, env)
        }

        console.log(`[proxy] done, ${text.length} chars, starts with: ${JSON.stringify(text.slice(0, 60))}`)
        send('done', { text })
        res.end()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[proxy] error:', message)
        send('error', { message })
        res.end()
      }
    })
  })
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      react(),
      {
        name: 'anthropic-proxy',
        configureServer(server) { attachMiddleware(server.middlewares, env) },
        configurePreviewServer(server) { attachMiddleware(server.middlewares, env) },
      },
    ],
  }
})
