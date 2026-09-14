import { createContext, useContext, type ReactNode } from 'react';
import type { Permiso, Sesion } from './sesion';

/**
 * La sesión al alcance de cualquier pantalla. Existe porque el rol no decide
 * solo qué pantallas se ven: dentro de una misma pantalla hay datos que no
 * corresponden, como la facturación en el tablero de la cocina.
 */
const SesionContext = createContext<Sesion | null>(null);

export const ProveedorDeSesion = ({ sesion, children }: { sesion: Sesion; children: ReactNode }) => (
  <SesionContext.Provider value={sesion}>{children}</SesionContext.Provider>
);

export const useSesion = () => useContext(SesionContext);

/** `true` si quien está mirando tiene ese permiso. */
export const usePermiso = (permiso: Permiso): boolean =>
  Boolean(useContext(SesionContext)?.permisos?.includes(permiso));
