/**
 * Unit tests must never reach the network. This setup file runs in every test
 * worker and blocks any outbound connection to a host other than this machine:
 *
 *  - `fetch` (ccc's HTTP transport), by URL, before any DNS lookup;
 *  - `net.connect` / `tls.connect` (http, https, `ws` WebSockets), by host name;
 *  - every TCP connect at the socket binding, by resolved address, as a backstop
 *    for anything that reaches a socket another way.
 *
 * A blocked attempt fails with a stack trace and is written to stderr with the
 * current test's name. Callers may swallow the error (ccc's client falls back
 * between URLs and can hide a single failure), so the test that was running, or
 * failing that the file, is also failed afterwards.
 */
import net from "node:net";
import tls from "node:tls";
import { getSystemErrorMap } from "node:util";
import { afterAll, afterEach, expect } from "vitest";

const LOCAL_NAMES = new Set(["localhost", "::1", "[::1]", "0.0.0.0", "::"]);

function isLocal(host: string | undefined): boolean {
  if (host === undefined || host === "") return true; // net defaults to localhost
  const h = host.toLowerCase();
  return LOCAL_NAMES.has(h) || h.startsWith("127.") || h.startsWith("::ffff:127.") || h.endsWith(".localhost");
}

const blocked: string[] = [];

function block(what: string): Error {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const err = new Error(`no-network guard: blocked ${what} (unit tests must not use the network)`);
  Error.stackTraceLimit = limit;
  const state = expect.getState();
  process.stderr.write(
    `\n[no-network guard] ${what}\n  test: ${state.currentTestName ?? "(outside a test)"}\n  file: ${state.testPath ?? "?"}\n${err.stack}\n`,
  );
  blocked.push(`${what} (in ${state.currentTestName ?? "no test"})`);
  return err;
}

function failIfBlocked(): void {
  if (blocked.length === 0) return;
  const list = blocked.splice(0).join("\n  ");
  throw new Error(`no-network guard: blocked network access:\n  ${list}`);
}
afterEach(failIfBlocked);
afterAll(failIfBlocked);

// 1. fetch
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!isLocal(url.hostname.replace(/^\[|\]$/g, ""))) throw block(`fetch ${url.href}`);
  return realFetch(input, init);
}) as typeof fetch;

// 2. net / tls entry points, by host name
function hostOf(args: unknown[]): { host?: string; path?: string } {
  const [a, b] = args;
  if (Array.isArray(a)) return hostOf(a);
  if (a && typeof a === "object") return a as { host?: string; path?: string };
  if (typeof a === "number") return { host: typeof b === "string" ? b : undefined };
  if (typeof a === "string") return /^\d+$/.test(a) ? { host: typeof b === "string" ? b : undefined } : { path: a };
  return {};
}
function guardEntry<T extends (...args: never[]) => unknown>(name: string, real: T): T {
  return function (this: unknown, ...args: unknown[]) {
    const { host, path } = hostOf(args);
    if (path === undefined && !isLocal(host)) throw block(`${name} to ${host}`);
    return (real as unknown as (...a: unknown[]) => unknown).apply(this, args);
  } as unknown as T;
}
net.connect = guardEntry("net.connect", net.connect);
net.createConnection = guardEntry("net.createConnection", net.createConnection);
tls.connect = guardEntry("tls.connect", tls.connect);
net.Socket.prototype.connect = guardEntry("socket connect", net.Socket.prototype.connect);

// 3. backstop: the TCP binding every socket uses, by resolved address. http(s)
// hold their own reference to net/tls connect, so this is what stops them. It
// fails the connect with ECONNREFUSED, as a refused connection would, rather
// than throwing inside Node's DNS callback.
const ECONNREFUSED = [...getSystemErrorMap()].find(([, [name]]) => name === "ECONNREFUSED")?.[0] ?? -111;
type TcpProto = { connect: (...a: unknown[]) => number; connect6: (...a: unknown[]) => number };
const binding = (process as unknown as { binding: (n: string) => { TCP: { prototype: TcpProto } } }).binding("tcp_wrap");
const proto = binding.TCP.prototype;
for (const key of ["connect", "connect6"] as const) {
  const real = proto[key];
  proto[key] = function (this: unknown, req: unknown, address: unknown, ...rest: unknown[]) {
    if (typeof address === "string" && !isLocal(address)) {
      block(`TCP ${key} to ${address}`);
      return ECONNREFUSED;
    }
    return real.call(this, req, address, ...rest);
  };
}
