import { validateConfig } from './settings.mjs';

export async function collectConfig(current, { ask, secret, log, openBrowser }) {
  const value = async (label, fallback) => (await ask(`${label} [${fallback}]：`)).trim() || fallback;
  const yes = async (label, fallback) => {
    for (;;) {
      const answer = (await value(label, fallback ? 'Y' : 'n')).toLowerCase();
      if (['y', 'yes', '是'].includes(answer)) return true;
      if (['n', 'no', '否'].includes(answer)) return false;
      log('请输入 y 或 n，也可按回车保留默认值。');
    }
  };
  log('配置保存在用户目录，按回车保留已有值；密钥输入不回显。');
  const config = { ...current, base_url: await value('Langfuse 基础地址', current.base_url) };
  validateConfig(config);
  if (!await yes('是否已有组织、项目和项目 API Keys', !!(current.public_key && current.secret_key))) {
    config.organization_name = await value('组织名称（创建时使用）', current.organization_name);
    config.project_name = await value('项目名称（创建时使用）', current.project_name);
    log(`请在 ${config.base_url} 登录或注册，然后：\n1. 创建组织“${config.organization_name}”（已有组织可直接使用）。\n2. 在组织中创建项目“${config.project_name}”。\n3. 在该项目 Settings → API Keys 中创建项目密钥。\n这里的名称用于引导创建；填入名称不会自动创建组织或项目。`);
    if (await yes('现在打开 Langfuse 页面', true)) await openBrowser(config.base_url);
    await ask('完成后按回车继续；也可按 Ctrl+C 退出，稍后重新配置。');
  }
  config.public_key = (await secret(`Project Public Key${current.public_key ? '（回车保留）' : ''}：`)).trim() || current.public_key;
  config.secret_key = (await secret(`Project Secret Key${current.secret_key ? '（回车保留）' : ''}：`)).trim() || current.secret_key;
  for (;;) {
    config.content = await value('正文模式：metadata 只传结构与用量；text 另传脱敏后的正文', current.content);
    if (['metadata', 'text'].includes(config.content)) break;
    log('请输入 metadata 或 text。');
  }
  config.enabled = await yes('启用采集与上报', current.public_key ? current.enabled : true);
  return validateConfig(config);
}
