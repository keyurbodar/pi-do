// env.ts — ComputerExecutionEnv: pi filesystem seam over a FileStore-shaped object.
// Misses throw { error, hint } objects, never raw strings.

export interface FileStoreLike {
  put(ws: string, path: string, body: Uint8Array, updatedAt: string): number;
  get(ws: string, path: string): ArrayBuffer | Uint8Array | undefined;
  list(ws: string, dir: string): Array<{ path: string; bytes: number }>;
  exists(ws: string, path: string): boolean;
  remove(ws: string, path: string): boolean;
}

export interface FileStat {
  path: string;
  bytes: number;
}

function notFound(path: string): { error: string; hint: string } {
  return {
    error: `no such file: ${path}`,
    hint: "write it with writeFile first, or check readdir for the exact path",
  };
}

function toBytes(body: ArrayBuffer | Uint8Array): Uint8Array {
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exit: number;
  timedOut: boolean;
}

export interface ShellLike {
  exec(input: { command: string; cwd?: string }): Promise<ShellExecResult>;
}

export class ComputerExecutionEnv {
  private store: FileStoreLike;
  private ws: string;
  private shell: ShellLike | undefined;

  constructor(store: FileStoreLike, ws: string, shell?: ShellLike) {
    this.store = store;
    this.ws = ws;
    this.shell = shell;
  }

  readFile(path: string): Uint8Array {
    const body = this.store.get(this.ws, path);
    if (body === undefined) throw notFound(path);
    return toBytes(body);
  }

  writeFile(path: string, data: Uint8Array | string): FileStat {
    const body =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    const bytes = this.store.put(
      this.ws,
      path,
      body,
      new Date().toISOString(),
    );
    return { path, bytes };
  }

  stat(path: string): FileStat {
    const body = this.store.get(this.ws, path);
    if (body === undefined) throw notFound(path);
    return { path, bytes: toBytes(body).byteLength };
  }

  readdir(dir: string): FileStat[] {
    return this.store.list(this.ws, dir);
  }

  async exec(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exit: number }> {
    if (!this.shell) {
      throw {
        error: "shell unavailable",
        hint: "construct ComputerExecutionEnv with a shell binding to run commands",
      };
    }
    const result = await this.shell.exec({ command, cwd });
    if (result.timedOut) {
      throw {
        error: "exec timed out",
        hint: "retry with a shorter command; kill support arrives in PR12",
      };
    }
    return { stdout: result.stdout, stderr: result.stderr, exit: result.exit };
  }

  rm(path: string): { path: string } {
    if (!this.store.remove(this.ws, path)) throw notFound(path);
    return { path };
  }
}
