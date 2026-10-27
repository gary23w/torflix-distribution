export class GitHub {
  constructor(token) { if (!token) throw new Error('Missing GitHub credential'); this.token = token; }
  async request(path, { method = 'GET', body, missing = false } = {}) {
    const response = await fetch(`https://api.github.com/${path}`, {
      method, signal: AbortSignal.timeout(60000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 1200)}`);
    return response.status === 204 ? null : response.json();
  }
  async file(repo, path, ref, missing = false) {
    const result = await this.request(`repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, { missing });
    if (!result) return null;
    if (result.type !== 'file' || result.encoding !== 'base64') throw new Error(`Expected a text file: ${repo}/${path}`);
    return { sha: result.sha, text: Buffer.from(result.content, 'base64').toString('utf8') };
  }
  async commitFiles(repo, branch, files, message, startSha) {
    const refPath = `repos/${repo}/git/refs/heads/${branch}`;
    const existing = await this.request(`repos/${repo}/git/ref/heads/${branch}`, { missing: true });
    const parent = existing?.object.sha ?? startSha;
    if (!parent) throw new Error(`Missing starting commit for ${repo}:${branch}`);
    const commit = await this.request(`repos/${repo}/git/commits/${parent}`);
    const entries = await Promise.all(Object.entries(files).map(async ([path, content]) => {
      const blob = await this.request(`repos/${repo}/git/blobs`, { method: 'POST', body: { content, encoding: 'utf-8' } });
      return { path, mode: '100644', type: 'blob', sha: blob.sha };
    }));
    const tree = await this.request(`repos/${repo}/git/trees`, { method: 'POST', body: { base_tree: commit.tree.sha, tree: entries } });
    if (tree.sha === commit.tree.sha) return parent;
    const next = await this.request(`repos/${repo}/git/commits`, { method: 'POST', body: { message, tree: tree.sha, parents: [parent] } });
    if (existing) await this.request(refPath, { method: 'PATCH', body: { sha: next.sha, force: false } });
    else await this.request(`repos/${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: next.sha } });
    return next.sha;
  }
}
