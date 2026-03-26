#!/usr/bin/env python3
"""
自动生成金标准评估 - 基于投资者视角的规则引擎
用于泛化验证时快速生成 gold standard（替代人工逐条评估）

规则来源：训练集 60 条的人工评估经验
"""
import json
import re
import sys

def evaluate_tweet(tweet: dict) -> dict:
    """基于投资者视角规则引擎评估推文"""
    text = tweet.get('text', '')
    text_lower = text.lower()
    ci = tweet.get('currentInsight', {}) or {}
    ci_verdict = ci.get('verdict', 'ignore')
    ci_importance = ci.get('importance', 1)
    ci_domain = ci.get('domain')
    ci_tags = ci.get('tags', [])
    author = tweet.get('authorScreen', '')

    # 默认使用 currentInsight 作为基线
    verdict = ci_verdict
    importance = ci_importance
    reasoning = "Baseline from production classification"

    # === 升级规则 ===

    # 1. 地缘政治/能源重大事件 → 至少 watch/3
    geo_keywords = ['iran', 'hormuz', 'ceasefire', 'strike', 'military', 'war', 'sanctions',
                    '伊朗', '霍尔木兹', '停火', '军事', '战争', '制裁', '空袭', '轰炸',
                    'oil price', 'crude', 'brent', '油价', '原油', 'opec']
    if any(kw in text_lower for kw in geo_keywords):
        if importance < 3:
            importance = 3
            verdict = 'watch'
            reasoning = "Geopolitical/energy event upgrade: affects energy positions and market sentiment"
        # 重大升级：油价剧烈波动 / 军事行动 / 停火协议
        major_geo = ['oil prices down', 'oil prices up', 'oil surge', 'oil crash',
                     'brent', '油价', 'hormuz', '霍尔木兹', 'ceasefire', '停火',
                     'bombing', 'strike', '空袭', '轰炸', 'blockade']
        if any(kw in text_lower for kw in major_geo):
            if importance < 4:
                importance = 4
                verdict = 'actionable'
                reasoning = "Major geopolitical event: energy/commodity impact requires immediate position review"

    # 2. 安全事件 → actionable/5
    security_keywords = ['exploit', 'hack', 'vulnerability', 'breach', 'attack',
                        '攻击', '漏洞', '被盗', 'depeg', '脱锚', 'supply chain attack']
    if any(kw in text_lower for kw in security_keywords):
        # Check if it's about a real incident (not generic discussion)
        if any(x in text_lower for x in ['$', 'million', 'M ', 'protocol', 'usdc', 'usdt', 'usdr', 'usr']):
            importance = max(importance, 5)
            verdict = 'actionable'
            reasoning = "Security incident with specific amounts: immediate action needed"
        elif importance < 3:
            importance = 3
            verdict = 'watch'
            reasoning = "Security-related content worth monitoring"

    # 3. 重大监管/政策 → 至少 watch/3, 稳定币法案 → actionable/4+
    regulatory_keywords = ['clarity act', 'stablecoin bill', 'sec filing', 'ipo filing',
                          'bitcoin reserve', 'regulatory', 'legislation', 'senate',
                          '法案', '监管', '合规', '储备法案']
    if any(kw in text_lower for kw in regulatory_keywords):
        if importance < 3:
            importance = 3
            verdict = 'watch'
            reasoning = "Regulatory/policy event: affects market structure"
        # Stablecoin-specific
        if any(kw in text_lower for kw in ['stablecoin', 'usdc', 'circle', 'tether', '稳定币']):
            if importance < 4:
                importance = 4
                verdict = 'actionable'
                reasoning = "Stablecoin regulatory event: directly impacts crypto ecosystem"

    # 4. 顶级机构动态 → 至少 watch/4
    top_institutions = ['blackrock', 'grayscale', 'fidelity', 'jpmorgan', 'goldman',
                       'ark invest', 'bernstein', 'alliance bernstein', 'bridgewater',
                       'citadel', 'renaissance', 'berkshire', '贝莱德', '灰度',
                       'swift', 'visa', 'mastercard']
    if any(inst in text_lower for inst in top_institutions):
        # Only upgrade if there's actual news (not just mentioning the name)
        action_words = ['buy', 'sell', 'invest', 'launch', 'file', 'announce', 'confirms',
                       '买入', '卖出', '投资', '发布', '确认', 'target', 'forecast']
        if any(aw in text_lower for aw in action_words):
            if importance < 4:
                importance = 4
                verdict = 'watch'
                reasoning = "Top institution action: high-signal market indicator"

    # 5. 大额资金事件 → 至少 watch/4
    amount_patterns = [
        (r'\$\d+[BbMm]', 'dollar amount'),
        (r'\d+亿', 'chinese billion'),
        (r'\d+万亿', 'chinese trillion'),
        (r'billion', 'billion'),
        (r'\$\d{2,}M', 'millions'),
    ]
    for pattern, desc in amount_patterns:
        if re.search(pattern, text):
            # Check if it's a large amount (>$50M threshold)
            match = re.search(r'\$(\d+\.?\d*)\s*[Bb]', text)
            if match and float(match.group(1)) >= 0.05:  # $50M+
                if importance < 4:
                    importance = 4
                    verdict = 'watch'
                    reasoning = f"Large financial event (${match.group(1)}B+): institutional-grade signal"
                break

    # 6. Fed/央行利率 → actionable/5
    fed_keywords = ['fed funds', 'rate cut', 'rate hike', 'fomc', 'powell',
                   '降息', '加息', '美联储', 'interest rate', 'monetary policy']
    if any(kw in text_lower for kw in fed_keywords):
        # If it's about actual rate changes or major policy shifts
        if any(w in text_lower for w in ['breaking', 'just in', 'change', 'shift', 'swing', 'pivot']):
            importance = max(importance, 5)
            verdict = 'actionable'
            reasoning = "Fed/central bank policy shift: affects all asset classes"
        elif importance < 3:
            importance = 3
            verdict = 'watch'
            reasoning = "Central bank related: worth monitoring"

    # 7. AI 重要产品/模型发布 → 至少 watch/3
    ai_keywords = ['model release', 'benchmark', 'open source', 'cursor', 'claude',
                  'gpt-5', 'gemini', 'llama', 'composer', 'copilot', 'sora']
    if any(kw in text_lower for kw in ai_keywords):
        if ci_domain == 'ai' and importance < 3:
            importance = 3
            verdict = 'watch'
            reasoning = "AI product/model event: relevant for AI industry tracking"

    # 8. IPO 申请 → watch/4+
    if any(kw in text_lower for kw in ['ipo', 'ipo filing', 'ipo申请', 'public offering', 'adr', 'f-1']):
        if importance < 4:
            importance = 4
            verdict = 'watch'
            reasoning = "IPO/listing event: major market structure change"

    # 9. 金价/大宗商品剧烈波动 → actionable/5
    commodity_surge = ['gold surge', 'gold futures', 'gold above', 'gold at',
                      '黄金', 'crude oil', 'oil below', 'oil above']
    if any(kw in text_lower for kw in commodity_surge):
        pct_match = re.search(r'[\+\-]?\d+\.?\d*%', text)
        if pct_match:
            pct = float(pct_match.group().replace('%', '').replace('+', ''))
            if abs(pct) >= 3:
                importance = max(importance, 5)
                verdict = 'actionable'
                reasoning = f"Commodity price move {pct_match.group()}: requires immediate position review"

    # === 降级规则 ===

    # 10. 纯情绪/营销/个人帖 → ignore/1
    noise_patterns = ['drop it below', 'who\'s ready', 'gm', 'let\'s go',
                     '起飞了', '完蛋了', '加油', 'wen moon', 'wagmi',
                     'airdrop farming', 'mint 🔥', 'join us']
    if any(np in text_lower for np in noise_patterns):
        if len(text) < 100 and importance > 1:
            importance = 1
            verdict = 'ignore'
            reasoning = "Pure noise/marketing/sentiment: no investment value"

    # 11. 纯技术面画线（无催化） → max ignore/2
    ta_only = ['retest', 'support', 'resistance', 'consolidating', 'breakout',
              '支撑', '压力位', '画线', 'head and shoulders', '右肩']
    if any(ta in text_lower for ta in ta_only):
        has_catalyst = any(c in text_lower for c in ['earnings', 'fed', 'war', 'hack', 'ipo'])
        if not has_catalyst and importance > 2:
            importance = min(importance, 2)
            verdict = 'ignore'
            reasoning = "Pure technical analysis without catalyst: low investment value"

    # 12. 价格播报（无分析）→ max ignore/2
    if len(text) < 50 and any(kw in text_lower for kw in ['$', 'price', 'bought']):
        if not any(kw in text_lower for kw in ['breaking', 'just in', 'billion', 'million']):
            importance = min(importance, 2)
            verdict = 'ignore'
            reasoning = "Brief price mention without analysis"

    # 确保 importance 在 1-5 范围
    importance = max(1, min(5, importance))

    # 确保 verdict 与 importance 一致
    if importance >= 4 and verdict == 'ignore':
        verdict = 'watch'
    if verdict == 'actionable' and importance < 3:
        verdict = 'watch'

    return {
        'tweetId': tweet['tweetId'],
        'verdict': verdict,
        'importance': importance,
        'reasoning': reasoning,
    }


