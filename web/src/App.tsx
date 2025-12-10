import { useState } from 'react';
import { DashboardPage } from './pages/Dashboard';
import { SubscriptionsPage } from './pages/Subscriptions';
import { TweetsPage } from './pages/Tweets';
import './App.css';

function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'tweets' | 'subscriptions'>('dashboard');

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">自动信息雷达</p>
          <h1>Twitter 周报控制台</h1>
          <p className="hint">配置订阅、触发 AI 工作流、查看周报与推送状态。</p>
        </div>
        <nav className="nav-tabs">
          <button className={activeTab === 'dashboard' ? 'active' : ''} onClick={() => setActiveTab('dashboard')}>
            控制台
          </button>
          <button className={activeTab === 'tweets' ? 'active' : ''} onClick={() => setActiveTab('tweets')}>
            推文浏览
          </button>
          <button className={activeTab === 'subscriptions' ? 'active' : ''} onClick={() => setActiveTab('subscriptions')}>
            订阅管理
          </button>
        </nav>
      </header>

      {activeTab === 'dashboard' ? <DashboardPage /> : activeTab === 'tweets' ? <TweetsPage /> : <SubscriptionsPage />}
    </div>
  );
}

export default App;
