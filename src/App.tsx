import { useState, useCallback, useRef } from 'react'
import './App.css'

const EXAMPLE_PROMPTS = [
  'A glowing neon Amsterdam canal at night with reflections in the water',
  'A geometric mandala with intricate symmetrical patterns in purple and gold',
  'A minimalist mountain landscape at sunset with gradient sky',
  'A cute cartoon robot waving, flat design style',
  'An abstract flowchart diagram showing a software deployment pipeline',
  'A retro space scene with a rocket, planets, and stars',
]

function extractSVG(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('<svg')) return trimmed
  const match = trimmed.match(/<svg[\s\S]*<\/svg>/i)
  return match ? match[0] : null
}

type SSEEvent = { event: string; data: unknown }

async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        let event = ''
        let data = ''
        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) data = line.slice(6)
        }
        if (event && data) yield { event, data: JSON.parse(data) }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export default function App() {
  const [prompt, setPrompt] = useState('')
  const [svgContent, setSvgContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [thinking, setThinking] = useState<string | null>(null)
  const [thinkingOpen, setThinkingOpen] = useState(true)
  const thinkingRef = useRef<HTMLPreElement>(null)

  const generateSVG = useCallback(async (overridePrompt?: string) => {
    const text = (overridePrompt ?? prompt).trim()
    if (!text || isLoading) return
    setIsLoading(true)
    setError(null)
    setSvgContent(null)
    setShowSource(false)
    setThinking(null)
    setThinkingOpen(true)

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      })
      if (!res.body) throw new Error('No response body')

      for await (const { event, data } of readSSE(res.body)) {
        const d = data as Record<string, string>
        if (event === 'thinking') {
          setThinking((t) => {
            const next = (t ?? '') + d.chunk
            // auto-scroll thinking box
            setTimeout(() => {
              if (thinkingRef.current) {
                thinkingRef.current.scrollTop = thinkingRef.current.scrollHeight
              }
            }, 0)
            return next
          })
        } else if (event === 'done') {
          const svg = extractSVG(d.text ?? '')
          if (!svg) throw new Error('Response did not contain valid SVG markup')
          setSvgContent(svg)
          setThinkingOpen(false)
        } else if (event === 'error') {
          throw new Error(d.message ?? 'Unknown error')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [prompt, isLoading])

  const downloadSVG = useCallback(() => {
    if (!svgContent) return
    const blob = new Blob([svgContent], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'generated.svg'
    a.click()
    URL.revokeObjectURL(url)
  }, [svgContent])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generateSVG()
  }

  const handleExample = (example: string) => {
    setPrompt(example)
    generateSVG(example)
  }

  const testConnection = () => generateSVG('A small red circle on a white background. Keep it minimal.')

  return (
    <div className="app">
      <header className="app-header">
        <h1>SVG Generator</h1>
        <p className="subtitle">Describe an image and Claude will draw it as SVG</p>
      </header>

      <main className="app-main">
        <div className="examples">
          {EXAMPLE_PROMPTS.map((ex) => (
            <button key={ex} className="example-chip" onClick={() => handleExample(ex)} disabled={isLoading}>
              {ex}
            </button>
          ))}
        </div>

        <div className="prompt-section">
          <textarea
            className="prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe the SVG you want to generate... (Ctrl+Enter to generate)"
            rows={4}
            disabled={isLoading}
          />
          <div className="prompt-actions">
            <button className="test-btn" onClick={testConnection} disabled={isLoading} title="Minimal test prompt">
              Test
            </button>
            <button className="generate-btn" onClick={() => generateSVG()} disabled={isLoading || !prompt.trim()}>
              {isLoading ? <><span className="spinner" />Generating...</> : 'Generate SVG'}
            </button>
          </div>
        </div>

        {error && <div className="error-box"><strong>Error:</strong> {error}</div>}

        {thinking !== null && (
          <details className="thinking-box" open={thinkingOpen} onToggle={(e) => setThinkingOpen((e.target as HTMLDetailsElement).open)}>
            <summary className="thinking-summary">
              <span>{isLoading && thinkingOpen ? <><span className="spinner-sm" />Thinking…</> : 'Thinking'}</span>
            </summary>
            <pre className="thinking-content" ref={thinkingRef}>{thinking || ' '}</pre>
          </details>
        )}

        {svgContent && (
          <div className="result-section">
            <div className="result-toolbar">
              <h2>Result</h2>
              <div className="toolbar-actions">
                <button className="secondary-btn" onClick={() => setShowSource((s) => !s)}>
                  {showSource ? 'Hide Source' : 'View Source'}
                </button>
                <button className="secondary-btn" onClick={downloadSVG}>Download SVG</button>
              </div>
            </div>
            {showSource
              ? <pre className="source-view">{svgContent}</pre>
              : <div className="svg-preview" dangerouslySetInnerHTML={{ __html: svgContent }} />}
          </div>
        )}
      </main>
    </div>
  )
}
