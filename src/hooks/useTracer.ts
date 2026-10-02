import { useCallback, useEffect, useRef, useState } from 'react'
import {
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

interface TraceRequest {
  file: Blob
  params: TraceParams
  pre: PreprocessOptions
}

export function useTracer() {
  const workerRef = useRef<Worker | null>(null)
  const reqId = useRef(0) // monotonically increasing; stale results are ignored
  const readyRef = useRef(false)
  const pendingRef = useRef<TraceRequest | null>(null)
  const lastRef = useRef<TraceRequest | null>(null) // latest request, for retry after a crash
  const [state, setState] = useState<TraceState>(INITIAL)

  // Create the worker once; replace it if the WASM inside it crashes.
  useEffect(() => {
    let disposed = false

    const spawn = () => {
      const worker = new Worker(new URL('../workers/tracer.worker.ts', import.meta.url), {
        type: 'module',
      })
      workerRef.current = worker
      readyRef.current = false

      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        if (worker !== workerRef.current) return // late message from a replaced worker
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
            if (msg.fatal) {
              // A Rust panic left the WASM instance unusable; start a fresh one
              // so the next trace isn't poisoned by this one.
              worker.terminate()
              if (!disposed) spawn()
              // A newer request may have been queued in the dead worker; rerun
              // it on the fresh one once it's ready.
              if (msg.id !== reqId.current && lastRef.current) pendingRef.current = lastRef.current
            }
            if (msg.id !== reqId.current) return
            setState((s) => ({ ...s, status: 'error', error: msg.message }))
            break
        }
      }

      worker.postMessage({ type: 'init' } satisfies WorkerRequest)
    }

    spawn()
    return () => {
      disposed = true
      workerRef.current?.terminate()
      workerRef.current = null
      readyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runTrace = useCallback(
    async (file: Blob, params: TraceParams, pre: PreprocessOptions) => {
      if (!workerRef.current) return
      if (!readyRef.current) {
        // queue until the worker reports ready
        pendingRef.current = { file, params, pre }
        return
      }

      lastRef.current = { file, params, pre }
      const id = ++reqId.current
      setState((s) => ({ ...s, status: 'preprocessing', error: null }))
      try {
        const { pixels, width, height, backend, durationMs } = await preprocess(file, pre)
        if (id !== reqId.current) return // superseded during async preprocessing
        // The worker may have been replaced (crash respawn) while we awaited.
        const current = workerRef.current
        if (!current || !readyRef.current) {
          pendingRef.current = { file, params, pre }
          return
        }
        setState((s) => ({ ...s, status: 'tracing', backend, preprocessMs: durationMs }))
        current.postMessage(
          {
            type: 'trace',
            id,
            pixels,
            width,
            height,
            params,
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
