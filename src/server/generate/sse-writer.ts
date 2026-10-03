import type { DiagramStreamMessage } from "~/features/diagram/types";
import { canWriteStreamMessage } from "./stream-buffer";
import { sseMessage } from "./types";

export interface GenerationStreamState {
  streamClosed: boolean;
  wasCancelled: boolean;
}

export interface StreamWriteOptions {
  allowDeadlineTerminal?: boolean;
}

interface PendingWrite {
  message: string;
  options?: StreamWriteOptions;
  resolve: (written: boolean) => void;
}

/**
 * Write diagram events in order and flush padded batches on buffered hosts.
 * @see docs/flows/diagram-generation.md
 */
export function createGenerationSseWriter(params: {
  controller: ReadableStreamDefaultController<Uint8Array>;
  signal: AbortSignal;
  state: GenerationStreamState;
  getAbortCause: () => "client" | "deadline" | null;
  abortGeneration: (cause: "client" | "deadline") => void;
  flushPadBytes?: number;
}) {
  const flushPadBytes =
    Number.isFinite(params.flushPadBytes) && (params.flushPadBytes ?? 0) > 0
      ? Math.floor(params.flushPadBytes ?? 0)
      : 0;
  const encoder = new TextEncoder();
  const pullWaiters = new Set<() => void>();
  let pending: PendingWrite[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let closing = false;
  let writeTail: Promise<void> = Promise.resolve();

  const clearFlushTimer = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const clearHeartbeatTimer = () => {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const paddedComment = (prefix: string, currentBytes = 0) => {
    const suffix = "\n\n";
    const fixedBytes = encoder.encode(prefix + suffix).byteLength;
    return `${prefix}${" ".repeat(Math.max(0, flushPadBytes - currentBytes - fixedBytes))}${suffix}`;
  };

  const resetHeartbeat = () => {
    clearHeartbeatTimer();
    if (
      flushPadBytes === 0 ||
      closing ||
      params.state.streamClosed ||
      params.signal.aborted
    ) {
      return;
    }

    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      // A timer has no caller to observe a failed write.
      void queueWrite(paddedComment(": keep-alive")).catch(() => undefined);
    }, 15_000);
  };

  const notifyPull = () => {
    for (const resolve of pullWaiters) {
      resolve();
    }
    pullWaiters.clear();
  };

  const canWrite = (options?: StreamWriteOptions) =>
    canWriteStreamMessage({
      abortCause: params.getAbortCause(),
      aborted: params.signal.aborted,
      allowDeadlineTerminal: Boolean(options?.allowDeadlineTerminal),
      streamClosed: params.state.streamClosed,
    });

  const waitForCapacity = async () => {
    while (
      !params.state.streamClosed &&
      !params.signal.aborted &&
      params.controller.desiredSize !== null &&
      params.controller.desiredSize <= 0
    ) {
      await new Promise<void>((resolve) => pullWaiters.add(resolve));
    }
  };

  const queueWrite = (
    message: string,
    options?: StreamWriteOptions,
  ): Promise<boolean> => {
    const write = writeTail.then(async () => {
      if (!canWrite(options)) {
        return false;
      }

      await waitForCapacity();
      if (!canWrite(options)) {
        return false;
      }

      try {
        params.controller.enqueue(encoder.encode(message));
        resetHeartbeat();
        return true;
      } catch {
        params.state.streamClosed = true;
        params.state.wasCancelled = true;
        notifyPull();
        params.abortGeneration("client");
        return false;
      }
    });
    // The tail must never reject: a poisoned chain would make every later write
    // and the final close() throw, leaving the response open until the platform
    // timeout instead of delivering a terminal event.
    writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  };

  const flushPending = () => {
    clearFlushTimer();
    if (pending.length === 0) {
      return;
    }

    const batch = pending;
    pending = [];
    const write = writeTail.then(async () => {
      let writable = batch.filter((entry) => canWrite(entry.options));
      if (writable.length === 0) {
        batch.forEach((entry) => entry.resolve(false));
        return;
      }

      await waitForCapacity();
      writable = writable.filter((entry) => canWrite(entry.options));
      if (writable.length === 0) {
        batch.forEach((entry) => entry.resolve(false));
        return;
      }

      const accepted = new Set(writable);
      const eventText = writable.map((entry) => entry.message).join("");
      const eventBytes = encoder.encode(eventText).byteLength;
      const bytes = encoder.encode(eventText + paddedComment(": ", eventBytes));

      try {
        params.controller.enqueue(bytes);
        resetHeartbeat();
        batch.forEach((entry) => entry.resolve(accepted.has(entry)));
      } catch {
        params.state.streamClosed = true;
        params.state.wasCancelled = true;
        notifyPull();
        params.abortGeneration("client");
        batch.forEach((entry) => entry.resolve(false));
      }
    });
    writeTail = write.then(
      () => undefined,
      () => {
        batch.forEach((entry) => entry.resolve(false));
      },
    );
  };

  const queueBufferedWrite = (
    message: string,
    options?: StreamWriteOptions,
  ): Promise<boolean> => {
    if (!canWrite(options) || closing) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      pending.push({ message, options, resolve });
      if (!flushTimer) {
        flushTimer = setTimeout(flushPending, 250);
      }
    });
  };

  const onAbort = () => {
    clearHeartbeatTimer();
    clearFlushTimer();
    if (params.getAbortCause() === "deadline" && !params.state.streamClosed) {
      flushPending();
    } else {
      pending.forEach((entry) => entry.resolve(false));
      pending = [];
    }
    notifyPull();
  };

  params.signal.addEventListener("abort", onAbort, { once: true });
  resetHeartbeat();

  const send = (
    payload: DiagramStreamMessage,
    options?: StreamWriteOptions,
  ): Promise<boolean> => {
    if (!canWrite(options)) {
      return Promise.resolve(false);
    }
    return flushPadBytes > 0
      ? queueBufferedWrite(sseMessage(payload), options)
      : queueWrite(sseMessage(payload), options);
  };

  const sendComment = (comment: string): Promise<boolean> => {
    if (params.state.streamClosed || params.signal.aborted) {
      return Promise.resolve(false);
    }
    return flushPadBytes > 0
      ? queueBufferedWrite(`: ${comment}\n\n`)
      : queueWrite(`: ${comment}\n\n`);
  };

  const close = async () => {
    closing = true;
    clearHeartbeatTimer();
    flushPending();
    await writeTail;
    params.signal.removeEventListener("abort", onAbort);
    if (params.state.streamClosed) {
      return;
    }
    params.state.streamClosed = true;
    try {
      params.controller.close();
    } catch {
      // The consumer may already have cancelled the stream.
    }
  };

  return { close, notifyPull, send, sendComment };
}
