/** Cliente HTTP unico. Centraliza el token del panel y el formato de error. */

const ADMIN_TOKEN_KEY = 'comeia.adminToken';

export const getAdminToken = () => localStorage.getItem(ADMIN_TOKEN_KEY) ?? '';
export const setAdminToken = (token: string) => localStorage.setItem(ADMIN_TOKEN_KEY, token);
export const clearAdminToken = () => localStorage.removeItem(ADMIN_TOKEN_KEY);

/**
 * Qué hacer cuando el servidor dice que falta la credencial. Lo registra la
 * aplicación para mostrar la pantalla de acceso: sin esto el panel cargaba y
 * todas las pantallas quedaban vacías sin explicar por qué.
 */
let alFaltarCredencial: (() => void) | null = null;
export const onUnauthorized = (handler: () => void) => {
  alFaltarCredencial = handler;
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getAdminToken();
  const response = await fetch(`/api${path}`, {
    method,
    // La sesion viaja en una cookie HttpOnly: sin esto el navegador no la manda.
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();

  if (response.status === 401) alFaltarCredencial?.();

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Error ${response.status}`;
    const details =
      typeof payload === 'object' && payload
        ? (payload as { details?: unknown; issues?: unknown }).details ??
          (payload as { issues?: unknown }).issues
        : undefined;
    throw new ApiError(response.status, message, details);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};
