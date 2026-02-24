import { useState, useEffect } from 'react';
import { DashboardPage } from './pages/Dashboard';
import { SubscriptionsPage } from './pages/Subscriptions';
import { TweetsPage } from './pages/Tweets';
import { DevJobsPage } from './pages/DevJobs';
import { AnalyticsPage } from './pages/Analytics';
import { RoutingAnalyticsPage } from './pages/RoutingAnalytics';
import { EmbeddingCachePage } from './pages/EmbeddingCache';
import { LoginPage } from './pages/Login';
import { getStoredAuth, clearAuth, AuthUser } from './auth';
import './App.css';

type TabKey = 'dashboard' | 'tweets' | 'analytics' | 'routing-analytics' | 'subscriptions' | 'embedding-cache' | 'dev';

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    const auth = getStoredAuth();
    setUser(auth.user);
  }, []);

  function handleLogout() {
    clearAuth();
    setUser(null);
    setShowLogin(false);
    setActiveTab('dashboard');
  }

  function handleLogin(nextUser: AuthUser) {
    setUser(nextUser);
    setShowLogin(false);
  }

  if (showLogin) {
    return <LoginPage onLogin={handleLogin} onCancel={() => setShowLogin(false)} />;
  }

  const isAdmin = user?.role === 'admin';

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">自动信息雷达</p>
          <h1>Twitter 日报控制台</h1>
          <p className="hint">
            {user ? (
              <>
                登录为 {user.username} ({user.role})
                <button onClick={handleLogout} className="logout-btn">退出</button>
              </>
            ) : (
              <>
                游客模式（仅可浏览日报和推文）
                <button onClick={() => setShowLogin(true)} className="logout-btn">管理员登录</button>
              </>
            )}
          </p>
        </div>
        <nav className="nav-tabs">
          <button className={activeTab === 'dashboard' ? 'active' : ''} onClick={() => setActiveTab('dashboard')}>
            日报浏览
          </button>
          <button className={activeTab === 'tweets' ? 'active' : ''} onClick={() => setActiveTab('tweets')}>
            推文浏览
          </button>
          {isAdmin && (
            <>
              <button className={activeTab === 'analytics' ? 'active' : ''} onClick={() => setActiveTab('analytics')}>
                数据分析
              </button>
              <button
                className={activeTab === 'routing-analytics' ? 'active' : ''}
                onClick={() => setActiveTab('routing-analytics')}
              >
                分流分析
              </button>
              <button className={activeTab === 'subscriptions' ? 'active' : ''} onClick={() => setActiveTab('subscriptions')}>
                订阅管理
              </button>
              <button
                className={activeTab === 'embedding-cache' ? 'active' : ''}
                onClick={() => setActiveTab('embedding-cache')}
              >
                Embedding 缓存
              </button>
              <button className={activeTab === 'dev' ? 'active' : ''} onClick={() => setActiveTab('dev')}>
                DEV 工具
              </button>
            </>
          )}
        </nav>
      </header>

      {activeTab === 'dashboard' && <DashboardPage isAdmin={isAdmin} />}
      {activeTab === 'tweets' && <TweetsPage isAdmin={isAdmin} />}
      {isAdmin && activeTab === 'analytics' && <AnalyticsPage />}
      {isAdmin && activeTab === 'routing-analytics' && <RoutingAnalyticsPage />}
      {isAdmin && activeTab === 'subscriptions' && <SubscriptionsPage />}
      {isAdmin && activeTab === 'embedding-cache' && <EmbeddingCachePage />}
      {isAdmin && activeTab === 'dev' && <DevJobsPage />}
    </div>
  );
}

export default App;
