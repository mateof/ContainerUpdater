import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { CurrentUser } from '@cu/shared';
import { api, ApiError, onUnauthorized } from '@/api/client';
import { setLocale } from '@/i18n';

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  needsSetup: boolean;
  login: (
    username: string,
    password: string,
  ) => Promise<{ needsTotp: true; ticket: string } | { needsTotp: false }>;
  loginTotp: (
    ticket: string,
    code: string,
  ) => Promise<{ usedRecovery: boolean; recoveryCodesLeft: number }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (user: CurrentUser) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const status = await api.authStatus();
      setNeedsSetup(status.needsSetup);
      if (status.needsSetup) {
        setUser(null);
        return;
      }
      const { user: current } = await api.me();
      setUser(current);
      // El idioma del perfil manda sobre el del navegador: es una preferencia
      // explicita del usuario y ademas es el que usa el bot de Telegram.
      setLocale(current.locale);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setUser(null);
      else setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Un 401 en cualquier peticion significa sesion caducada: se limpia el estado
  // para que la app muestre el login sin esperar a la siguiente navegacion.
  useEffect(() => {
    onUnauthorized.handler = () => setUser(null);
    return () => {
      onUnauthorized.handler = null;
    };
  }, []);

  /**
   * Primer paso del login.
   *
   * Devuelve el ticket cuando falta el segundo factor, en vez de una sesion. La
   * pantalla decide entonces si entra o pide el codigo; el hook no lo hace por
   * su cuenta porque la sesion no existe todavia.
   */
  const login = useCallback(async (username: string, password: string) => {
    const result = await api.login(username, password);
    if ('needsTotp' in result) return { needsTotp: true as const, ticket: result.ticket };

    setUser(result.user);
    setLocale(result.user.locale);
    return { needsTotp: false as const };
  }, []);

  /** Segundo paso: aqui si llega la sesion. */
  const loginTotp = useCallback(async (ticket: string, code: string) => {
    const result = await api.loginTotp(ticket, code);
    setUser(result.user);
    setLocale(result.user.locale);
    return result;
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, needsSetup, login, loginTotp, logout, refresh, setUser }),
    [user, loading, needsSetup, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return context;
}