def main():
    input_file = sys.argv[1] if len(sys.argv) > 1 else 'scripts/prompt-opt/data/sample-validation.json'
    output_file = sys.argv[2] if len(sys.argv) > 2 else 'scripts/prompt-opt/data/gold-standard-validation.json'

    with open(input_file) as f:
        tweets = json.load(f)

    gold = [evaluate_tweet(t) for t in tweets]

    with open(output_file, 'w') as f:
        json.dump(gold, f, ensure_ascii=False, indent=2)

    # Stats
    verdicts = {}
    importances = {}
    for g in gold:
        verdicts[g['verdict']] = verdicts.get(g['verdict'], 0) + 1
        importances[g['importance']] = importances.get(g['importance'], 0) + 1

    print(f'Generated {len(gold)} gold standard evaluations')
    print(f'Verdicts: {dict(sorted(verdicts.items()))}')
    print(f'Importance: {dict(sorted(importances.items()))}')

    # Count upgrades/downgrades from baseline
    upgrades = sum(1 for t, g in zip(tweets, gold)
                   if (t.get('currentInsight', {}) or {}).get('importance', 1) < g['importance'])
    downgrades = sum(1 for t, g in zip(tweets, gold)
                    if (t.get('currentInsight', {}) or {}).get('importance', 1) > g['importance'])
    print(f'Upgrades from baseline: {upgrades}, Downgrades: {downgrades}')


if __name__ == '__main__':
    main()
