import { describe, expect, it } from 'vitest';
import {
  ParseWorkerPool,
  resolveParsePoolSize,
  type ParsePoolWorker,
  type ParseTask,
} from '../src/extraction/parse-pool';
import type { ExtractionResult, Language } from '../src/types';

type MessageListener = (message: unknown) => void;

class FakeWorker implements ParsePoolWorker {
  private messageListener?: MessageListener;
  private exitListener?: (code: number) => void;
  readonly loadMessages: unknown[] = [];
  active = true;

  constructor(
    private readonly parse: (
      message: { id: number; filePath: string }
    ) => Promise<ExtractionResult> | ExtractionResult
  ) {}

  on(
    event: 'message' | 'error' | 'exit',
    listener: MessageListener | ((error: Error) => void) | ((code: number) => void)
  ): void {
    if (event === 'message') this.messageListener = listener as MessageListener;
    if (event === 'exit') this.exitListener = listener as (code: number) => void;
  }

  postMessage(raw: unknown): void {
    const message = raw as {
      type: string;
      id?: number;
      filePath?: string;
    };
    if (message.type === 'load-grammars') {
      this.loadMessages.push(raw);
      setImmediate(() => {
        if (this.active) {
          this.messageListener?.({ type: 'grammars-loaded' });
        }
      });
      return;
    }
    if (
      message.type === 'parse' &&
      message.id !== undefined &&
      message.filePath
    ) {
      void Promise.resolve(
        this.parse({ id: message.id, filePath: message.filePath })
      ).then((result) => {
        if (this.active) {
          this.messageListener?.({
            type: 'parse-result',
            id: message.id,
            result,
          });
        }
      });
    }
  }

  terminate(): Promise<number> {
    this.active = false;
    return Promise.resolve(0);
  }
}

const task = (filePath: string): ParseTask => ({
  filePath,
  content: 'export function value() {}',
  language: 'typescript' as Language,
});

const result = (tag: number): ExtractionResult => ({
  nodes: [],
  edges: [],
  unresolvedReferences: [],
  errors: [],
  durationMs: tag,
});

describe('parse pool sizing', () => {
  it('keeps a rollback path and caps automatic parallelism', () => {
    expect(resolveParsePoolSize('1', 32)).toBe(1);
    expect(resolveParsePoolSize('4', 32)).toBe(4);
    expect(resolveParsePoolSize(undefined, 32)).toBe(8);
    expect(resolveParsePoolSize(undefined, 2)).toBe(1);
  });
});

describe('ParseWorkerPool', () => {
  it('dispatches parsing concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pool = new ParseWorkerPool({
      languages: ['typescript'],
      size: 4,
      createWorker: () =>
        new FakeWorker(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await gate;
          active--;
          return result(1);
        }),
    });
    pool.prewarm();

    const pending = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((file) =>
      pool.requestParse(task(file))
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(maxActive).toBe(4);
    release();
    await Promise.all(pending);
    await pool.destroy();
  });

  it('initializes every worker with the fork C/C++ macro context', async () => {
    const workers: FakeWorker[] = [];
    const pool = new ParseWorkerPool({
      languages: ['c', 'cpp'],
      size: 3,
      macroNames: ['DECLARE_FN', 'API_EXPORT'],
      bodylessMacroNames: ['EMPTY_GUARD'],
      createWorker: () => {
        const worker = new FakeWorker(() => result(1));
        workers.push(worker);
        return worker;
      },
    });
    pool.prewarm();

    expect(workers).toHaveLength(3);
    for (const worker of workers) {
      const load = worker.loadMessages[0] as {
        macroNames: string[];
        bodylessMacroNames: string[];
      };
      expect(load.macroNames).toEqual(['DECLARE_FN', 'API_EXPORT']);
      expect(load.bodylessMacroNames).toEqual(['EMPTY_GUARD']);
    }
    await pool.destroy();
  });

  it('returns results through a size-one rollback pool', async () => {
    const pool = new ParseWorkerPool({
      languages: ['typescript'],
      size: 1,
      createWorker: () => new FakeWorker(() => result(42)),
    });
    const parsed = await pool.requestParse(task('one.ts'));
    expect(parsed.durationMs).toBe(42);
    await pool.destroy();
  });
});
