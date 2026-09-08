export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toLocaleString('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function moneyExact(cents: number): string {
  return `$${(cents / 100).toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Las fechas llegan como "YYYY-MM-DD HH:MM:SS" en UTC. */
export function parseDate(value: string): Date {
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

export function timeAgo(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - parseDate(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/**
 * Hora en 24 h. El formato por defecto de es-AR devuelve "09:47 p. m.", que en
 * una pantalla de cocina se lee mal; el reloj de un local es siempre 24 h.
 */
export const clock = (value: string) =>
  parseDate(value).toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

export const shortDate = (value: string) =>
  parseDate(value).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });

export const isToday = (value: string) => {
  const date = parseDate(value);
  const now = new Date();
  return (
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()
  );
};

/** Hora sola si es de hoy; con la fecha si es de otro dia. */
export const stamp = (value: string) =>
  isToday(value) ? clock(value) : `${shortDate(value)} ${clock(value)}`;

export const pct = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const STATUS_LABEL: Record<string, string> = {
  borrador: 'Borrador',
  confirmado: 'En espera',
  en_preparacion: 'Cocinando',
  listo: 'Listo',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};

export const SERVICE_LABEL: Record<string, string> = {
  local: 'En el local',
  takeaway: 'Para llevar',
  delivery: 'Delivery',
};
