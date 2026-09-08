/** Todo el dinero circula en centavos enteros. Estas son las unicas conversiones. */

export const toCents = (amount: number): number => Math.round(amount * 100);

export const fromCents = (cents: number): number => cents / 100;

export function formatMoney(cents: number, currency = 'ARS'): string {
  const symbol = currency === 'ARS' || currency === 'USD' ? '$' : `${currency} `;
  const value = (cents / 100).toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol}${value}`;
}
