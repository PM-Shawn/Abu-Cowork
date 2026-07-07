[中文](DISCLAIMER.zh-CN.md) | **English**

# Disclaimer

> Abu is an open-source desktop application released by an individual developer
> under the Apache 2.0 License. By using this software, you agree to the terms below.

---

## 1. Status

This software is in **active development** and is provided "AS IS" without any warranty of any kind, express or implied. Breaking changes may occur between releases, and the developer makes no commitment regarding feature completeness or continued availability.

---

## 2. AI Output

Abu generates content by calling third-party large language models (LLMs):

- AI output is **for reference only** and does not constitute professional advice (legal, medical, financial, investment, etc.).
- Models may produce errors, hallucinations, or bias — **always verify critical outputs independently**.
- The developer is not liable for any consequences arising from reliance on AI output.

---

## 3. Local Operation Risks

Abu has the following capabilities — **review carefully before authorizing them**:

| Capability | Risk |
|---|---|
| File read/write | Can read / modify / delete local files — back up important data yourself |
| Command execution | Incorrect commands may cause data loss or damage system configuration |
| Computer & browser control | Can operate the system UI — do not authorize high-risk actions while unattended |
| Scheduled & automated tasks | Can run automatically in the background — you are fully responsible for every automation you configure |

**All consequences arising from the above operations are solely the user's responsibility.**

---

## 4. Third-Party Services & API Keys

- Abu provides **no LLM backend**. Your AI requests go directly to third-party providers (Anthropic, OpenAI-compatible endpoints, etc.) via **your own API key**.
- Data handling, privacy, and costs are governed by each provider's terms — please read and comply with the Terms of Service of the providers you use.
- The developer bears **no responsibility** for your API usage or the costs it incurs.

---

## 5. Privacy & Data

- **Local-first**: conversations, memory, and settings are stored **on your own device**, not on any Abu server.
- Content sent through IM integrations (Feishu / DingTalk / WeCom / Slack, etc.) is transmitted via the respective platform and subject to its own privacy policy.
- When exporting a diagnostic bundle, review and remove any sensitive information before sending it.

---

## 6. Acceptable Use

You agree not to use Abu for:

- Any activity that violates applicable laws or regulations
- Generating or spreading misinformation, fraudulent content, or harmful material
- Unauthorized access to other people's computer systems or data
- Infringing the privacy rights or intellectual property of others

---

## 7. Limitation of Liability

To the maximum extent permitted by applicable law, the developer is not liable for any loss of data, business, or profit, nor for any direct, indirect, or incidental damages arising from software defects, erroneous AI output, or automation failures.

This section supplements Sections 7 and 8 of the Apache 2.0 License, together forming the complete limitation of liability.

---

*Last updated: 2026-05-27*
*Abu · Apache 2.0 · https://github.com/PM-Shawn/Abu-Cowork*
