import { useState, FormEvent } from 'react';
import { setAuth, AuthUser } from '../auth';
import { getApiBaseUrl } from '../apiBase';

interface LoginResponse {
  token: string;
  user: {
    id: string;
    username: string;
    role: string;
  };
}

interface LoginPageProps {
  onLogin: (user: AuthUser) => void;
  onCancel?: () => void;
}

export function LoginPage({ onLogin, onCancel }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    
    try {
      const response = await fetch(`${getApiBaseUrl()}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Login failed');
      }
      
      const data: LoginResponse = await response.json();
      setAuth(data.token, {
        userId: data.user.id,
        username: data.user.username,
        role: data.user.role as 'admin' | 'user',
      });
      onLogin({
        userId: data.user.id,
        username: data.user.username,
        role: data.user.role as 'admin' | 'user',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form onSubmit={handleSubmit}>
        <h1>登录</h1>
        {error && <p className="error">{error}</p>}
        <input
          type="text"
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" disabled={loading}>
          {loading ? '登录中...' : '登录'}
        </button>
        {onCancel ? (
          <button type="button" className="ghost" onClick={onCancel}>
            返回浏览
          </button>
        ) : null}
      </form>
    </div>
  );
}
