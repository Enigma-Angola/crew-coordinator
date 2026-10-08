/**
 * API errors carry a stable machine code; the client translates codes into the user's
 * language. Messages here are for logs and developers only.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export const notFound = () => new ApiError(404, 'not_found');
export const forbidden = (code = 'forbidden') => new ApiError(403, code);
export const badRequest = (code = 'invalid_request', details?: Record<string, unknown>) => new ApiError(400, code, details);
export const conflict = (details: Record<string, unknown>) => new ApiError(409, 'edit_conflict', details);
