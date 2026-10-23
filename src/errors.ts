export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code.replace(/_/g, ' '));
  }
}

export const badRequest = (code: string, message?: string) => new AppError(400, code, message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const forbidden = (message = 'Admins only') => new AppError(403, 'forbidden', message);
export const unauthorized = (message = 'Missing or invalid token') =>
  new AppError(401, 'unauthorized', message);
export const conflict = (code: string, message?: string) => new AppError(409, code, message);
export const tooManyRequests = (waitMs: number) =>
  new AppError(429, 'rate_limited', `Too many requests, retry in ${Math.ceil(waitMs / 1000)}s`);
