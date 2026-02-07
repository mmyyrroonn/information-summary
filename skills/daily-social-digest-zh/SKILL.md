---
name: daily-social-digest-zh
description: Generate a Chinese, conversational, concise daily social post from the past 24h collection; summary-focused and allowed to be long-form.
metadata:
  short-description: Chinese daily digest post
---

# Daily Social Digest (ZH)

## Quick use
- Trigger when the user wants a daily tweet/日报-style post based on the last 24 hours of collected items.
- Default output: one Chinese post, conversational and concise, summary-focused; length is flexible and can be long.

## Required inputs (ask if missing)
- Source material for the last 24 hours (files, notes, links, or pasted text).
- Date range and timezone (default: last 24 hours in the user's timezone).
- Channel constraints (X/微博/公众号, etc.), if any.
- Topics to emphasize/avoid and whether to include links/hashtags.

## Workflow
1) Collect & filter
   - Read only last-24h items; ignore out-of-range.
   - Extract 3–7 key points with any numbers, names, and outcomes.
2) Synthesize
   - Group by theme (e.g., 产品/增长/市场/社群/运营) if it improves clarity.
   - Add 1–2 quick takeaways; no speculation, mark uncertainty if needed.
3) Draft post (Chinese, conversational)
   - Opening: 1–2 sentences setting the period.
   - Body: short paragraphs or bullets for highlights.
   - Close: 1 sentence takeaway or gentle CTA.
4) QA
   - Keep sentences short; remove jargon; keep tone friendly.
   - Include the explicit date range (e.g., 2026-02-01 to 2026-02-02).
   - Do not invent data; ask for missing info.

## Style rules
- 中文为主，口语化、精炼；允许长文但避免空话。
- 以“总结/日报”口吻，不用营销式话术。
- Emoji 可选 0–2 个；hashtags 仅在用户要求时添加。
- 数字优先用阿拉伯数字；专有名词保留原文。

## Output format
Return:

```
【昨日/最近24小时小结｜YYYY-MM-DD】
<主贴正文>
```

If the user asks for a short version, add:

```
【短版】
<60–120字>
```
