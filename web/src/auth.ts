import { jwtDecode } from 'jwt-decode';

export interface AuthUser {
  userId: string;
  username: string;
  role: 'admin' | 'user';
}

export interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
}

const TOKEN_KEY = 'auth_token';

export function getStoredAuth(): AuthState {
  const token = localStorage.getItem(TOKEN_KEY);
  
  if (!token) {
    return { user: null, token: null, isAuthenticated: false };
  }

  try {
    const user = jwtDecode<AuthUser>(token);
    return { user, token, isAuthenticated: true };
  } catch {
    clearAuth();
    return { user: null, token: null, isAuthenticated: false };
  }
}

export function setAuth(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
