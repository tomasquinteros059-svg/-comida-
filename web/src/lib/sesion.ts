import { api } from './api';

export const PERMISOS = ['ventas', 'carta', 'stock', 'compras', 'cocina', 'bot', 'usuarios'] as const;
export type Permiso = (typeof PERMISOS)[number];
export type Rol = 'dueño' | 'encargado' | 'cocina';

export interface UsuarioSesion {
  id: string | null;
  name: string;
  role: Rol;
  /** Entró con el token maestro en vez de con usuario y clave. */
  viaToken: boolean;
}

export interface Sesion {
  autenticado: boolean;
  /** La base todavía no tiene a nadie: hay que crear el primer dueño. */
  sinUsuarios: boolean;
  /** El servidor tiene ADMIN_TOKEN configurado (llave de repuesto). */
  conToken: boolean;
  usuario?: UsuarioSesion;
  permisos?: Permiso[];
}

export const leerSesion = () => api.get<Sesion>('/auth/me');

export const puede = (sesion: Sesion | null, permiso: Permiso): boolean =>
  Boolean(sesion?.permisos?.includes(permiso));

export interface Usuario {
  id: string;
  name: string;
  username: string;
  role: Rol;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface ListadoUsuarios {
  usuarios: Usuario[];
  roles: Array<{ rol: Rol; permisos: Permiso[] }>;
  permisos: Permiso[];
}

export const ETIQUETA_PERMISO: Record<Permiso, string> = {
  ventas: 'Ventas y reportes',
  carta: 'Carta y precios',
  stock: 'Stock',
  compras: 'Compras y proveedores',
  cocina: 'Comandas',
  bot: 'Chatbot',
  usuarios: 'Usuarios',
};

export const DESCRIPCION_ROL: Record<Rol, string> = {
  'dueño': 'Ve todo y da de alta gente.',
  encargado: 'Maneja el local entero menos los usuarios.',
  cocina: 'Solo el tablero de comandas.',
};
