export interface ProviderGuideInfo {
  hint: string;         // One-line hint (zh-CN)
  hintEn: string;       // One-line hint (en-US)
  url: string;          // Direct link to the API key management page
  urlLabel: string;     // Link button text (zh-CN)
  urlLabelEn?: string;  // Link button text (en-US); falls back to urlLabel when absent (English brand names)
}

export const PROVIDER_GUIDES: Record<string, ProviderGuideInfo> = {
  anthropic: {
    hint: '在 Anthropic Console 创建 API Key',
    hintEn: 'Create an API key in the Anthropic Console',
    url: 'https://console.anthropic.com/settings/keys',
    urlLabel: 'Anthropic Console',
  },
  openai: {
    hint: '在 OpenAI Platform 创建 API Key',
    hintEn: 'Create an API key on the OpenAI Platform',
    url: 'https://platform.openai.com/api-keys',
    urlLabel: 'OpenAI Platform',
  },
  deepseek: {
    hint: '在 DeepSeek 开放平台创建 API Key',
    hintEn: 'Create an API key on the DeepSeek open platform',
    url: 'https://platform.deepseek.com/api_keys',
    urlLabel: 'DeepSeek 开放平台',
    urlLabelEn: 'DeepSeek Open Platform',
  },
  moonshot: {
    hint: '在月之暗面开放平台创建 API Key',
    hintEn: 'Create an API key on the Moonshot open platform',
    url: 'https://platform.moonshot.cn/console/api-keys',
    urlLabel: '月之暗面开放平台',
    urlLabelEn: 'Moonshot Open Platform',
  },
  zhipu: {
    hint: '在智谱 AI 开放平台创建 API Key',
    hintEn: 'Create an API key on the Zhipu AI open platform',
    url: 'https://open.bigmodel.cn/usercenter/apikeys',
    urlLabel: '智谱 AI 开放平台',
    urlLabelEn: 'Zhipu AI Open Platform',
  },
  minimax: {
    hint: '在 MiniMax 开放平台获取接口密钥',
    hintEn: 'Get an interface key on the MiniMax open platform',
    url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    urlLabel: 'MiniMax 开放平台',
    urlLabelEn: 'MiniMax Open Platform',
  },
  volcengine: {
    hint: '在火山引擎方舟平台获取 API Key',
    hintEn: 'Get an API key on the Volcengine Ark platform',
    url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    urlLabel: '火山引擎方舟控制台',
    urlLabelEn: 'Volcengine Ark Console',
  },
  bailian: {
    hint: '在阿里百炼控制台获取 API Key',
    hintEn: 'Get an API key in the Alibaba Bailian console',
    url: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key',
    urlLabel: '阿里百炼控制台',
    urlLabelEn: 'Alibaba Bailian Console',
  },
  siliconflow: {
    hint: '在硅基流动控制台创建 API Key',
    hintEn: 'Create an API key in the SiliconFlow console',
    url: 'https://cloud.siliconflow.cn/account/ak',
    urlLabel: '硅基流动控制台',
    urlLabelEn: 'SiliconFlow Console',
  },
  qiniu: {
    hint: '在七牛云控制台获取 AccessKey',
    hintEn: 'Get an AccessKey in the Qiniu Cloud console',
    url: 'https://portal.qiniu.com/developer/ak-sk',
    urlLabel: '七牛云控制台',
    urlLabelEn: 'Qiniu Cloud Console',
  },
  xiaomi: {
    hint: '在小米 MiMo 平台订阅后获取 API Key（格式：tp-xxxxx）',
    hintEn: 'Subscribe on the Xiaomi MiMo platform to get an API key (format: tp-xxxxx)',
    url: 'https://platform.xiaomimimo.com/subscription',
    urlLabel: '小米 MiMo 平台',
    urlLabelEn: 'Xiaomi MiMo Platform',
  },
  openrouter: {
    hint: '在 OpenRouter 创建 API Key',
    hintEn: 'Create an API key on OpenRouter',
    url: 'https://openrouter.ai/keys',
    urlLabel: 'OpenRouter',
  },
  ollama: {
    hint: '安装 Ollama 后，运行 ollama pull <模型名> 下载模型',
    hintEn: 'After installing Ollama, run `ollama pull <model>` to download a model',
    url: 'https://ollama.com/download',
    urlLabel: 'Ollama 官网',
    urlLabelEn: 'Ollama website',
  },
  lmstudio: {
    hint: '下载并安装 LM Studio，在 Catalog 中下载模型，然后在 Developer 选项卡中启动本地服务',
    hintEn: 'Download and install LM Studio, download a model from the Catalog, then start the local server in the Developer tab',
    url: 'https://lmstudio.ai',
    urlLabel: 'LM Studio 官网',
    urlLabelEn: 'LM Studio website',
  },
};
