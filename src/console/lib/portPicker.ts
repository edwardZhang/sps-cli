/**
 * @module        console/lib/portPicker
 * @description   找可用端口。默认 4311 起尝试，连续 N 次失败则报错。
 */
import { createServer } from 'node:net';

export async function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function pickPort(
  preferred: number,
  maxTries = 10,
  host = '127.0.0.1',
): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const port = preferred + i;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port, host)) return port;
  }
  throw new Error(
    `Ports ${preferred}–${preferred + maxTries - 1} all in use. Use --port <n> to specify.`,
  );
}
