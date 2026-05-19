export interface ProviderGuideInfo {
  hint: string;         // One-line hint
  url: string;          // Direct link to the API key management page
  urlLabel: string;     // Link button text
}

export const PROVIDER_GUIDES: Record<string, ProviderGuideInfo> = {
  anthropic: {
    hint: '在 Anthropic Console 创建 API Key',
    url: 'https://console.anthropic.com/settings/keys',
    urlLabel: 'Anthropic Console',
  },
  openai: {
    hint: '在 OpenAI Platform 创建 API Key',
    url: 'https://platform.openai.com/api-keys',
    urlLabel: 'OpenAI Platform',
  },
  deepseek: {
    hint: '在 DeepSeek 开放平台创建 API Key',
    url: 'https://platform.deepseek.com/api_keys',
    urlLabel: 'DeepSeek 开放平台',
  },
  moonshot: {
    hint: '在月之暗面开放平台创建 API Key',
    url: 'https://platform.moonshot.cn/console/api-keys',
    urlLabel: '月之暗面开放平台',
  },
  zhipu: {
    hint: '在智谱 AI 开放平台创建 API Key',
    url: 'https://open.bigmodel.cn/usercenter/apikeys',
    urlLabel: '智谱 AI 开放平台',
  },
  minimax: {
    hint: '在 MiniMax 开放平台获取接口密钥',
    url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    urlLabel: 'MiniMax 开放平台',
  },
  volcengine: {
    hint: '在火山引擎方舟平台获取 API Key',
    url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    urlLabel: '火山引擎方舟控制台',
  },
  bailian: {
    hint: '在阿里百炼控制台获取 API Key',
    url: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key',
    urlLabel: '阿里百炼控制台',
  },
  siliconflow: {
    hint: '在硅基流动控制台创建 API Key',
    url: 'https://cloud.siliconflow.cn/account/ak',
    urlLabel: '硅基流动控制台',
  },
  qiniu: {
    hint: '在七牛云控制台获取 AccessKey',
    url: 'https://portal.qiniu.com/developer/ak-sk',
    urlLabel: '七牛云控制台',
  },
  openrouter: {
    hint: '在 OpenRouter 创建 API Key',
    url: 'https://openrouter.ai/keys',
    urlLabel: 'OpenRouter',
  },
  ollama: {
    hint: '安装 Ollama 后，运行 ollama pull <模型名> 下载模型',
    url: 'https://ollama.com/download',
    urlLabel: 'Ollama 官网',
  },
  lmstudio: {
    hint: '下载并安装 LM Studio，在 Catalog 中下载模型，然后在 Developer 选项卡中启动本地服务',
    url: 'https://lmstudio.ai',
    urlLabel: 'LM Studio 官网',
  },
};
