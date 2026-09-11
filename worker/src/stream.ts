// stream.ts — seam shim: the stream lane split into a frame codec
// (stream-codec.ts: sockets, frames, emitEntry, broadcast) and a turn
// engine (stream-engine.ts: turn policy, executeTurn, redriveTurn).
// Existing importers keep importing from ./stream.
export * from "./stream-codec";
export * from "./stream-engine";
export * from "./protocol";
