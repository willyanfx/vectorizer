import { useCallback, useEffect, useRef, useState } from 'react'
import {
  toVTracerConfig,
  type TraceEngine,
  type TraceParams,
  type WorkerRequest,
  type WorkerResponse,
} from '../lib/params'
import { preprocess, type PreprocessOptions } from '../gpu'

export type TraceStatus = 'idle' | 'preprocessing' | 'tracing' | 'done' | 'error'

export interface TraceState {
  status: TraceStatus
  svg: string | null
  error: string | null
  engine: TraceEngine | null
  usedFallback: boolean
  fallbackReason: string | null
  traceMs: number | null
  preprocessMs: number | null
  backend: 'webgpu' | 'canvas' | null
}

const INITIAL: TraceState = {
  status: 'idle',
  svg: null,
  error: null,
  engine: null,
  usedFallback: false,
  fallbackReason: null,
  traceMs: null,
  preprocessMs: null,
  backend: null,
}

export function useTracer() {
  const workerRef = useRef<Worker | null>(null)
  const reqId = useRef(0) // monotonically increasing; stale results are ignored
  const readyRef = useRef(false)
  const pendingRef = useRef<{ file: Blob; params: TraceParams; pre: PreprocessOptions } | null>(null)
  const [state, setState] = useState<TraceState>(INITIAL)

  // Create the worker once.
  useEffect(() => {
    const worker = new Worker(new URL('../workers/tracer.worker.ts', import.meta.url), {
      type: 'module',
    })
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      switch (msg.type) {
        case 'ready':
          readyRef.current = true
          setState((s) => ({ ...s, engine: msg.engine }))
          // flush a request that arrived before init finished
          if (pendingRef.current) {
            const p = pendingRef.current
            pendingRef.current = null
            void runTrace(p.file, p.params, p.pre)
          }
          break
        case 'fallback':
          setState((s) => ({ ...s, usedFallback: true, fallbackReason: msg.reason }))
          break
        case 'result':
          if (msg.id !== reqId.current) return // stale
          setState((s) => ({
            ...s,
            status: 'done',
            svg: msg.svg,
            traceMs: msg.durationMs,
            engine: msg.engine,
            error: null,
          }))
          break
        case 'error':
          if (msg.id !== reqId.current) return
          setState((s) => ({ ...s, status: 'error', error: msg.message }))
          break
      }
    }

    worker.postMessage({ type: 'init' } satisfies WorkerRequest)
    return () => {
      worker.terminate()
      workerRef.current = null
      readyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runTrace = useCallback(
    async (file: Blob, params: TraceParams, pre: PreprocessOptions) => {
      const worker = workerRef.current
      if (!worker) return
      if (!readyRef.current) {
        // queue until the worker reports ready
        pendingRef.current = { file, params, pre }
        return
      }

      const id = ++reqId.current
      setState((s) => ({ ...s, status: 'preprocessing', error: null }))
      try {
        const { pixels, width, height, backend, durationMs } = await preprocess(file, pre)
        if (id !== reqId.current) return // superseded during async preprocessing
        setState((s) => ({ ...s, status: 'tracing', backend, preprocessMs: durationMs }))
        worker.postMessage(
          {
            type: 'trace',
            id,
            pixels,
            width,
            height,
            config: toVTracerConfig(params),
          } satisfies WorkerRequest,
          [pixels.buffer], // zero-copy transfer
        )
      } catch (err) {
        if (id !== reqId.current) return
        setState((s) => ({
          ...s,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    },
    [],
  )

  const reset = useCallback(() => {
    reqId.current++
    setState((s) => ({ ...INITIAL, engine: s.engine, usedFallback: s.usedFallback, fallbackReason: s.fallbackReason }))
  }, [])

  return { state, runTrace, reset }
}
