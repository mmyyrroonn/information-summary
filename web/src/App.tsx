import { useState } from 'react';
import { DashboardPage } from './pages/Dashboard';
import { SubscriptionsPage } from './pages/Subscriptions';
import { TweetsPage } from './pages/Tweets';
import { DevJobsPage } from './pages/DevJobs';
import { AnalyticsPage } from './pages/Analytics';
import { RoutingAnalyticsPage } from './pages/RoutingAnalytics';
import { EmbeddingCachePage } from './pages/EmbeddingCache';
import './App.css';

type TabKey = 'dashboard' | 'tweets' | 'analytics' | 'routing-analytics' | 'subscriptions' | 'embedding-cache' | 'dev';

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">自动信息雷达</p>
          <h1>Twitter 日报控制台</h1>
          <p className="hint">配置订阅、触发 AI 工作流、查看日报与推送状态。</p>
        </div>
        <nav className="nav-tabs">
          <button className={activeTab === 'dashboard' ? 'active' : ''} onClick={() => setActiveTab('dashboard')}>
            日报浏览
          </button>
          <button className={activeTab === 'tweets' ? 'active' : ''} onClick={() => setActiveTab('tweets')}>
            推文浏览
          </button>
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
        </nav>
      </header>

      {activeTab === 'dashboard' && <DashboardPage />}
      {activeTab === 'tweets' && <TweetsPage />}
      {activeTab === 'analytics' && <AnalyticsPage />}
      {activeTab === 'routing-analytics' && <RoutingAnalyticsPage />}
      {activeTab === 'subscriptions' && <SubscriptionsPage />}
      {activeTab === 'embedding-cache' && <EmbeddingCachePage />}
      {activeTab === 'dev' && <DevJobsPage />}
    </div>
  );
}

export default App;
