import type { Request, Response } from './protocol.ts'

// Omit applied to each member of the union, so request bodies stay discriminated.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type RequestBody = DistributiveOmit<Request, 'id'>

interface Handlers {
  onProgress?: (stage: string, fraction: number) => void
  onPartial?: (data: unknown) => void
}

interface Pending extends Handlers {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}

// Main-thread side of the analysis worker. Requests resolve with their result,
// or with null if a newer request of the same kind superseded them.
//
// The worker starts on the first request, and dispose() only stops it. React's
// StrictMode mounts, unmounts and remounts in development, so an Analyzer can be
// disposed before it is ever used; it must still work afterwards.
export class Analyzer {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1

  request<T>(body: RequestBody, handlers: Handlers = {}, transfer: Transferable[] = []): Promise<T | null> {
    const id = this.nextId++
    return new Promise<T | null>((resolve, reject) => {
      this.pending.set(id, { ...handlers, resolve: resolve as (d: unknown) => void, reject })
      this.start().postMessage({ ...body, id }, transfer)
    })
  }

  private start(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (ev: MessageEvent<Response>) => this.receive(ev.data)
    }
    return this.worker
  }

  private receive(msg: Response) {
    const p = this.pending.get(msg.id)
    if (!p) return
    if (msg.type === 'progress') p.onProgress?.(msg.stage, msg.fraction)
    else if (msg.type === 'partial') p.onPartial?.(msg.data)
    else {
      this.pending.delete(msg.id)
      if (msg.type === 'result') p.resolve(msg.data)
      else if (msg.type === 'cancelled') p.resolve(null)
      else p.reject(new Error(msg.message))
    }
  }

  dispose() {
    this.worker?.terminate()
    this.worker = null
    for (const p of this.pending.values()) p.resolve(null)
    this.pending.clear()
  }
}
