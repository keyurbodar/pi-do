/**
 * GitHub PR seam. Plain types shape the valibot schemas of the next
 * phase; fetching runs over plain `fetch` against api.github.com.
 * Shell only: helpers throw until wired.
 */

export interface PrFile {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
}

export interface PrComment {
  id: number;
  path: string | null;
  body: string;
}

function shell(name: string): never {
  throw new Error(`github: ${name} is a shell, wiring lands next phase`);
}

export async function fetchPrFiles(
  _owner: string,
  _repo: string,
  _n: number,
): Promise<PrFile[]> {
  shell('fetchPrFiles');
}

export async function fetchPrPatch(
  _owner: string,
  _repo: string,
  _n: number,
): Promise<string> {
  shell('fetchPrPatch');
}

export async function fetchPrComments(
  _owner: string,
  _repo: string,
  _n: number,
): Promise<PrComment[]> {
  shell('fetchPrComments');
}
