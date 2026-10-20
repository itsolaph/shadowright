import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { buildBoardView, type BoardView } from './boardview.ts';
import { loadConfig, type Config } from './config.ts';
import { pickSubject, subjectSources, walrusMemory } from './runtime.ts';
import { listSubjects, shortAddress, type Subject } from './subjects.ts';

/**
 * The Licence Board: a small read-only web server. Data comes from Walrus Memory recall;
 * nothing is written, signed or sent anywhere else. Binds to localhost by default.
 */

const STATIC_DIR = join(import.meta.dirname, '..', 'web');
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
/** Each board refresh costs seven recalls of the relayer's hourly request budget. */
const CACHE_MS = 5 * 60_000;

interface SubjectSummary {
  name: string;
  short: string;
  namespace: string;
  isDefault: boolean;
}

class BoardServer {
  private readonly config: Config;
  private readonly cache = new Map<string, { at: number; view: BoardView }>();

  constructor(config: Config) {
    this.config = config;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = `${request.method} ${url.pathname}`;
    const subject = url.searchParams.get('subject') ?? undefined;
    switch (route) {
      case 'GET /api/subjects':
        return sendJson(response, await this.subjects());
      case 'GET /api/board':
        return sendJson(response, await this.board(subject, url.searchParams.has('fresh')));
      case 'POST /api/restore':
        return sendJson(response, await this.restore(subject));
    }
    const asset = request.method === 'GET' ? STATIC_FILES[url.pathname] : undefined;
    if (!asset) return sendJson(response, { error: 'not found' }, 404);
    response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' });
    response.end(await readFile(join(STATIC_DIR, asset.file)));
  }

  private async subjects(): Promise<SubjectSummary[]> {
    const sources = await subjectSources(this.config);
    return listSubjects(sources).map((s) => ({
      name: s.name,
      short: shortAddress(s.address),
      namespace: s.namespace,
      isDefault: s.name === sources.file.default,
    }));
  }

  /** Board from Walrus Memory recall, cached for a few minutes. */
  private async board(selector: string | undefined, fresh: boolean) {
    const { subject } = await pickSubject(this.config, selector);
    const cached = this.cache.get(subject.name);
    if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return withSubject(subject, cached.view);
    const view = buildBoardView(await walrusMemory(this.config, subject.namespace).recallAll(), this.config.licence);
    this.cache.set(subject.name, { at: Date.now(), view });
    return withSubject(subject, view);
  }

  /**
   * Portability demo: a brand-new Walrus Memory client re-indexes the namespace from Walrus
   * and the board is rebuilt from what it recalls. No local file or cache is read.
   */
  private async restore(selector: string | undefined) {
    const { subject } = await pickSubject(this.config, selector);
    const fresh = walrusMemory(this.config, subject.namespace);
    const { restored, skipped, failed, total, truncated } = await fresh.restore(100);
    const view = buildBoardView(await fresh.recallAll(), this.config.licence);
    this.cache.set(subject.name, { at: Date.now(), view });
    return { ...withSubject(subject, view), restore: { restored, skipped, failed, total, truncated } };
  }
}

function withSubject(subject: Subject, view: BoardView) {
  return { subject: { name: subject.name, short: shortAddress(subject.address), namespace: subject.namespace }, ...view };
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function main(): void {
  const config = loadConfig();
  const server = new BoardServer(config);
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  createServer((request, response) => {
    server.handle(request, response).catch((error: unknown) => {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    });
  }).listen(port, host, () => console.log(`Shadowright Licence Board on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
}

main();
