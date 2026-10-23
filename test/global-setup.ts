import { execFileSync } from 'node:child_process';
import pg from 'pg';

/**
 * Starts a throwaway postgres:17 container for the test run, unless
 * TEST_DATABASE_URL points at an existing (disposable!) database.
 */
let containerId: string | null = null;

export async function setup({ provide }: { provide: (key: string, value: unknown) => void }) {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    containerId = execFileSync(
      'docker',
      [
        'run', '-d', '--rm',
        '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_USER=test', '-e', 'POSTGRES_DB=surecaller_test',
        '-p', '127.0.0.1::5432',
        'postgres:17',
      ],
      { encoding: 'utf8' },
    ).trim();
    const portLine = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' })
      .trim()
      .split('\n')[0];
    const port = portLine.split(':').pop();
    url = `postgres://test:test@127.0.0.1:${port}/surecaller_test`;
  }

  // Wait until postgres accepts connections (the image restarts once during init).
  const deadline = Date.now() + 90_000;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      // Survive the init-time restart: require a second success a moment later.
      await new Promise((r) => setTimeout(r, 1500));
      const again = new pg.Client({ connectionString: url });
      await again.connect();
      await again.end();
      break;
    } catch {
      await client.end().catch(() => {});
      if (Date.now() > deadline) throw new Error('postgres did not start in time');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  provide('databaseUrl', url);
}

export async function teardown() {
  if (containerId) {
    try {
      execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
