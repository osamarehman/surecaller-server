import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

export interface Notifier {
  readonly enabled: boolean;
  /** Sends a data-only message to each token. Never throws. */
  send(tokens: string[], data: Record<string, string>): Promise<void>;
}

interface Logger {
  info(msg: string): void;
  warn(obj: unknown, msg?: string): void;
}

export const nullNotifier: Notifier = { enabled: false, send: async () => {} };

/**
 * FCM HTTP v1 sender. Returns a no-op notifier when no service account is
 * configured, so polling-only installs work without Firebase.
 */
export function createNotifier(
  serviceAccountPath: string | null,
  log: Logger,
  onInvalidToken: (token: string) => Promise<void>,
): Notifier {
  if (!serviceAccountPath) return nullNotifier;
  let projectId: string;
  try {
    projectId = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')).project_id;
    if (!projectId) throw new Error('project_id missing');
  } catch (err) {
    log.warn({ err }, `FCM disabled: cannot read service account ${serviceAccountPath}`);
    return nullNotifier;
  }
  const auth = new GoogleAuth({
    keyFile: serviceAccountPath,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  log.info(`FCM enabled for project ${projectId}`);

  return {
    enabled: true,
    async send(tokens, data) {
      if (tokens.length === 0) return;
      let client;
      try {
        client = await auth.getClient();
      } catch (err) {
        log.warn({ err }, 'FCM auth failed');
        return;
      }
      await Promise.all(
        tokens.map(async (token) => {
          try {
            await client.request({
              url,
              method: 'POST',
              data: { message: { token, data, android: { priority: 'HIGH' } } },
            });
          } catch (err) {
            const status = (err as { response?: { status?: number } }).response?.status;
            if (status === 404 || status === 400) {
              await onInvalidToken(token).catch(() => {});
            } else {
              log.warn({ err: (err as Error).message }, 'FCM send failed');
            }
          }
        }),
      );
    },
  };
}
